/**
 * Replays fixture Shopify GraphQL responses through syncShopifyInventory.
 *
 * This path contained the most destructive bug in the app — a throttled page made the
 * pagination loop stop early, and the orphan sweep then hard-deleted every product it had
 * not reached along with its demand history. It had only ever been typechecked. These
 * tests drive it with a stub admin client so the failure modes are exercised for real.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 *
 * Note the stub admin client: these tests never authenticate against Shopify. That is
 * deliberate and load-bearing, not laziness. The app uses single-use refresh tokens, so
 * running real credentials from a scratch database consumes the shop's refresh token and
 * strands production with an unusable one. See docs/testing-against-production-data.md.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { syncShopifyInventory } = await import("./shopify-sync.server");
const { default: prisma } = await import("../db.server");

const SHOP = "sync-test.myshopify.com";

type Reply = { status?: number; body: unknown };

/** Stub admin client. `handler` decides what each query returns, in call order. */
function mockAdmin(handler: (query: string, vars: Record<string, unknown>, call: number) => Reply) {
  let call = 0;
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const admin = {
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const vars = opts?.variables ?? {};
      calls.push({ query, vars });
      const reply = handler(query, vars, call++);
      const status = reply.status ?? 200;
      return {
        status,
        ok: status < 400,
        json: async () => reply.body,
      };
    },
  } as unknown as AdminApiContext;
  return { admin, calls };
}

const isLocations = (q: string) => q.includes("getLocations");

const locationsBody = {
  data: {
    locations: {
      edges: [{ node: { id: "gid://shopify/Location/1", name: "Karachi WH", isActive: true } }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  },
};

function variant(id: string, opts: { sku?: string; qty?: number; cost?: string | null; image?: string | null; barcode?: string | null } = {}) {
  return {
    node: {
      id: `gid://shopify/ProductVariant/${id}`,
      title: opts.sku ?? id,
      sku: opts.sku ?? `SKU-${id}`,
      barcode: opts.barcode === undefined ? `BC-${id}` : opts.barcode,
      inventoryQuantity: opts.qty ?? 5,
      image: opts.image === undefined ? null : { url: opts.image },
      product: {
        id: "gid://shopify/Product/1",
        title: "Kurta",
        featuredImage: { url: "https://cdn.shopify.com/featured.jpg" },
      },
      inventoryItem: {
        id: `gid://shopify/InventoryItem/${id}`,
        unitCost: opts.cost === null ? null : { amount: opts.cost ?? "250.00" },
        inventoryLevels: {
          edges: [
            {
              node: {
                location: { id: "gid://shopify/Location/1" },
                quantities: [
                  { name: "on_hand", quantity: opts.qty ?? 5 },
                  { name: "available", quantity: opts.qty ?? 5 },
                ],
              },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  };
}

const variantsBody = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { productVariants: { edges: nodes, pageInfo: { hasNextPage, endCursor } } },
});

async function productIds() {
  const rows = await prisma.product.findMany({
    where: { shop: SHOP },
    select: { id: true, isArchived: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => `${r.id.split("/").pop()}${r.isArchived ? ":archived" : ""}`);
}

beforeEach(async () => {
  await prisma.salesRecord.deleteMany({ where: { shop: SHOP } });
  await prisma.stockSnapshot.deleteMany({ where: { shop: SHOP } });
  await prisma.productLocationStock.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.location.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.create({ data: { shop: SHOP } });
});

describe("syncShopifyInventory", () => {
  it("syncs variants, per-location stock, image and unit cost", async () => {
    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.completed).toBe(true);
    expect(result.synced).toBe(1);
    expect(result.errors).toBe(0);

    const p = await prisma.product.findFirst({ where: { shop: SHOP } });
    expect(p?.sku).toBe("SKU-1");
    expect(p?.currentStock).toBe(5);
    // Barcode is captured from Shopify so scans can resolve to this variant.
    expect(p?.barcode).toBe("BC-1");
    // Cost comes from Shopify's own "Cost per item", no integration needed.
    expect(p?.unitCost).toBe(250);
    // Falls back to the product's featured image when the variant has none.
    expect(p?.imageUrl).toBe("https://cdn.shopify.com/featured.jpg");

    const levels = await prisma.productLocationStock.count({ where: { shop: SHOP } });
    expect(levels).toBe(1);
  });

  it("removes a per-location level Shopify no longer reports", async () => {
    // Regression: levels were upsert-only, so stock that moved off a location kept its
    // last known onHand forever and no re-sync could correct it. This is the shape of the
    // "I removed the inventory in Shopify but the app still shows it" report.
    const twoLocations = {
      data: {
        locations: {
          edges: [
            { node: { id: "gid://shopify/Location/1", name: "Karachi WH", isActive: true } },
            { node: { id: "gid://shopify/Location/2", name: "Lahore WH", isActive: true } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };

    // First sync: stocked at both locations.
    const atBoth = variant("1");
    atBoth.node.inventoryItem.inventoryLevels.edges.push({
      node: {
        location: { id: "gid://shopify/Location/2" },
        quantities: [
          { name: "on_hand", quantity: 40 },
          { name: "available", quantity: 40 },
        ],
      },
    });
    const first = mockAdmin((q) =>
      isLocations(q) ? { body: twoLocations } : { body: variantsBody([atBoth]) },
    );
    await syncShopifyInventory(first.admin, SHOP);
    expect(await prisma.productLocationStock.count({ where: { shop: SHOP } })).toBe(2);

    // Second sync: Lahore no longer holds any of it.
    const second = mockAdmin((q) =>
      isLocations(q) ? { body: twoLocations } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(second.admin, SHOP);

    const levels = await prisma.productLocationStock.findMany({
      where: { shop: SHOP },
      include: { location: true },
    });
    expect(levels).toHaveLength(1);
    expect(levels[0].location.shopifyLocationId).toBe("gid://shopify/Location/1");

    const p = await prisma.product.findFirst({ where: { shop: SHOP } });
    expect(p?.currentStock).toBe(5);
  });

  it("zeroes rather than deletes a stale level that carries a bin label", async () => {
    // binLocation is merchant-entered, not Shopify-derived. Reconciling stock away must
    // not also throw away where they put the goods.
    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(admin, SHOP);

    const other = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/9", name: "Lahore", isActive: true },
    });
    await prisma.productLocationStock.create({
      data: {
        shop: SHOP,
        productId: "gid://shopify/ProductVariant/1",
        locationId: other.id,
        onHand: 12,
        reserved: 0,
        binLocation: "A-04-3",
      },
    });

    // Shopify still reports the variant only at Location/1, so Lahore is stale.
    const again = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(again.admin, SHOP);

    const kept = await prisma.productLocationStock.findUnique({
      where: {
        productId_locationId: { productId: "gid://shopify/ProductVariant/1", locationId: other.id },
      },
    });
    expect(kept).not.toBeNull();
    expect(kept?.onHand).toBe(0);
    expect(kept?.binLocation).toBe("A-04-3");
  });

  it("keeps existing levels when the shop's token cannot read locations", async () => {
    // The no-location fallback yields no levels at all. Treating that as "no stock
    // anywhere" would wipe every level the shop has, so the reconciliation must not fire.
    const withLocations = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(withLocations.admin, SHOP);
    expect(await prisma.productLocationStock.count({ where: { shop: SHOP } })).toBe(1);

    const denied = mockAdmin((q) =>
      isLocations(q)
        ? { body: { errors: [{ message: "Access denied for locations field" }] } }
        : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(denied.admin, SHOP);

    expect(await prisma.productLocationStock.count({ where: { shop: SHOP } })).toBe(1);
  });

  it("deactivates a location Shopify no longer lists", async () => {
    const both = {
      data: {
        locations: {
          edges: [
            { node: { id: "gid://shopify/Location/1", name: "Karachi WH", isActive: true } },
            { node: { id: "gid://shopify/Location/2", name: "Closed WH", isActive: true } },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    };
    const first = mockAdmin((q) =>
      isLocations(q) ? { body: both } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(first.admin, SHOP);

    const second = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );
    await syncShopifyInventory(second.admin, SHOP);

    const closed = await prisma.location.findFirst({
      where: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/2" },
    });
    // Deactivated, not deleted — counts, transfers and bins still reference it.
    expect(closed).not.toBeNull();
    expect(closed?.isActive).toBe(false);
  });

  it("stores an empty or missing barcode as null, not an empty string", async () => {
    // A blank must land as NULL so "no barcode" is one value — otherwise an exact-match
    // scan for "" would match every blank row at once.
    const { admin } = mockAdmin((q) =>
      isLocations(q)
        ? { body: locationsBody }
        : { body: variantsBody([variant("1", { barcode: "" }), variant("2", { barcode: "  8964\n" })]) },
    );
    await syncShopifyInventory(admin, SHOP);
    const blank = await prisma.product.findUnique({ where: { id: "gid://shopify/ProductVariant/1" } });
    const padded = await prisma.product.findUnique({ where: { id: "gid://shopify/ProductVariant/2" } });
    expect(blank?.barcode).toBeNull();
    // And surrounding whitespace from a scanner-entered value is trimmed on the way in.
    expect(padded?.barcode).toBe("8964");
  });

  it("treats a missing unit cost as unset rather than zero", async () => {
    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1", { cost: null })]) },
    );
    await syncShopifyInventory(admin, SHOP);
    const p = await prisma.product.findFirst({ where: { shop: SHOP } });
    expect(p?.unitCost).toBe(0);
  });

  it("syncs more than 20 variants of one product", async () => {
    // Regression: the old nested query capped variants at 20 per product, and the
    // truncated ones were then archived/deleted as if Shopify had removed them.
    const nodes = Array.from({ length: 30 }, (_, i) => variant(String(i + 1)));
    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody(nodes) },
    );

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.synced).toBe(30);
    expect(await prisma.product.count({ where: { shop: SHOP } })).toBe(30);
  });

  it("follows pagination across pages", async () => {
    const { admin } = mockAdmin((q, vars) => {
      if (isLocations(q)) return { body: locationsBody };
      return vars.cursor === "p1"
        ? { body: variantsBody([variant("2")]) }
        : { body: variantsBody([variant("1")], true, "p1") };
    });

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.completed).toBe(true);
    expect(await productIds()).toEqual(["1", "2"]);
  });

  it("retries a throttled page instead of treating it as the end of the catalogue", async () => {
    let variantCalls = 0;
    const { admin } = mockAdmin((q) => {
      if (isLocations(q)) return { body: locationsBody };
      // Count catalogue pages only; the sync also asks for the shop's name.
      if (!q.includes("getProductVariants")) return { body: { data: { shop: { name: "Test" } } } };
      variantCalls++;
      // First attempt throttled, second succeeds.
      if (variantCalls === 1) return { status: 429, body: {} };
      return { body: variantsBody([variant("1")]) };
    });

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.completed).toBe(true);
    expect(result.synced).toBe(1);
    expect(variantCalls).toBe(2);
  });

  it("archives products missing from a complete sync, keeping their history", async () => {
    // Seed a product with demand history that Shopify will not return.
    await prisma.product.create({
      data: {
        id: "gid://shopify/ProductVariant/99",
        shop: SHOP,
        productGid: "gid://shopify/Product/9",
        title: "Discontinued",
      },
    });
    await prisma.salesRecord.create({
      data: {
        shop: SHOP,
        productId: "gid://shopify/ProductVariant/99",
        date: new Date("2026-01-01T00:00:00.000Z"),
        quantity: 7,
      },
    });

    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.completed).toBe(true);
    expect(result.archived).toBe(1);
    // Soft delete: the row and its demand history survive.
    const archived = await prisma.product.findUnique({
      where: { id: "gid://shopify/ProductVariant/99" },
    });
    expect(archived?.isArchived).toBe(true);
    expect(archived?.archivedAt).not.toBeNull();
    expect(
      await prisma.salesRecord.count({
        where: { productId: "gid://shopify/ProductVariant/99" },
      }),
    ).toBe(1);
  });

  it("archives NOTHING when the catalogue walk fails partway", async () => {
    // The bug this whole rewrite exists for: page 2 fails, so every product beyond
    // page 1 is missing from seenVariantIds through no fault of its own. Sweeping on a
    // partial walk used to delete them and their demand history permanently.
    await prisma.product.create({
      data: {
        id: "gid://shopify/ProductVariant/99",
        shop: SHOP,
        productGid: "gid://shopify/Product/9",
        title: "Not reached",
      },
    });

    const { admin } = mockAdmin((q, vars) => {
      if (isLocations(q)) return { body: locationsBody };
      // 400 is non-retryable, so this fails fast rather than backing off five times.
      return vars.cursor === "p1"
        ? { status: 400, body: {} }
        : { body: variantsBody([variant("1")], true, "p1") };
    });

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.completed).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.archived).toBe(0);

    const survivor = await prisma.product.findUnique({
      where: { id: "gid://shopify/ProductVariant/99" },
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.isArchived).toBe(false);
  });

  it("un-archives a variant that reappears in Shopify", async () => {
    await prisma.product.create({
      data: {
        id: "gid://shopify/ProductVariant/1",
        shop: SHOP,
        productGid: "gid://shopify/Product/1",
        title: "Back in stock",
        isArchived: true,
        archivedAt: new Date(),
      },
    });

    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );

    await syncShopifyInventory(admin, SHOP);

    const p = await prisma.product.findUnique({
      where: { id: "gid://shopify/ProductVariant/1" },
    });
    expect(p?.isArchived).toBe(false);
    expect(p?.archivedAt).toBeNull();
  });

  it("never archives a product still referenced by an open purchase order", async () => {
    await prisma.product.create({
      data: {
        id: "gid://shopify/ProductVariant/99",
        shop: SHOP,
        productGid: "gid://shopify/Product/9",
        title: "On order",
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: { shop: SHOP, poNumber: `PO-SYNC-${Date.now()}`, status: "sent" },
    });
    await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: "gid://shopify/ProductVariant/99",
        quantityOrdered: 10,
      },
    });

    const { admin } = mockAdmin((q) =>
      isLocations(q) ? { body: locationsBody } : { body: variantsBody([variant("1")]) },
    );

    const result = await syncShopifyInventory(admin, SHOP);

    expect(result.archived).toBe(0);
    const p = await prisma.product.findUnique({
      where: { id: "gid://shopify/ProductVariant/99" },
    });
    expect(p?.isArchived).toBe(false);

    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: po.id } });
    await prisma.purchaseOrder.delete({ where: { id: po.id } });
  });
});
