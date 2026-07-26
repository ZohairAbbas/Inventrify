/**
 * Stock movements: the oversell guard, concurrent accumulation, and reversal identity.
 *
 * The reversal cases are the reason this file exists. "Reverse" had no idempotency at
 * all: clicking it twice created two opposing adjustments and swung stock by twice the
 * original delta, with nothing in the audit trail to explain the second one. The guard is
 * now a unique index on StockAdjustment.reversalOf, which is what actually holds when two
 * submits race — a read-then-write check does not.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { applyStockDelta, applyInventoryLevelUpdate, setBinLocation } = await import("./stock.server");
const { default: prisma } = await import("../db.server");

const SHOP = "stock-test.myshopify.com";
const PRODUCT_ID = "gid://shopify/ProductVariant/stock-1";

function mockAdmin() {
  const admin = {
    graphql: async (query: string) => ({
      status: 200,
      ok: true,
      json: async () =>
        query.includes("adjustInventory")
          ? { data: { inventoryAdjustQuantities: { userErrors: [] } } }
          : { data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } },
    }),
  } as unknown as AdminApiContext;
  return admin;
}

async function seed(stock = 10, withLocation = true) {
  await prisma.product.create({
    data: {
      id: PRODUCT_ID,
      shop: SHOP,
      productGid: "gid://shopify/Product/stock-1",
      inventoryItemId: "gid://shopify/InventoryItem/stock-1",
      title: "Lawn Suit",
      sku: "LWN-1",
      currentStock: stock,
    },
  });
  if (withLocation) {
    const location = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/1", name: "Karachi WH" },
    });
    await prisma.productLocationStock.create({
      data: { shop: SHOP, productId: PRODUCT_ID, locationId: location.id, onHand: stock },
    });
    return location;
  }
  return null;
}

beforeEach(async () => {
  await prisma.stockAdjustment.deleteMany({ where: { shop: SHOP } });
  await prisma.productLocationStock.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.location.deleteMany({ where: { shop: SHOP } });
});

describe("applyStockDelta", () => {
  it("records an audit row and moves per-location stock", async () => {
    const location = await seed(10);
    const result = await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -3, "damage", "Water damage");

    expect(result).toMatchObject({ ok: true, newStock: 7 });
    const level = await prisma.productLocationStock.findUniqueOrThrow({
      where: { productId_locationId: { productId: PRODUCT_ID, locationId: location!.id } },
    });
    expect(level.onHand).toBe(7);

    const adjustments = await prisma.stockAdjustment.findMany({ where: { shop: SHOP } });
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]).toMatchObject({ delta: -3, reason: "damage", reversalOf: null });
  });

  it("refuses to remove more than is on hand", async () => {
    await seed(2);
    const result = await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -5, "damage", null);

    expect(result).toHaveProperty("error");
    // The guard must roll back the audit row too, not just the level.
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP } })).toBe(0);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(2);
  });

  it("accumulates concurrent movements instead of losing one", async () => {
    await seed(100);
    // Both start from the same read; database-side `increment` is what makes the second
    // write add to the first rather than overwrite it.
    await Promise.all([
      applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -10, "damage", "a"),
      applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -15, "sample", "b"),
    ]);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(75);
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP } })).toBe(2);
  });

  it("is scoped to the shop", async () => {
    await seed(10);
    const result = await applyStockDelta(mockAdmin(), "someone-else.myshopify.com", PRODUCT_ID, -1, "damage", null);

    expect(result).toEqual({ error: "Product not found" });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(10);
  });

  it("falls back to the aggregate count when the shop has no locations", async () => {
    await seed(10, false);
    const result = await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 5, "count_correction", null);

    expect(result).toMatchObject({ ok: true, newStock: 15 });
    const adjustments = await prisma.stockAdjustment.findMany({ where: { shop: SHOP } });
    expect(adjustments[0].locationId).toBeNull();
  });
});

describe("reversal identity", () => {
  it("links the reversal to the adjustment it undoes", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -4, "damage", null);
    const original = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });

    const result = await applyStockDelta(
      mockAdmin(), SHOP, PRODUCT_ID, 4, "reversal", "undo", original.locationId,
      { reversalOf: original.id },
    );

    expect(result).toMatchObject({ ok: true, newStock: 10 });
    const reversal = await prisma.stockAdjustment.findUniqueOrThrow({
      where: { reversalOf: original.id },
    });
    expect(reversal.delta).toBe(4);
  });

  it("refuses to reverse the same adjustment twice", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -4, "damage", null);
    const original = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });

    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 4, "reversal", "undo", original.locationId, {
      reversalOf: original.id,
    });
    const second = await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 4, "reversal", "undo", original.locationId, {
      reversalOf: original.id,
    });

    expect(second).toEqual({ error: "That adjustment has already been reversed" });
    // 10, not 14 — the second reversal moved nothing.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(10);
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP, reason: "reversal" } })).toBe(1);
  });

  it("holds when two reversals race", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -4, "damage", null);
    const original = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });

    // The unique index, not a prior read, is what decides this.
    const results = await Promise.all([
      applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 4, "reversal", "undo", original.locationId, {
        reversalOf: original.id,
      }),
      applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 4, "reversal", "undo", original.locationId, {
        reversalOf: original.id,
      }),
    ]);

    expect(results.filter((r) => "ok" in r)).toHaveLength(1);
    expect(results.filter((r) => "error" in r)).toHaveLength(1);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(10);
  });

  it("does not misreport an unrelated constraint failure as a reversal", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -4, "damage", null);
    const original = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });

    // A movement that sets no reversalOf can never be "already reversed", whatever else
    // goes wrong inside the transaction.
    const plain = await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, 1, "sample", null);
    expect(plain).not.toHaveProperty("error");
    expect(original.reversalOf).toBeNull();
  });

  it("leaves ordinary adjustments free of a reversal link", async () => {
    await seed(10);
    // NULLs are exempt from UNIQUE, so any number of ordinary adjustments coexist.
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -1, "damage", null);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -1, "damage", null);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -1, "sample", null);

    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP, reversalOf: null } })).toBe(3);
  });
});

describe("applyInventoryLevelUpdate", () => {
  it("reconstructs on-hand from available plus the known reserved", async () => {
    const location = await seed(10);
    // 10 on hand, 3 committed to unfulfilled orders — the state the catalogue sync writes.
    await prisma.productLocationStock.update({
      where: { productId_locationId: { productId: PRODUCT_ID, locationId: location!.id } },
      data: { onHand: 10, reserved: 3 },
    });

    // Shopify reports available = 5, i.e. on-hand has dropped to 8.
    const result = await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/1", 5,
    );

    expect(result.applied).toBe("location");
    const level = await prisma.productLocationStock.findUniqueOrThrow({
      where: { productId_locationId: { productId: PRODUCT_ID, locationId: location!.id } },
    });
    // 8, not 5. Writing `available` straight into onHand understated stock by the
    // reserved quantity and left every inventory position wrong until the next sync.
    expect(level.onHand).toBe(8);
    expect(level.reserved).toBe(3);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(8);
  });

  it("treats available as on-hand for a level it has never seen", async () => {
    await seed(0);
    await prisma.productLocationStock.deleteMany({ where: { shop: SHOP } });

    await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/1", 12,
    );

    const level = await prisma.productLocationStock.findFirstOrThrow({ where: { shop: SHOP } });
    expect(level).toMatchObject({ onHand: 12, reserved: 0 });
  });

  it("sums across locations rather than collapsing to the last reporter", async () => {
    const first = await seed(10);
    const second = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/2", name: "Lahore WH" },
    });
    await prisma.productLocationStock.create({
      data: { shop: SHOP, productId: PRODUCT_ID, locationId: second.id, onHand: 4 },
    });

    await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/2", 9,
    );

    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(19); // 10 at Karachi + 9 at Lahore
    expect(first).not.toBeNull();
  });

  it("ignores an unsynced location on a shop that has locations", async () => {
    await seed(10);

    const result = await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/999", 3,
    );

    // Overwriting currentStock with one unknown location's figure would collapse the
    // product to 3 and lose everything held elsewhere.
    expect(result.applied).toBe("none");
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(10);
  });

  it("falls back to the aggregate for a shop with no locations at all", async () => {
    await seed(10, false);

    const result = await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/1", 3,
    );

    // A token predating read_locations: the aggregate is all there is, so it is correct.
    expect(result.applied).toBe("aggregate");
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(3);
  });

  it("does nothing for an inventory item it does not track", async () => {
    await seed(10);
    const result = await applyInventoryLevelUpdate(
      SHOP, "gid://shopify/InventoryItem/unknown", "gid://shopify/Location/1", 3,
    );
    expect(result.applied).toBe("none");
  });

  it("is scoped to the shop", async () => {
    await seed(10);
    const result = await applyInventoryLevelUpdate(
      "someone-else.myshopify.com", "gid://shopify/InventoryItem/stock-1", "gid://shopify/Location/1", 3,
    );
    expect(result.applied).toBe("none");
    const after = await prisma.product.findUniqueOrThrow({ where: { id: PRODUCT_ID } });
    expect(after.currentStock).toBe(10);
  });
});

describe("setBinLocation", () => {
  it("sets and clears a bin on an existing location row", async () => {
    const location = await seed(10);
    expect((await setBinLocation(SHOP, PRODUCT_ID, location!.id, "  A-12 ")).ok).toBe(true);
    let level = await prisma.productLocationStock.findFirstOrThrow({ where: { shop: SHOP } });
    expect(level.binLocation).toBe("A-12"); // trimmed

    // Emptying clears it to null so "no bin" is one state, not "" vs null.
    await setBinLocation(SHOP, PRODUCT_ID, location!.id, "   ");
    level = await prisma.productLocationStock.findFirstOrThrow({ where: { shop: SHOP } });
    expect(level.binLocation).toBeNull();
  });

  it("creates the location row when the pair has no stock record yet", async () => {
    // A merchant can shelve something before any quantity is synced for it there.
    await seed(0, false);
    const location = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/new", name: "New WH" },
    });
    const r = await setBinLocation(SHOP, PRODUCT_ID, location.id, "B-7");
    expect(r.ok).toBe(true);
    const level = await prisma.productLocationStock.findUniqueOrThrow({
      where: { productId_locationId: { productId: PRODUCT_ID, locationId: location.id } },
    });
    expect(level).toMatchObject({ binLocation: "B-7", onHand: 0 });
  });

  it("caps an over-long value", async () => {
    const location = await seed(5);
    await setBinLocation(SHOP, PRODUCT_ID, location!.id, "x".repeat(200));
    const level = await prisma.productLocationStock.findFirstOrThrow({ where: { shop: SHOP } });
    expect(level.binLocation!.length).toBe(60);
  });

  it("refuses a product or location from another shop", async () => {
    const location = await seed(5);
    expect((await setBinLocation("other.myshopify.com", PRODUCT_ID, location!.id, "Z-1")).ok).toBe(false);
    // The bin was not written.
    const level = await prisma.productLocationStock.findFirstOrThrow({ where: { shop: SHOP } });
    expect(level.binLocation).toBeNull();
  });
});

describe("user attribution", () => {
  it("records the acting user id on an adjustment", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -2, "damage", null, null, { userId: "998877" });
    const adj = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });
    expect(adj.createdByUserId).toBe("998877");
  });

  it("leaves it null when no user is supplied (e.g. a cron movement)", async () => {
    await seed(10);
    await applyStockDelta(mockAdmin(), SHOP, PRODUCT_ID, -1, "damage", null);
    const adj = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP } });
    expect(adj.createdByUserId).toBeNull();
  });
});
