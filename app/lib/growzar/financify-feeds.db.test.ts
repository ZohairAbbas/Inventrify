/**
 * The Financify Books feeds against a real database: partner isolation, the receipts and
 * supplier-ledger feeds, createdAt paging and the settle window.
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
const { sign, signingPayload } = await import("./signing.server");
const { SETTLE_MS } = await import("./feed.server");
const receipts = await import("../../routes/api.v1.financify.receipts");
const ledger = await import("../../routes/api.v1.financify.supplier-ledger");
const financifyVariants = await import("../../routes/api.v1.financify.variants");
const growzarVariants = await import("../../routes/api.v1.growzar.variants");

const SHOP = "financify-feeds-test.myshopify.com";

process.env.GROWZAR_URL = "https://growzar.test";
process.env.GROWZAR_PLATFORM_KEY = "growzar-pk";
process.env.GROWZAR_SIGNING_SECRET = "growzar-secret";
process.env.FINANCIFY_PLATFORM_KEY = "financify-pk";
process.env.FINANCIFY_SIGNING_SECRET = "financify-secret";

const FINANCIFY = { key: "financify-pk", secret: "financify-secret", prefix: "Financify" };
const GROWZAR = { key: "growzar-pk", secret: "growzar-secret", prefix: "Growzar" };

beforeEach(async () => {
  await purgeShopData(SHOP);
  await prisma.session.create({
    data: { id: `offline_${SHOP}`, shop: SHOP, state: "", isOnline: false, accessToken: "token" },
  });
  await prisma.shopSettings.create({
    data: { shop: SHOP, shopCurrency: "PKR", shopTimezone: "Asia/Karachi", shopCountry: "PK" },
  });
});

type Loader = (args: LoaderFunctionArgs) => Promise<Response> | Response;

async function get(loader: Loader, path: string, as = FINANCIFY) {
  const timestamp = Date.now();
  const headers = new Headers({
    Authorization: `Bearer ${as.key}`,
    [`X-${as.prefix}-Shop`]: SHOP,
    [`X-${as.prefix}-Timestamp`]: String(timestamp),
    [`X-${as.prefix}-Signature`]: sign(as.secret, signingPayload({ timestamp, method: "GET", pathWithQuery: path, body: "" })),
  });
  const response = await loader({ request: new Request(`http://localhost${path}`, { headers }), params: {}, context: {} });
  return { status: response.status, body: await response.json() };
}

const vid = (n: number) => String(890_000 + n);
const variantGid = (n: number) => `gid://shopify/ProductVariant/${vid(n)}`;
/** Old enough to be past the settle window. */
const settled = (secondsAgo = 0) => new Date(Date.now() - SETTLE_MS - 5_000 - secondsAgo * 1000);

async function receivedPo() {
  const supplier = await prisma.supplier.create({ data: { shop: SHOP, name: "Acme Textiles" } });
  await prisma.product.create({
    data: {
      id: variantGid(1),
      shop: SHOP,
      productGid: `gid://shopify/Product/${vid(1)}0`,
      inventoryItemId: `gid://shopify/InventoryItem/${vid(1)}9`,
      title: "Shirt",
    },
  });
  const location = await prisma.location.create({
    data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/777", name: "Main" },
  });
  const po = await prisma.purchaseOrder.create({
    data: {
      shop: SHOP,
      poNumber: `PO-FIN-${Date.now()}`,
      status: "received",
      supplierId: supplier.id,
      items: { create: [{ productId: variantGid(1), quantityOrdered: 10, quantityReceived: 10, unitCost: 250 }] },
    },
    include: { items: true },
  });
  const receipt = await prisma.purchaseOrderReceipt.create({
    data: {
      shop: SHOP,
      purchaseOrderId: po.id,
      // A day the merchant picked: stored at 00:00 UTC.
      receivedAt: new Date("2026-10-10T00:00:00.000Z"),
      locationId: location.id,
      createdAt: settled(),
      lines: { create: [{ purchaseOrderItemId: po.items[0].id, quantity: 10, quantityDamaged: 2 }] },
    },
  });
  const bill = await prisma.supplierLedgerEntry.create({
    data: {
      shop: SHOP,
      supplierId: supplier.id,
      type: "bill",
      amount: "2500.00",
      currency: "PKR",
      occurredAt: receipt.receivedAt,
      sourceKey: `receipt:${receipt.id}`,
      purchaseOrderId: po.id,
      receiptId: receipt.id,
      createdAt: settled(),
    },
  });
  return { supplier, po, receipt, bill };
}

describe("partner isolation", () => {
  it("a Financify route refuses the Growzar key, and a Growzar route the Financify key", async () => {
    expect((await get(receipts.loader, "/api/v1/financify/receipts", GROWZAR)).status).toBe(401);
    expect((await get(growzarVariants.loader, "/api/v1/growzar/variants", FINANCIFY)).status).toBe(401);
  });

  it("each partner reads the shared variants feed under its own prefix", async () => {
    expect((await get(financifyVariants.loader, "/api/v1/financify/variants")).status).toBe(200);
    expect((await get(growzarVariants.loader, "/api/v1/growzar/variants", GROWZAR)).status).toBe(200);
  });

  it("variants carry the numeric inventoryItemId", async () => {
    await receivedPo();
    const { body } = await get(financifyVariants.loader, "/api/v1/financify/variants");
    expect(body.data[0]).toMatchObject({ variantId: vid(1), inventoryItemId: `${vid(1)}9` });
  });

  it("answers 503 when Financify's credentials are not set", async () => {
    const saved = process.env.FINANCIFY_SIGNING_SECRET;
    delete process.env.FINANCIFY_SIGNING_SECRET;
    try {
      expect((await get(receipts.loader, "/api/v1/financify/receipts")).status).toBe(503);
    } finally {
      process.env.FINANCIFY_SIGNING_SECRET = saved;
    }
  });
});

describe("GET /financify/receipts", () => {
  it("returns a delivery with its lines, Shopify ids and the bill it posted", async () => {
    const { supplier, po, receipt, bill } = await receivedPo();
    const { status, body } = await get(receipts.loader, "/api/v1/financify/receipts");
    expect(status).toBe(200);
    expect(body.data).toEqual([
      {
        id: receipt.id,
        poId: po.id,
        poNumber: po.poNumber,
        supplierId: supplier.id,
        locationId: "777",
        receivedAt: "2026-10-10T00:00:00.000Z",
        receivedOn: "2026-10-10",
        lines: [
          {
            variantId: vid(1),
            inventoryItemId: `${vid(1)}9`,
            quantity: 10,
            quantityDamaged: 2,
            unitCost: { amount: "250.00", currency: "PKR" },
          },
        ],
        billLedgerEntryId: bill.id,
        currency: "PKR",
        createdAt: receipt.createdAt.toISOString(),
      },
    ]);
  });

  it("holds back a receipt younger than the settle window", async () => {
    const { po } = await receivedPo();
    await prisma.purchaseOrderReceipt.create({
      data: { shop: SHOP, purchaseOrderId: po.id, receivedAt: new Date() },
    });
    const { body } = await get(receipts.loader, "/api/v1/financify/receipts");
    expect(body.data).toHaveLength(1);
  });

  it("places a recorded instant on the shop's day", async () => {
    const { po } = await receivedPo();
    await prisma.purchaseOrderReceipt.deleteMany({ where: { purchaseOrderId: po.id } });
    // 21:30 UTC on the 10th is 02:30 on the 11th in Karachi.
    await prisma.purchaseOrderReceipt.create({
      data: { shop: SHOP, purchaseOrderId: po.id, receivedAt: new Date("2026-10-10T21:30:00.000Z"), createdAt: settled() },
    });
    const { body } = await get(receipts.loader, "/api/v1/financify/receipts");
    expect(body.data[0].receivedOn).toBe("2026-10-11");
    expect(body.data[0].billLedgerEntryId).toBeNull();
  });
});

describe("GET /financify/supplier-ledger", () => {
  it("pages entries sharing one createdAt with limit=1, each exactly once, signed as stored", async () => {
    const { supplier, bill } = await receivedPo();
    const payment = await prisma.supplierLedgerEntry.create({
      data: {
        shop: SHOP,
        supplierId: supplier.id,
        type: "payment",
        amount: "-1000.50",
        currency: "PKR",
        occurredAt: new Date("2026-10-12T00:00:00.000Z"),
        reference: "HBL-123",
        createdAt: bill.createdAt,
      },
    });

    const seen: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const path = `/api/v1/financify/supplier-ledger?limit=1${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await get(ledger.loader, path);
      seen.push(...body.data);
      if (!body.pagination.hasMore) break;
      cursor = body.pagination.nextCursor;
    }

    expect(seen.map((e) => e.id).sort()).toEqual([bill.id, payment.id].sort());
    expect(seen.find((e) => e.id === payment.id)).toMatchObject({
      kind: "payment",
      amount: { amount: "-1000.50", currency: "PKR" },
      date: "2026-10-12",
      reference: "HBL-123",
      sourceKey: null,
    });
    expect(seen.find((e) => e.id === bill.id)).toMatchObject({ kind: "bill", amount: { amount: "2500.00" } });
  });

  it("filters on createdAt with updatedSince", async () => {
    const { supplier, bill } = await receivedPo();
    await prisma.supplierLedgerEntry.update({ where: { id: bill.id }, data: { createdAt: settled(100) } });
    await prisma.supplierLedgerEntry.create({
      data: { shop: SHOP, supplierId: supplier.id, type: "adjustment", amount: "50", currency: "PKR", occurredAt: new Date(), createdAt: settled() },
    });
    const since = settled(50).toISOString();
    const { body } = await get(ledger.loader, `/api/v1/financify/supplier-ledger?updatedSince=${since}`);
    expect(body.data.map((e: { kind: string }) => e.kind)).toEqual(["adjustment"]);
  });
});
