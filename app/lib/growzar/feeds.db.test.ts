/**
 * The Growzar read feeds against a real database: paging, tombstones and the purge marker.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { default: prisma } = await import("../../db.server");
const { purgeShopData } = await import("../shop-purge.server");
const { feedResponse, touchingUpdatedAt } = await import("./feed.server");

/** Run one write with the no-op guard lifted, so a test can set updatedAt directly. */
const touch = (write: Parameters<typeof touchingUpdatedAt>[1][number]) =>
  prisma.$transaction(touchingUpdatedAt(prisma, [write]));
const { sign, signingPayload } = await import("./signing.server");
const variants = await import("../../routes/api.v1.growzar.variants");
const stockLevels = await import("../../routes/api.v1.growzar.stock-levels");
const dailySales = await import("../../routes/api.v1.growzar.daily-sales");
const purchaseOrders = await import("../../routes/api.v1.growzar.purchase-orders");
const { deleteDraftPurchaseOrder } = await import("../purchase-order.server");
const suppliers = await import("../../routes/api.v1.growzar.suppliers");
const stockSnapshots = await import("../../routes/api.v1.growzar.stock-snapshots");
const { writeDailySnapshots } = await import("../stock-snapshot.server");
const returnRestocks = await import("../../routes/api.v1.growzar.return-restocks");

const SHOP = "feeds-test.myshopify.com";
const FACTS = { shop: SHOP, shopTimezone: "Asia/Karachi", shopCurrency: "PKR", shopCountry: "PK" };

process.env.GROWZAR_URL = "https://growzar.test";
process.env.GROWZAR_PLATFORM_KEY = "pk";
process.env.GROWZAR_SIGNING_SECRET = "secret";

beforeEach(async () => {
  await purgeShopData(SHOP);
  await prisma.growzarTombstone.deleteMany({ where: { shop: SHOP } });
  await prisma.session.create({
    data: { id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: "token" },
  });
  await prisma.shopSettings.create({
    data: { shop: SHOP, shopCurrency: "PKR", shopTimezone: "Asia/Karachi", shopCountry: "PK" },
  });
});

type Loader = (args: LoaderFunctionArgs) => Promise<Response> | Response;

/** A signed Growzar GET for `path` (which carries its own query), answered by `loader`. */
async function get(loader: Loader, path: string) {
  const timestamp = Date.now();
  const headers = new Headers({
    Authorization: "Bearer pk",
    "X-Growzar-Shop": SHOP,
    "X-Growzar-Timestamp": String(timestamp),
    "X-Growzar-Signature": sign("secret", signingPayload({ timestamp, method: "GET", pathWithQuery: path, body: "" })),
  });
  const response = await loader({ request: new Request(`http://localhost${path}`, { headers }), params: {}, context: {} });
  return { status: response.status, body: await response.json() };
}

/** Every page of a feed, following nextCursor. */
async function walk(loader: Loader, base: string, query: string) {
  const rows: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const path = `${base}?${query}${cursor ? `&cursor=${cursor}` : ""}`;
    const { status, body } = await get(loader, path);
    expect(status).toBe(200);
    rows.push(...body.data);
    if (!body.pagination.hasMore) return rows;
    cursor = body.pagination.nextCursor;
  }
  throw new Error("feed never finished paging");
}

// Ids far from the ones other suites use: they share this database.
const vid = (n: number) => String(880_000 + n);
const variantGid = (n: number) => `gid://shopify/ProductVariant/${vid(n)}`;

async function product(n: number, extra: Record<string, unknown> = {}) {
  return prisma.product.create({
    data: {
      id: variantGid(n),
      shop: SHOP,
      productGid: `gid://shopify/Product/${vid(n)}0`,
      title: `Item ${n}`,
      ...extra,
    },
  });
}

describe("purge marker", () => {
  it("a keep-session purge leaves one marker, and the feeds report shopPurged", async () => {
    await prisma.growzarTombstone.create({ data: { shop: SHOP, feed: "purchase-orders", entityId: "po1" } });
    const before = new Date(Date.now() - 1000);

    await purgeShopData(SHOP, { keepSession: true });

    const left = await prisma.growzarTombstone.findMany({ where: { shop: SHOP } });
    expect(left.map((t) => [t.feed, t.entityId])).toEqual([["shop", "purge"]]);

    const params = { updatedSince: before, limit: 10, cursor: null };
    const body = await (await feedResponse({ facts: FACTS, params }, [], (r) => r)).json();
    expect(body.shopPurged).toBe(true);

    const later = { updatedSince: new Date(Date.now() + 60_000), limit: 10, cursor: null };
    const after = await (await feedResponse({ facts: FACTS, params: later }, [], (r) => r)).json();
    expect(after.shopPurged).toBe(false);
  });

  it("a full purge leaves no tombstones behind", async () => {
    await prisma.growzarTombstone.create({ data: { shop: SHOP, feed: "purchase-orders", entityId: "po1" } });
    await purgeShopData(SHOP);
    expect(await prisma.growzarTombstone.count({ where: { shop: SHOP } })).toBe(0);
  });
});

describe("tombstones", () => {
  it("lists them on the first page of an incremental sync, under the feed's key", async () => {
    const since = new Date(Date.now() - 1000);
    await prisma.growzarTombstone.createMany({
      data: [
        { shop: SHOP, feed: "purchase-orders", entityId: "po1" },
        { shop: SHOP, feed: "suppliers", entityId: "s1" },
      ],
    });
    const tomb = { feed: "purchase-orders", key: "deletedPurchaseOrderIds" };

    const first = await (await feedResponse({ facts: FACTS, params: { updatedSince: since, limit: 10, cursor: null } }, [], (r) => r, tomb)).json();
    expect(first.deletedPurchaseOrderIds).toEqual(["po1"]);
    expect(first.deletedPurchaseOrderIdsTruncated).toBe(false);

    const full = await (await feedResponse({ facts: FACTS, params: { updatedSince: null, limit: 10, cursor: null } }, [], (r) => r, tomb)).json();
    expect(full.deletedPurchaseOrderIds).toEqual([]);
  });
});

describe("GET /growzar/variants", () => {
  it("pages a cluster of rows sharing one updatedAt with limit=2, each row exactly once", async () => {
    for (let n = 1; n <= 5; n++) await product(n);
    const same = new Date("2026-10-01T10:00:00.000Z");
    await touch(prisma.$executeRaw`UPDATE "Product" SET "updatedAt" = ${same} WHERE shop = ${SHOP}`);

    const rows = await walk(variants.loader, "/api/v1/growzar/variants", "limit=2&updatedSince=2026-10-01T10:00:00Z");
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2, 3, 4, 5].map(vid));
  });

  it("returns the envelope with shopCountry, numeric ids and no GID anywhere", async () => {
    await product(7, { unitCost: 1250.5, sku: "SKU-7", firstSoldAt: new Date("2026-09-02T00:00:00.000Z") });
    await product(8);
    const { status, body } = await get(variants.loader, "/api/v1/growzar/variants");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      shop: SHOP,
      shopTimezone: "Asia/Karachi",
      shopCurrency: "PKR",
      shopCountry: "PK",
      shopPurged: false,
      deletedVariantIds: [],
      deletedVariantIdsTruncated: false,
    });
    expect(JSON.stringify(body)).not.toContain("gid://");
    const byId = Object.fromEntries(body.data.map((r: { id: string }) => [r.id, r]));
    expect(byId[vid(7)]).toMatchObject({
      variantId: vid(7),
      productId: `${vid(7)}0`,
      unitCost: { amount: "1250.50", currency: "PKR" },
      firstSoldDate: "2026-09-02",
    });
    expect(byId[vid(8)].unitCost).toBeNull();
    expect(byId[vid(8)]).not.toHaveProperty("courierRtoRate");
  });

  it("returns money as null while the shop's currency is unknown", async () => {
    await prisma.shopSettings.update({ where: { shop: SHOP }, data: { shopCurrency: null } });
    await product(9, { unitCost: 10 });
    const { body } = await get(variants.loader, "/api/v1/growzar/variants");
    expect(body.shopCurrency).toBeNull();
    expect(body.data[0].unitCost).toBeNull();
    expect(JSON.stringify(body)).not.toContain("USD");
  });

  it("an update that changes nothing does not move updatedAt; a real change does", async () => {
    await product(11, { currentStock: 5 });
    const old = new Date("2026-10-01T00:00:00.000Z");
    await touch(prisma.$executeRaw`UPDATE "Product" SET "updatedAt" = ${old} WHERE id = ${variantGid(11)}`);

    await prisma.product.update({ where: { id: variantGid(11) }, data: { currentStock: 5 } });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: variantGid(11) } })).updatedAt).toEqual(old);

    await prisma.product.update({ where: { id: variantGid(11) }, data: { currentStock: 6 } });
    expect((await prisma.product.findUniqueOrThrow({ where: { id: variantGid(11) } })).updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("answers 410 for a shop without an install", async () => {
    await prisma.session.deleteMany({ where: { shop: SHOP } });
    const { status, body } = await get(variants.loader, "/api/v1/growzar/variants");
    expect(status).toBe(410);
    expect(body.errorType).toBe("shop_not_connected");
  });
});

describe("GET /growzar/stock-levels", () => {
  it("returns numeric ids, the location's name and state, and available = onHand - reserved", async () => {
    await product(21);
    const location = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/880077", name: "Karachi WH", isActive: false },
    });
    await prisma.productLocationStock.create({
      data: { shop: SHOP, productId: variantGid(21), locationId: location.id, onHand: 10, reserved: 3, damaged: 2 },
    });

    const { status, body } = await get(stockLevels.loader, "/api/v1/growzar/stock-levels");
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        id: `${vid(21)}:880077`,
        variantId: vid(21),
        locationId: "880077",
        locationName: "Karachi WH",
        locationActive: false,
        onHand: 10,
        reserved: 3,
        damaged: 2,
        available: 7,
        updatedAt: expect.stringMatching(/Z$/),
      },
    ]);
    expect(body).toMatchObject({ shopCountry: "PK", deletedStockLevelIds: [], deletedStockLevelIdsTruncated: false });
    expect(JSON.stringify(body)).not.toContain("gid://");
  });
});

describe("GET /growzar/daily-sales", () => {
  it("labels each row with its shop-local day and keeps zero days", async () => {
    await product(31);
    await prisma.salesRecord.createMany({
      data: [
        { shop: SHOP, productId: variantGid(31), date: new Date("2026-10-05T00:00:00.000Z"), quantity: 4 },
        { shop: SHOP, productId: variantGid(31), date: new Date("2026-10-06T00:00:00.000Z"), quantity: 0 },
      ],
    });

    const { status, body } = await get(dailySales.loader, "/api/v1/growzar/daily-sales");
    expect(status).toBe(200);
    const rows = body.data.map((r: Record<string, unknown>) => [r.id, r.variantId, r.date, r.units]);
    expect(rows.sort()).toEqual([
      [`${vid(31)}:2026-10-05`, vid(31), "2026-10-05", 4],
      [`${vid(31)}:2026-10-06`, vid(31), "2026-10-06", 0],
    ]);
    expect(body).toMatchObject({ shopTimezone: "Asia/Karachi", shopCountry: "PK", shopPurged: false });
    expect(JSON.stringify(body)).not.toContain("gid://");
  });
});

describe("GET /growzar/purchase-orders", () => {
  const OLD = new Date("2026-09-01T00:00:00.000Z");
  const agePo = (id: string) =>
    prisma.$transaction(touchingUpdatedAt(prisma, [prisma.purchaseOrder.update({ where: { id }, data: { updatedAt: OLD } })]));
  const poUpdatedAt = async (id: string) => (await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).updatedAt;

  async function purchaseOrder() {
    await product(41);
    const supplier = await prisma.supplier.create({ data: { shop: SHOP, name: "Faisal Textiles" } });
    return prisma.purchaseOrder.create({
      data: {
        shop: SHOP,
        poNumber: `PO-G5-${Date.now()}`,
        status: "sent",
        supplierId: supplier.id,
        totalCost: 1000,
        expectedDeliveryDate: new Date("2026-10-20T00:00:00.000Z"),
        items: { create: [{ productId: variantGid(41), quantityOrdered: 10, quantityReceived: 3, quantityCancelled: 2, unitCost: 100 }] },
      },
      include: { items: true, supplier: true },
    });
  }

  it("editing a PO item moves the PO's updatedAt; a no-op edit does not", async () => {
    const po = await purchaseOrder();
    await agePo(po.id);

    await prisma.purchaseOrderItem.update({ where: { id: po.items[0].id }, data: { quantityReceived: 3 } });
    expect(await poUpdatedAt(po.id)).toEqual(OLD);

    await prisma.purchaseOrderItem.update({ where: { id: po.items[0].id }, data: { quantityReceived: 5 } });
    expect((await poUpdatedAt(po.id)).getTime()).toBeGreaterThan(OLD.getTime());
  });

  it("adding or removing a line, or renaming the supplier, moves the PO's updatedAt", async () => {
    const po = await purchaseOrder();

    await agePo(po.id);
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: po.id } });
    expect((await poUpdatedAt(po.id)).getTime()).toBeGreaterThan(OLD.getTime());

    await agePo(po.id);
    await prisma.purchaseOrderItem.create({ data: { purchaseOrderId: po.id, productId: variantGid(41), quantityOrdered: 1 } });
    expect((await poUpdatedAt(po.id)).getTime()).toBeGreaterThan(OLD.getTime());

    await agePo(po.id);
    await prisma.supplier.update({ where: { id: po.supplierId! }, data: { notes: "unrelated" } });
    expect(await poUpdatedAt(po.id)).toEqual(OLD);
    await prisma.supplier.update({ where: { id: po.supplierId! }, data: { name: "Faisal Textiles Ltd" } });
    expect((await poUpdatedAt(po.id)).getTime()).toBeGreaterThan(OLD.getTime());
  });

  it("the touch does not leak: a later no-op write in the same transaction keeps its updatedAt", async () => {
    const po = await purchaseOrder();
    const other = await prisma.purchaseOrder.create({ data: { shop: SHOP, poNumber: `PO-G5-other-${Date.now()}` } });
    await agePo(other.id);
    await prisma.$transaction([
      prisma.purchaseOrderItem.update({ where: { id: po.items[0].id }, data: { quantityReceived: 6 } }),
      prisma.purchaseOrder.update({ where: { id: other.id }, data: { status: "draft" } }),
    ]);
    expect(await poUpdatedAt(other.id)).toEqual(OLD);
  });

  it("deleting a draft lists it in deletedPurchaseOrderIds; a sent PO cannot be deleted", async () => {
    const since = new Date(Date.now() - 1000);
    const sent = await purchaseOrder();
    const draft = await prisma.purchaseOrder.create({ data: { shop: SHOP, poNumber: `PO-G5-draft-${Date.now()}` } });

    expect(await deleteDraftPurchaseOrder(SHOP, sent.id)).toBe(false);
    expect(await deleteDraftPurchaseOrder(SHOP, draft.id)).toBe(true);

    const { body } = await get(purchaseOrders.loader, `/api/v1/growzar/purchase-orders?updatedSince=${since.toISOString()}`);
    expect(body.deletedPurchaseOrderIds).toEqual([draft.id]);
    expect(body.data.map((po: { id: string }) => po.id)).toEqual([sent.id]);
  });

  it("returns lines nested with onOrder and money, and dates as the contract says", async () => {
    const po = await purchaseOrder();
    const { status, body } = await get(purchaseOrders.loader, "/api/v1/growzar/purchase-orders");
    expect(status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: po.id,
      status: "sent",
      supplierId: po.supplierId,
      supplierName: "Faisal Textiles",
      expectedDeliveryDate: "2026-10-20",
      actualDeliveryDate: null,
      totalCost: { amount: "1000.00", currency: "PKR" },
      items: [
        {
          variantId: vid(41),
          quantityOrdered: 10,
          quantityReceived: 3,
          quantityCancelled: 2,
          onOrder: 5,
          unitCost: { amount: "100.00", currency: "PKR" },
        },
      ],
    });
    expect(body).toMatchObject({ deletedPurchaseOrderIds: [], deletedPurchaseOrderIdsTruncated: false });
    expect(JSON.stringify(body)).not.toContain("gid://");
  });
});

describe("GET /growzar/suppliers", () => {
  it("returns lead time as set and as measured, and no contact details", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        shop: SHOP,
        name: "Faisal Textiles",
        contactName: "Contact Person",
        email: "supplier@example.test",
        phone: "+920000000000",
        address: "Somewhere",
        leadTimeDays: 9,
        avgActualLeadTime: 11.5,
        leadTimeVariance: 2.25,
        totalPosReceived: 4,
        minOrderValue: 0,
      },
    });

    const { status, body } = await get(suppliers.loader, "/api/v1/growzar/suppliers");
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        id: supplier.id,
        name: "Faisal Textiles",
        leadTimeDays: 9,
        avgActualLeadTime: 11.5,
        leadTimeSigma: 2.25,
        totalPosReceived: 4,
        minOrderValue: { amount: "0.00", currency: "PKR" },
        isActive: true,
        updatedAt: expect.stringMatching(/Z$/),
      },
    ]);
    const text = JSON.stringify(body);
    for (const secret of ["Contact Person", "supplier@example.test", "+920000000000", "Somewhere"]) {
      expect(text).not.toContain(secret);
    }
    expect(body).toMatchObject({ deletedSupplierIds: [], deletedSupplierIdsTruncated: false });
  });
});

describe("daily stock snapshot job", () => {
  beforeEach(async () => {
    await prisma.shopSettings.update({ where: { shop: SHOP }, data: { timezone: "Asia/Karachi" } });
  });

  it("writes one row per live variant per shop-local day, and a second run that day writes 0", async () => {
    await product(51, { currentStock: 7 });
    await product(52, { currentStock: 0 });
    await product(53, { currentStock: 4, isArchived: true });

    // 20:30 UTC on 5 Oct is 01:30 on 6 Oct in Karachi.
    const first = await writeDailySnapshots(SHOP, new Date("2026-10-05T20:30:00.000Z"));
    expect(first).toEqual({ date: "2026-10-06", written: 2, variants: 2 });

    const again = await writeDailySnapshots(SHOP, new Date("2026-10-06T10:00:00.000Z"));
    expect(again).toEqual({ date: "2026-10-06", written: 0, variants: 2 });

    const rows = await prisma.stockSnapshot.findMany({ where: { shop: SHOP }, orderBy: { productId: "asc" } });
    expect(rows.map((r) => [r.productId, r.date.toISOString().slice(0, 10), r.stock])).toEqual([
      [variantGid(51), "2026-10-06", 7],
      [variantGid(52), "2026-10-06", 0],
    ]);
    expect(rows[0].observedAt.toISOString()).toBe("2026-10-05T20:30:00.000Z");

    const nextDay = await writeDailySnapshots(SHOP, new Date("2026-10-06T19:05:00.000Z"));
    expect(nextDay).toMatchObject({ date: "2026-10-07", written: 2 });
  });

  it("the feed labels every row by the shop-local day it was observed, old UTC-day rows included", async () => {
    await product(54);
    // An old product-sync row: UTC day 5 Oct, read at 00:15 UTC = 05:15 in Karachi.
    await prisma.stockSnapshot.create({
      data: {
        shop: SHOP,
        productId: variantGid(54),
        date: new Date("2026-10-05T00:00:00.000Z"),
        stock: 3,
        observedAt: new Date("2026-10-05T00:15:00.000Z"),
      },
    });
    await writeDailySnapshots(SHOP, new Date("2026-10-05T19:30:00.000Z"));

    const { status, body } = await get(stockSnapshots.loader, "/api/v1/growzar/stock-snapshots");
    expect(status).toBe(200);
    const rows = body.data.map((r: Record<string, unknown>) => [r.variantId, r.date, r.stock, r.observedAt]);
    expect(rows.sort()).toEqual([
      [vid(54), "2026-10-05", 3, "2026-10-05T00:15:00.000Z"],
      [vid(54), "2026-10-06", 0, "2026-10-05T19:30:00.000Z"],
    ]);
    expect(JSON.stringify(body)).not.toContain("gid://");
  });
});

describe("GET /growzar/return-restocks", () => {
  it("returns only what Inventorify owns, with Shopify ids for the variant and location", async () => {
    await product(61);
    const location = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/880061", name: "Karachi WH" },
    });
    const resolvedAt = new Date("2026-10-04T08:00:00.000Z");
    await prisma.returnItem.createMany({
      data: [
        {
          shop: SHOP, shipmentId: "shp_1", lineItemId: "li_1", shopifyVariantId: vid(61), productId: variantGid(61),
          quantity: 2, status: "restocked", locationId: location.id, resolvedAt,
          city: "Made-up City", courier: "made-up-courier", reasonCategory: "refused",
        },
        { shop: SHOP, shipmentId: "shp_2", lineItemId: "li_2", quantity: 1 },
      ],
    });

    const { status, body } = await get(returnRestocks.loader, "/api/v1/growzar/return-restocks");
    expect(status).toBe(200);
    const byLine = Object.fromEntries(body.data.map((r: { lineItemId: string }) => [r.lineItemId, r]));
    expect(byLine.li_1).toEqual({
      id: expect.any(String),
      shipmentId: "shp_1",
      lineItemId: "li_1",
      variantId: vid(61),
      quantity: 2,
      status: "restocked",
      resolvedAt: "2026-10-04T08:00:00.000Z",
      locationId: "880061",
      updatedAt: expect.stringMatching(/Z$/),
    });
    expect(byLine.li_2).toMatchObject({ variantId: null, status: "pending", resolvedAt: null, locationId: null });
    const text = JSON.stringify(body);
    for (const theirs of ["Made-up City", "made-up-courier", "refused", "gid://"]) expect(text).not.toContain(theirs);
  });
});
