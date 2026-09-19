/**
 * Purchase-order lifecycle: marking sent, and receiving stock.
 *
 * This path had two implementations — the correct one on the PO detail page and a
 * shortcut on the list page that incremented Product.currentStock directly. The shortcut
 * left per-location stock untouched, so the receipt vanished at the next sync (which
 * recomputes currentStock from per-location on-hand); it also never recorded received
 * quantities, a delivery date, or the supplier lead-time observation. These tests pin
 * down the single implementation both pages now use.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 *
 * The admin client is a stub: these tests never authenticate against Shopify. The app
 * uses single-use refresh tokens, so running real credentials from a scratch database
 * strands production with an unusable one. See docs/testing-against-production-data.md.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const {
  markPurchaseOrderSent,
  receivePurchaseOrder,
  parseReceivedQuantities,
  validateDraftLines,
  validateSupplierId,
} = await import("./purchase-order.server");
const { default: prisma } = await import("../db.server");

const SHOP = "po-test.myshopify.com";
const OTHER_SHOP = "other-po-test.myshopify.com";

/** Records the inventory deltas pushed to Shopify so they can be asserted on. */
function mockAdmin(opts: { failInventoryWrite?: boolean } = {}) {
  const pushed: { inventoryItemId: string; locationId: string; delta: number }[] = [];
  const admin = {
    graphql: async (query: string, o?: { variables?: Record<string, unknown> }) => {
      if (query.includes("adjustInventory")) {
        const input = (o?.variables?.input ?? {}) as {
          changes?: { inventoryItemId: string; locationId: string; delta: number }[];
        };
        for (const c of input.changes ?? []) pushed.push(c);
        return {
          status: 200,
          ok: true,
          json: async () => ({
            data: {
              inventoryAdjustQuantities: {
                userErrors: opts.failInventoryWrite ? [{ message: "Inventory item not stocked" }] : [],
              },
            },
          }),
        };
      }
      // getPrimaryLocation fallback
      return {
        status: 200,
        ok: true,
        json: async () => ({
          data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } },
        }),
      };
    },
  } as unknown as AdminApiContext;
  return { admin, pushed };
}

async function seed(opts: { withLocation?: boolean; stock?: number } = {}) {
  const withLocation = opts.withLocation ?? true;

  const supplier = await prisma.supplier.create({
    data: { shop: SHOP, name: "Lahore Textiles", leadTimeDays: 7 },
  });

  const product = await prisma.product.create({
    data: {
      id: "gid://shopify/ProductVariant/po-1",
      shop: SHOP,
      productGid: "gid://shopify/Product/po-1",
      inventoryItemId: "gid://shopify/InventoryItem/po-1",
      title: "Kurta",
      sku: "KUR-1",
      currentStock: opts.stock ?? 0,
      unitCost: 250,
    },
  });

  let location = null;
  if (withLocation) {
    location = await prisma.location.create({
      data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/1", name: "Karachi WH" },
    });
    await prisma.productLocationStock.create({
      data: {
        shop: SHOP,
        productId: product.id,
        locationId: location.id,
        onHand: opts.stock ?? 0,
      },
    });
  }

  return { supplier, product, location };
}

async function createPo(
  productId: string,
  opts: {
    supplierId?: string | null;
    status?: string;
    sentAt?: Date | null;
    quantityOrdered?: number;
    quantityReceived?: number;
    shop?: string;
  } = {},
) {
  return prisma.purchaseOrder.create({
    data: {
      shop: opts.shop ?? SHOP,
      poNumber: `PO-${Math.random().toString(36).slice(2, 10)}`,
      status: opts.status ?? "sent",
      supplierId: opts.supplierId ?? null,
      sentAt: opts.sentAt === undefined ? new Date("2026-07-01T00:00:00Z") : opts.sentAt,
      totalCost: 2500,
      items: {
        create: [
          {
            productId,
            quantityOrdered: opts.quantityOrdered ?? 10,
            quantityReceived: opts.quantityReceived ?? 0,
            unitCost: 250,
          },
        ],
      },
    },
    include: { items: true },
  });
}

beforeEach(async () => {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop } } });
    await prisma.purchaseOrder.deleteMany({ where: { shop } });
    await prisma.stockAdjustment.deleteMany({ where: { shop } });
    await prisma.productLocationStock.deleteMany({ where: { shop } });
    await prisma.product.deleteMany({ where: { shop } });
    await prisma.location.deleteMany({ where: { shop } });
    await prisma.supplier.deleteMany({ where: { shop } });
  }
});

describe("markPurchaseOrderSent", () => {
  it("stamps sentAt so lead time can be measured", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { status: "draft", sentAt: null });

    const before = Date.now();
    const result = await markPurchaseOrderSent(SHOP, po.id, new Date("2026-08-01T00:00:00Z"));
    expect(result.ok).toBe(true);

    const updated = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(updated.status).toBe("sent");
    expect(updated.sentAt).not.toBeNull();
    // This is the whole point: the list page used to set status without sentAt, and a PO
    // with no sentAt contributes nothing to supplier lead-time statistics, ever.
    expect((updated.sentAt as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(updated.expectedDeliveryDate?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  it("refuses a PO that is not a draft", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { status: "sent" });

    const result = await markPurchaseOrderSent(SHOP, po.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/draft/i);
  });

  it("does not reset sentAt when clicked twice", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { status: "draft", sentAt: null });

    await markPurchaseOrderSent(SHOP, po.id);
    const first = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    const second = await markPurchaseOrderSent(SHOP, po.id);

    expect(second.ok).toBe(false);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.sentAt?.toISOString()).toBe(first.sentAt?.toISOString());
  });

  it("cannot touch another shop's PO", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { status: "draft", sentAt: null });

    const result = await markPurchaseOrderSent(OTHER_SHOP, po.id);
    expect(result.ok).toBe(false);
    const untouched = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(untouched.status).toBe("draft");
  });
});

describe("receivePurchaseOrder", () => {
  it("writes per-location stock, not just the aggregate", async () => {
    const { product, location } = await seed({ stock: 5 });
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin, pushed } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id);
    expect(result.ok).toBe(true);
    expect(result.moved).toBe(1);

    // The bug this replaces: ProductLocationStock stayed at 5, so the next sync — which
    // recomputes currentStock as sum(onHand) — silently erased the receipt.
    const level = await prisma.productLocationStock.findUniqueOrThrow({
      where: { productId_locationId: { productId: product.id, locationId: location!.id } },
    });
    expect(level.onHand).toBe(15);

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(15);

    // And Shopify was actually told. `changeFromQuantity: null` is required from API
    // 2026-04 and opts out of compare-and-swap; see applyShopifyInventoryDelta.
    expect(pushed).toEqual([
      {
        inventoryItemId: "gid://shopify/InventoryItem/po-1",
        locationId: "gid://shopify/Location/1",
        delta: 10,
        changeFromQuantity: null,
      },
    ]);
  });

  it("records received quantities and a delivery date", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    await receivePurchaseOrder(admin, SHOP, po.id, {
      actualDeliveryDate: new Date("2026-07-15T00:00:00Z"),
    });

    const after = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id },
      include: { items: true },
    });
    expect(after.status).toBe("received");
    // Both were left empty by the list page, which is why docs/data-audit.md found
    // seven "received" POs with no received quantities and no delivery date.
    expect(after.actualDeliveryDate?.toISOString()).toBe("2026-07-15T00:00:00.000Z");
    expect(after.items[0].quantityReceived).toBe(10);
  });

  it("updates supplier lead-time statistics from sentAt, not createdAt", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, {
      supplierId: supplier.id,
      sentAt: new Date("2026-07-01T00:00:00Z"),
    });
    const { admin } = mockAdmin();

    await receivePurchaseOrder(admin, SHOP, po.id, {
      actualDeliveryDate: new Date("2026-07-09T00:00:00Z"),
    });

    const after = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(after.totalPosReceived).toBe(1);
    expect(after.avgActualLeadTime).toBe(8);
    // One observation gives a mean but no spread; sigma stays 0 until the second.
    expect(after.leadTimeVariance).toBe(0);
  });

  it("skips lead-time statistics for a PO that was never marked sent", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, { supplierId: supplier.id, sentAt: null, status: "draft" });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id);
    expect(result.ok).toBe(true);

    // Inventing a send date would corrupt the supplier's mean and variance; recording
    // nothing is correct.
    const after = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(after.totalPosReceived).toBe(0);
    expect(after.avgActualLeadTime).toBeNull();
  });

  it("clamps a same-day or backdated receipt to one day", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, {
      supplierId: supplier.id,
      sentAt: new Date("2026-07-10T00:00:00Z"),
    });
    const { admin } = mockAdmin();

    await receivePurchaseOrder(admin, SHOP, po.id, {
      actualDeliveryDate: new Date("2026-07-08T00:00:00Z"),
    });

    const after = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(after.avgActualLeadTime).toBe(1);
  });

  it("moves only the remainder when a partially received PO is re-confirmed", async () => {
    const { product } = await seed({ stock: 0 });
    const po = await createPo(product.id, { quantityOrdered: 10, quantityReceived: 4 });
    const { admin, pushed } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [po.items[0].id]: 10 },
    });

    expect(result.ok).toBe(true);
    // 6, not 10 — otherwise re-confirming double-counts the four already on the shelf.
    expect(pushed[0].delta).toBe(6);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(6);
  });

  it("accepts a partial receipt below the ordered quantity", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [po.items[0].id]: 3 },
    });

    const after = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: po.id },
      include: { items: true },
    });
    expect(after.items[0].quantityReceived).toBe(3);
    const product2 = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(product2.currentStock).toBe(3);
  });

  it("receives nothing and moves no stock when the quantity is zero", async () => {
    const { product } = await seed({ stock: 7 });
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin, pushed } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [po.items[0].id]: 0 },
    });

    expect(result.ok).toBe(true);
    expect(result.moved).toBe(0);
    expect(pushed).toHaveLength(0);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(7);
  });

  it("rejects an unparseable quantity instead of receiving in full", async () => {
    const { product } = await seed({ stock: 2 });
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [po.items[0].id]: NaN },
    });

    // Every line failed, so nothing is received — silently defaulting a typo to the full
    // ordered quantity would put stock on the shelf that nobody counted.
    expect(result.ok).toBe(false);
    expect(result.failed).toBe(1);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(2);
    const po2 = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(po2.status).toBe("sent");
  });

  it("refuses to receive twice", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    await receivePurchaseOrder(admin, SHOP, po.id);
    const second = await receivePurchaseOrder(admin, SHOP, po.id);

    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already received/i);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(10);
  });

  it("falls back to the aggregate count when the shop has no locations", async () => {
    const { product } = await seed({ withLocation: false, stock: 1 });
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id);

    expect(result.ok).toBe(true);
    expect(result.locationScoped).toBe(false);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(11);
  });

  it("still receives when Shopify rejects the write, and reports it", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin({ failInventoryWrite: true });

    const result = await receivePurchaseOrder(admin, SHOP, po.id);

    // Local stock is the merchant's record of what physically arrived; a Shopify API
    // failure must not discard it. Surfaced as a warning instead.
    expect(result.ok).toBe(true);
    expect(result.shopifyWarnings.length).toBeGreaterThan(0);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(10);
  });

  it("cannot receive another shop's PO", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, OTHER_SHOP, po.id);

    expect(result.ok).toBe(false);
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(0);
  });

  it("receives once when two requests race", async () => {
    const { product } = await seed({ stock: 0 });
    const po = await createPo(product.id, { quantityOrdered: 10 });
    const { admin } = mockAdmin();

    // A double-submit. The status read at the top of receivePurchaseOrder cannot stop the
    // second caller — only the guarded status flip can.
    const results = await Promise.all([
      receivePurchaseOrder(admin, SHOP, po.id),
      receivePurchaseOrder(admin, SHOP, po.id),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    // 10, not 20.
    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.currentStock).toBe(10);
    const item = await prisma.purchaseOrderItem.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    expect(item.quantityReceived).toBe(10);
  });

  it("releases the claim when nothing could be received", async () => {
    const { product } = await seed({ stock: 2 });
    const po = await createPo(product.id, { quantityOrdered: 10, status: "sent" });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [po.items[0].id]: NaN },
    });
    expect(result.ok).toBe(false);

    // The PO must go back to `sent`, not sit in `received` with an empty receipt — that
    // would close the receipt path permanently for a delivery that never happened.
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.status).toBe("sent");
    expect(after.actualDeliveryDate).toBeNull();

    // And it must still be receivable afterwards.
    const retry = await receivePurchaseOrder(admin, SHOP, po.id);
    expect(retry.ok).toBe(true);
  });

  it("refuses a PO with no line items", async () => {
    await seed();
    const po = await prisma.purchaseOrder.create({
      data: { shop: SHOP, poNumber: "PO-EMPTY", status: "sent", totalCost: 0 },
    });
    const { admin } = mockAdmin();

    const result = await receivePurchaseOrder(admin, SHOP, po.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no line items/i);
  });
});

describe("parseReceivedQuantities", () => {
  it("omits absent fields so the caller's default applies", () => {
    const fd = new FormData();
    fd.set("received_a", "5");
    expect(parseReceivedQuantities(fd, ["a", "b"])).toEqual({ a: 5 });
  });

  it("yields NaN for unparseable input rather than dropping the field", () => {
    const fd = new FormData();
    fd.set("received_a", "abc");
    const parsed = parseReceivedQuantities(fd, ["a"]);
    expect("a" in parsed).toBe(true);
    expect(Number.isNaN(parsed.a)).toBe(true);
  });
});

describe("validateDraftLines", () => {
  it("accepts lines for products in this shop", async () => {
    const { product } = await seed();
    const r = await validateDraftLines(SHOP, [
      { productId: product.id, quantity: "5", unitCost: "250" },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.items).toEqual([{ productId: product.id, quantityOrdered: 5, unitCost: 250 }]);
  });

  it("rejects a product id belonging to another shop", async () => {
    const { product } = await seed();
    // The id is real and exists — it just is not this tenant's. Nothing stops a crafted
    // POST from naming it, so the server has to.
    const r = await validateDraftLines(OTHER_SHOP, [
      { productId: product.id, quantity: "5", unitCost: "250" },
    ]);
    expect(r.error).toMatch(/not in this shop/i);
    expect(r.items).toEqual([]);
  });

  it("rejects an id that exists nowhere", async () => {
    await seed();
    const r = await validateDraftLines(SHOP, [
      { productId: "gid://shopify/ProductVariant/nope", quantity: "1", unitCost: "0" },
    ]);
    expect(r.error).toMatch(/not in this shop/i);
  });

  it("rejects unparseable, zero and negative quantities", async () => {
    const { product } = await seed();
    for (const quantity of ["abc", "0", "-3", "", null]) {
      const r = await validateDraftLines(SHOP, [{ productId: product.id, quantity, unitCost: "1" }]);
      expect(r.error).toMatch(/quantity/i);
    }
  });

  it("rejects a negative unit cost but allows zero", async () => {
    const { product } = await seed();
    expect((await validateDraftLines(SHOP, [{ productId: product.id, quantity: "1", unitCost: "-5" }])).error)
      .toMatch(/unit cost/i);
    expect((await validateDraftLines(SHOP, [{ productId: product.id, quantity: "1", unitCost: "0" }])).error)
      .toBeUndefined();
  });

  it("defaults unit cost to zero when the caller omits it (transfers)", async () => {
    const { product } = await seed();
    const r = await validateDraftLines(SHOP, [{ productId: product.id, quantity: "4" }]);
    expect(r.error).toBeUndefined();
    expect(r.items[0]).toMatchObject({ quantityOrdered: 4, unitCost: 0 });
  });

  it("rejects an empty line set", async () => {
    expect((await validateDraftLines(SHOP, [])).error).toMatch(/at least one/i);
  });

  it("rejects the whole submission if any single line is foreign", async () => {
    const { product } = await seed();
    const r = await validateDraftLines(SHOP, [
      { productId: product.id, quantity: "1", unitCost: "1" },
      { productId: "gid://shopify/ProductVariant/foreign", quantity: "1", unitCost: "1" },
    ]);
    // All-or-nothing: silently dropping the bad line would create a PO the merchant did
    // not ask for.
    expect(r.error).toBeTruthy();
    expect(r.items).toEqual([]);
  });
});

describe("validateSupplierId", () => {
  it("passes through a supplier in this shop", async () => {
    const { supplier } = await seed();
    expect(await validateSupplierId(SHOP, supplier.id)).toEqual({ supplierId: supplier.id });
  });

  it("treats empty as no supplier", async () => {
    expect(await validateSupplierId(SHOP, null)).toEqual({ supplierId: null });
    expect(await validateSupplierId(SHOP, "")).toEqual({ supplierId: null });
  });

  it("rejects another shop's supplier", async () => {
    const { supplier } = await seed();
    const r = await validateSupplierId(OTHER_SHOP, supplier.id);
    expect(r.error).toMatch(/not in this shop/i);
    expect(r.supplierId).toBeNull();
  });
});
