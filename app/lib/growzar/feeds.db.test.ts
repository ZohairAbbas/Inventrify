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
