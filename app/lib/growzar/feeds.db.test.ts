/**
 * The Growzar read feeds against a real database: paging, tombstones and the purge marker.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { default: prisma } = await import("../../db.server");
const { purgeShopData } = await import("../shop-purge.server");
const { feedResponse } = await import("./feed.server");

const SHOP = "feeds-test.myshopify.com";
const FACTS = { shop: SHOP, shopTimezone: "Asia/Karachi", shopCurrency: "PKR", shopCountry: "PK" };

beforeEach(async () => {
  await purgeShopData(SHOP);
  await prisma.growzarTombstone.deleteMany({ where: { shop: SHOP } });
});

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
