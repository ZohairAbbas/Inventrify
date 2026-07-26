/**
 * Cycle counting: opening a count, capturing snapshots, and posting variances.
 *
 * The posting path is the risk surface. It moves stock through the audited adjustment
 * path, so it must claim the count atomically (a double-submit cannot post twice), skip
 * uncounted lines rather than reading a blank as a physical zero, and measure the delta
 * against the snapshot captured at count time rather than the live figure.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const {
  createStockCount,
  addCountItem,
  addAllStockedItems,
  setCountedQuantity,
  postStockCount,
  cancelStockCount,
} = await import("./stock-count.server");
const { default: prisma } = await import("../db.server");

const SHOP = "count-test.myshopify.com";
const OTHER = "other-count-test.myshopify.com";

function mockAdmin(opts: { failInventoryWrite?: boolean } = {}) {
  const admin = {
    graphql: async (query: string) => ({
      status: 200,
      ok: true,
      json: async () =>
        query.includes("adjustInventory")
          ? {
              data: {
                inventoryAdjustQuantities: {
                  userErrors: opts.failInventoryWrite ? [{ message: "not stocked" }] : [],
                },
              },
            }
          : { data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } },
    }),
  } as unknown as AdminApiContext;
  return admin;
}

let seq = 0;
async function seedProduct(onHand: number, locationId: string, shop = SHOP) {
  seq += 1;
  const id = `gid://shopify/ProductVariant/cc-${seq}`;
  await prisma.product.create({
    data: {
      id,
      shop,
      productGid: `gid://shopify/Product/cc-${seq}`,
      inventoryItemId: `gid://shopify/InventoryItem/cc-${seq}`,
      title: `Item ${seq}`,
      sku: `SKU-${seq}`,
      currentStock: onHand,
    },
  });
  await prisma.productLocationStock.create({
    data: { shop, productId: id, locationId, onHand },
  });
  return id;
}

async function seedLocation(shop = SHOP) {
  const loc = await prisma.location.create({
    data: { shop, shopifyLocationId: `gid://shopify/Location/${shop}`, name: "WH" },
  });
  return loc.id;
}

beforeEach(async () => {
  for (const shop of [SHOP, OTHER]) {
    await prisma.stockCountItem.deleteMany({ where: { stockCount: { shop } } });
    await prisma.stockCount.deleteMany({ where: { shop } });
    await prisma.stockAdjustment.deleteMany({ where: { shop } });
    await prisma.productLocationStock.deleteMany({ where: { shop } });
    await prisma.product.deleteMany({ where: { shop } });
    await prisma.location.deleteMany({ where: { shop } });
  }
  seq = 0;
});

describe("createStockCount", () => {
  it("opens a count at a valid location", async () => {
    const loc = await seedLocation();
    const r = await createStockCount(SHOP, { locationId: loc, notes: "  monthly  " });
    expect(r.ok).toBe(true);
    const count = await prisma.stockCount.findUniqueOrThrow({ where: { id: r.countId! } });
    expect(count.status).toBe("counting");
    expect(count.notes).toBe("monthly");
  });

  it("refuses a location from another shop", async () => {
    const loc = await seedLocation(OTHER);
    const r = await createStockCount(SHOP, { locationId: loc });
    expect(r.ok).toBe(false);
  });
});

describe("addCountItem", () => {
  it("snapshots the product's on-hand at the count location", async () => {
    const loc = await seedLocation();
    const product = await seedProduct(42, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });

    await addCountItem(SHOP, countId!, product);
    const item = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId! } });
    expect(item.snapshotQty).toBe(42);
    expect(item.countedQty).toBeNull();
  });

  it("does not duplicate or reset a product already on the count", async () => {
    const loc = await seedLocation();
    const product = await seedProduct(10, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    await addCountItem(SHOP, countId!, product);
    const item = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId! } });
    await prisma.stockCountItem.update({ where: { id: item.id }, data: { countedQty: 7 } });

    const again = await addCountItem(SHOP, countId!, product);
    expect(again.alreadyPresent).toBe(true);
    const after = await prisma.stockCountItem.findMany({ where: { stockCountId: countId! } });
    expect(after).toHaveLength(1);
    // The count already keyed in must survive a re-scan.
    expect(after[0].countedQty).toBe(7);
  });

  it("refuses to add to a posted count", async () => {
    const loc = await seedLocation();
    const product = await seedProduct(10, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    await prisma.stockCount.update({ where: { id: countId! }, data: { status: "posted" } });
    const r = await addCountItem(SHOP, countId!, product);
    expect(r.ok).toBe(false);
  });
});

describe("addAllStockedItems", () => {
  it("adds every stocked product at the location, snapshotting each", async () => {
    const loc = await seedLocation();
    await seedProduct(5, loc);
    await seedProduct(9, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });

    const r = await addAllStockedItems(SHOP, countId!);
    expect(r.added).toBe(2);
    const items = await prisma.stockCountItem.findMany({ where: { stockCountId: countId! }, orderBy: { snapshotQty: "asc" } });
    expect(items.map((i) => i.snapshotQty)).toEqual([5, 9]);
  });

  it("skips products already added by hand", async () => {
    const loc = await seedLocation();
    const p1 = await seedProduct(5, loc);
    await seedProduct(9, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    await addCountItem(SHOP, countId!, p1);

    const r = await addAllStockedItems(SHOP, countId!);
    expect(r.added).toBe(1); // only the second product
    expect(await prisma.stockCountItem.count({ where: { stockCountId: countId! } })).toBe(2);
  });
});

describe("setCountedQuantity", () => {
  it("records a count and rejects a negative one", async () => {
    const loc = await seedLocation();
    const product = await seedProduct(10, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    await addCountItem(SHOP, countId!, product);
    const item = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId! } });

    expect((await setCountedQuantity(SHOP, countId!, item.id, 8)).ok).toBe(true);
    expect((await prisma.stockCountItem.findUniqueOrThrow({ where: { id: item.id } })).countedQty).toBe(8);

    const bad = await setCountedQuantity(SHOP, countId!, item.id, -1);
    expect(bad.ok).toBe(false);
  });
});

describe("postStockCount", () => {
  async function openCounted(entries: { onHand: number; counted: number | null }[]) {
    const loc = await seedLocation();
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    const products: string[] = [];
    for (const e of entries) {
      const product = await seedProduct(e.onHand, loc);
      products.push(product);
      await addCountItem(SHOP, countId!, product);
      const item = await prisma.stockCountItem.findFirstOrThrow({
        where: { stockCountId: countId!, productId: product },
      });
      if (e.counted !== null) await setCountedQuantity(SHOP, countId!, item.id, e.counted);
    }
    return { countId: countId!, loc, products };
  }

  it("applies the variance as an adjustment and marks the count posted", async () => {
    const { countId, products } = await openCounted([{ onHand: 50, counted: 47 }]);
    const r = await postStockCount(mockAdmin(), SHOP, countId);

    expect(r).toMatchObject({ ok: true, applied: 1, unchanged: 0, uncounted: 0 });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: products[0] } });
    expect(product.currentStock).toBe(47); // 50 − 3

    const adj = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP, reason: "count_correction" } });
    expect(adj.delta).toBe(-3);

    const count = await prisma.stockCount.findUniqueOrThrow({ where: { id: countId } });
    expect(count.status).toBe("posted");
    expect(count.postedAt).not.toBeNull();
  });

  it("skips an uncounted line rather than zeroing real stock", async () => {
    const { countId, products } = await openCounted([{ onHand: 30, counted: null }]);
    const r = await postStockCount(mockAdmin(), SHOP, countId);

    expect(r).toMatchObject({ ok: true, applied: 0, uncounted: 1 });
    // Untouched: a blank means "not counted", not "counted zero".
    const product = await prisma.product.findUniqueOrThrow({ where: { id: products[0] } });
    expect(product.currentStock).toBe(30);
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("leaves an all-square line untouched but still posts", async () => {
    const { countId, products } = await openCounted([{ onHand: 20, counted: 20 }]);
    const r = await postStockCount(mockAdmin(), SHOP, countId);

    expect(r).toMatchObject({ ok: true, applied: 0, unchanged: 1 });
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP } })).toBe(0);
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: countId } })).status).toBe("posted");
    expect(products).toHaveLength(1);
  });

  it("measures the delta from the snapshot, preserving a concurrent movement", async () => {
    // Count opened when on-hand was 50, operator counted 47. Then a sale of 2 happens
    // before posting (on-hand now 48). Posting applies the observed variance (−3), not a
    // "set to 47", so the concurrent movement is preserved: 48 − 3 = 45.
    const { countId, products, loc } = await openCounted([{ onHand: 50, counted: 47 }]);
    await prisma.productLocationStock.update({
      where: { productId_locationId: { productId: products[0], locationId: loc } },
      data: { onHand: 48 },
    });
    await prisma.product.update({ where: { id: products[0] }, data: { currentStock: 48 } });

    await postStockCount(mockAdmin(), SHOP, countId);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: products[0] } });
    expect(product.currentStock).toBe(45);
  });

  it("posts exactly once when two submits race", async () => {
    const { countId, products } = await openCounted([{ onHand: 50, counted: 45 }]);
    const results = await Promise.all([
      postStockCount(mockAdmin(), SHOP, countId),
      postStockCount(mockAdmin(), SHOP, countId),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    // 45, not 40 — the second post moved nothing.
    const product = await prisma.product.findUniqueOrThrow({ where: { id: products[0] } });
    expect(product.currentStock).toBe(45);
    expect(await prisma.stockAdjustment.count({ where: { shop: SHOP, reason: "count_correction" } })).toBe(1);
  });

  it("stamps the acting user on the posted adjustments", async () => {
    const { countId } = await openCounted([{ onHand: 50, counted: 47 }]);
    await postStockCount(mockAdmin(), SHOP, countId, "555000");
    const adj = await prisma.stockAdjustment.findFirstOrThrow({ where: { shop: SHOP, reason: "count_correction" } });
    expect(adj.createdByUserId).toBe("555000");
  });

  it("refuses to post an already-posted count", async () => {
    const { countId } = await openCounted([{ onHand: 10, counted: 8 }]);
    await postStockCount(mockAdmin(), SHOP, countId);
    const again = await postStockCount(mockAdmin(), SHOP, countId);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already posted/i);
  });

  it("releases the claim when every movement fails, so it can be retried", async () => {
    // Guard rejects the movement: counted 0 against a snapshot of 10 needs −10, but the
    // location only holds... we force the failure via a Shopify-independent guard by
    // making the location on-hand smaller than the required removal.
    const loc = await seedLocation();
    const product = await seedProduct(10, loc);
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    await addCountItem(SHOP, countId!, product);
    const item = await prisma.stockCountItem.findFirstOrThrow({ where: { stockCountId: countId! } });
    await setCountedQuantity(SHOP, countId!, item.id, 5); // snapshot 10 → delta −5
    // Physically drop the location to 3 so removing 5 is refused by the oversell guard.
    await prisma.productLocationStock.update({
      where: { productId_locationId: { productId: product, locationId: loc } },
      data: { onHand: 3 },
    });

    const r = await postStockCount(mockAdmin(), SHOP, countId!);
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBe(1);
    // Not stranded as posted — the count can be corrected and posted again.
    expect((await prisma.stockCount.findUniqueOrThrow({ where: { id: countId! } })).status).not.toBe("posted");
  });

  it("still posts local stock when Shopify rejects the push, surfacing a warning", async () => {
    const { countId, products } = await openCounted([{ onHand: 50, counted: 47 }]);
    const r = await postStockCount(mockAdmin({ failInventoryWrite: true }), SHOP, countId);

    expect(r.ok).toBe(true);
    expect(r.shopifyWarnings.length).toBeGreaterThan(0);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: products[0] } });
    expect(product.currentStock).toBe(47);
  });
});

describe("cancelStockCount", () => {
  it("cancels an open count and blocks a later post", async () => {
    const loc = await seedLocation();
    const { countId } = await createStockCount(SHOP, { locationId: loc });
    expect((await cancelStockCount(SHOP, countId!)).ok).toBe(true);

    const r = await postStockCount(mockAdmin(), SHOP, countId!);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancelled/i);
  });
});
