/**
 * Supplier claims: damaged units at receipt, missing units on a short close, problems
 * found after receipt, what happens to quarantined stock, and the supplier's decision.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 *
 * The admin client is a stub that records every inventory mutation, so the Shopify half
 * of each quarantine movement can be asserted on without credentials.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { receivePurchaseOrder, closePurchaseOrderRemainder } = await import("./purchase-order.server");
const { createSupplierClaim, disposeClaimLine, resolveClaim, submitClaim, getSupplierClaimSummary } = await import(
  "./supplier-claim.server"
);
const { default: prisma } = await import("../db.server");

const SHOP = "claim-test.myshopify.com";
const OTHER_SHOP = "other-claim-test.myshopify.com";

interface Recorded {
  kind: "adjust" | "move";
  name?: string;
  input: Record<string, unknown>;
}

function mockAdmin() {
  const calls: Recorded[] = [];
  const admin = {
    graphql: async (query: string, o?: { variables?: Record<string, unknown> }) => {
      const input = (o?.variables?.input ?? {}) as Record<string, unknown>;
      if (query.includes("adjustInventory")) {
        calls.push({ kind: "adjust", name: input.name as string, input });
        return { status: 200, ok: true, json: async () => ({ data: { inventoryAdjustQuantities: { userErrors: [] } } }) };
      }
      if (query.includes("moveInventory")) {
        calls.push({ kind: "move", input });
        return { status: 200, ok: true, json: async () => ({ data: { inventoryMoveQuantities: { userErrors: [] } } }) };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ data: { locations: { edges: [{ node: { id: "gid://shopify/Location/1" } }] } } }),
      };
    },
  } as unknown as AdminApiContext;
  return { admin, calls };
}

async function seed(opts: { stock?: number } = {}) {
  const supplier = await prisma.supplier.create({ data: { shop: SHOP, name: "Lahore Textiles" } });
  const product = await prisma.product.create({
    data: {
      id: "gid://shopify/ProductVariant/claim-1",
      shop: SHOP,
      productGid: "gid://shopify/Product/claim-1",
      inventoryItemId: "gid://shopify/InventoryItem/claim-1",
      title: "Kurta",
      currentStock: opts.stock ?? 0,
      unitCost: 999, // deliberately different from the PO line's cost
    },
  });
  const location = await prisma.location.create({
    data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/1", name: "Karachi WH" },
  });
  await prisma.productLocationStock.create({
    data: { shop: SHOP, productId: product.id, locationId: location.id, onHand: opts.stock ?? 0 },
  });
  return { supplier, product, location };
}

async function createPo(
  productId: string,
  supplierId: string,
  opts: { status?: string; ordered?: number; received?: number; cancelled?: number } = {},
) {
  return prisma.purchaseOrder.create({
    data: {
      shop: SHOP,
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      status: opts.status ?? "sent",
      supplierId,
      sentAt: new Date("2026-07-01T00:00:00Z"),
      items: {
        create: [
          {
            productId,
            quantityOrdered: opts.ordered ?? 10,
            quantityReceived: opts.received ?? 0,
            quantityCancelled: opts.cancelled ?? 0,
            unitCost: 250,
          },
        ],
      },
    },
    include: { items: true },
  });
}

async function level(productId: string, locationId: string) {
  return prisma.productLocationStock.findUniqueOrThrow({
    where: { productId_locationId: { productId, locationId } },
  });
}

beforeEach(async () => {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.supplierClaimLine.deleteMany({ where: { claim: { shop } } });
    await prisma.supplierClaim.deleteMany({ where: { shop } });
    await prisma.purchaseOrderReceipt.deleteMany({ where: { shop } });
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop } } });
    await prisma.purchaseOrder.deleteMany({ where: { shop } });
    await prisma.productLocationStock.deleteMany({ where: { shop } });
    await prisma.product.deleteMany({ where: { shop } });
    await prisma.location.deleteMany({ where: { shop } });
    await prisma.supplier.deleteMany({ where: { shop } });
  }
});

describe("damaged units at receipt", () => {
  it("receives them but quarantines them, and opens a claim", async () => {
    const { product, location, supplier } = await seed();
    const po = await createPo(product.id, supplier.id);
    const { admin, calls } = mockAdmin();
    const itemId = po.items[0].id;

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [itemId]: 10 },
      damaged: { [itemId]: 3 },
    });

    expect(result.ok).toBe(true);
    // They arrived, so the PO is complete — the supplier owes a claim, not a delivery.
    expect(result.status).toBe("received");
    expect(result.claimId).toBeTruthy();

    const l = await level(product.id, location.id);
    expect(l.onHand).toBe(7);
    expect(l.damaged).toBe(3);
    const p = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(p.currentStock).toBe(7);

    const receipt = await prisma.purchaseOrderReceipt.findFirstOrThrow({
      where: { purchaseOrderId: po.id },
      include: { lines: true },
    });
    expect(receipt.lines[0]).toMatchObject({ quantity: 10, quantityDamaged: 3 });

    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: result.claimId! }, include: { lines: true } });
    expect(claim.supplierId).toBe(supplier.id);
    expect(claim.claimNumber).toBe(`${po.poNumber}-C1`);
    expect(claim.lines[0]).toMatchObject({
      type: "damaged",
      quantity: 3,
      stockSource: "receipt",
      locationId: location.id,
      unitCost: 250, // the PO line's cost, not Product.unitCost
    });

    // Shopify: 7 into available, 3 into damaged with a ledger reference.
    const available = calls.find((c) => c.kind === "adjust" && c.name === "available");
    const damaged = calls.find((c) => c.kind === "adjust" && c.name === "damaged");
    expect((available?.input.changes as { delta: number }[])[0].delta).toBe(7);
    const dChange = (damaged?.input.changes as { delta: number; ledgerDocumentUri: string }[])[0];
    expect(dChange.delta).toBe(3);
    expect(dChange.ledgerDocumentUri).toBe(`gid://inventorify/PurchaseOrder/${po.id}`);
  });

  it("refuses more damaged units than arrived in the delivery", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, supplier.id);
    const { admin, calls } = mockAdmin();
    const itemId = po.items[0].id;

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [itemId]: 4 },
      damaged: { [itemId]: 5 },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most 4/);
    expect(calls).toHaveLength(0);
    expect(await prisma.supplierClaim.count({ where: { shop: SHOP } })).toBe(0);
  });
});

describe("missing units on a short close", () => {
  it("claims the cancelled remainder when asked, without touching stock", async () => {
    const { product, location, supplier } = await seed();
    const po = await createPo(product.id, supplier.id);
    const { admin } = mockAdmin();
    const itemId = po.items[0].id;

    const result = await receivePurchaseOrder(admin, SHOP, po.id, {
      quantities: { [itemId]: 7 },
      closeRemaining: true,
      claimMissing: true,
    });

    expect(result.status).toBe("closed");
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: result.claimId! }, include: { lines: true } });
    expect(claim.lines[0]).toMatchObject({ type: "missing", quantity: 3, stockSource: "none" });
    expect((await level(product.id, location.id)).onHand).toBe(7);
  });

  it("does the same from Close remaining on a partially received PO", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, supplier.id, { status: "partially_received", received: 6 });

    const result = await closePurchaseOrderRemainder(SHOP, po.id, { claimMissing: true });

    expect(result.ok).toBe(true);
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: result.claimId! }, include: { lines: true } });
    expect(claim.lines[0]).toMatchObject({ type: "missing", quantity: 4, stockSource: "none" });
  });

  it("opens no claim when the merchant does not ask for one", async () => {
    const { product, supplier } = await seed();
    const po = await createPo(product.id, supplier.id, { status: "partially_received", received: 6 });

    const result = await closePurchaseOrderRemainder(SHOP, po.id);
    expect(result.claimId).toBeUndefined();
    expect(await prisma.supplierClaim.count({ where: { shop: SHOP } })).toBe(0);
  });
});

describe("createSupplierClaim (found after receipt)", () => {
  async function receivedPo(stock = 10) {
    const seeded = await seed({ stock });
    const po = await createPo(seeded.product.id, seeded.supplier.id, { status: "received", received: 10 });
    return { ...seeded, po, itemId: po.items[0].id };
  }

  it("moves damaged units from sellable stock into quarantine", async () => {
    const { product, location, po, itemId } = await receivedPo();
    const { admin, calls } = mockAdmin();

    const result = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "defective", quantity: 4, stockSource: "on_hand" }],
    });

    expect(result.ok).toBe(true);
    const l = await level(product.id, location.id);
    expect(l.onHand).toBe(6);
    expect(l.damaged).toBe(4);
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("move");
    const change = (calls[0].input.changes as Record<string, { name: string; ledgerDocumentUri: string | null }>[])[0];
    expect(change.from.name).toBe("available");
    expect(change.to.name).toBe("damaged");
    expect(change.to.ledgerDocumentUri).toBe(`gid://inventorify/SupplierClaim/${result.claimId}`);
  });

  it("removes missing units from stock", async () => {
    const { product, location, po, itemId } = await receivedPo();
    const { admin, calls } = mockAdmin();

    await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "missing", quantity: 2, stockSource: "on_hand" }],
    });

    const l = await level(product.id, location.id);
    expect(l.onHand).toBe(8);
    expect(l.damaged).toBe(0);
    expect(calls[0]).toMatchObject({ kind: "adjust", name: "available" });
    expect((calls[0].input.changes as { delta: number }[])[0].delta).toBe(-2);
  });

  it("records units no longer in stock without moving anything", async () => {
    const { product, location, po, itemId } = await receivedPo();
    const { admin, calls } = mockAdmin();

    const result = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "defective", quantity: 2, stockSource: "none" }],
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect((await level(product.id, location.id)).onHand).toBe(10);
  });

  it("cannot claim more than was received, across claims", async () => {
    const { po, itemId } = await receivedPo();
    const { admin } = mockAdmin();

    const first = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "damaged", quantity: 7, stockSource: "none" }],
    });
    const second = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "damaged", quantity: 4, stockSource: "none" }],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/only 3 more/);
  });

  it("cannot claim undelivered units on a line where nothing was cancelled", async () => {
    const { po, itemId } = await receivedPo();
    const { admin } = mockAdmin();

    const result = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "missing", quantity: 1, stockSource: "none" }],
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/nothing was cancelled/);
  });

  it("rolls back the whole claim when the shelf does not hold the units", async () => {
    const { product, location, po, itemId } = await receivedPo(3);
    const { admin, calls } = mockAdmin();

    const result = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: itemId, type: "damaged", quantity: 5, stockSource: "on_hand" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 3 in sellable stock/);
    expect(await prisma.supplierClaim.count({ where: { shop: SHOP } })).toBe(0);
    expect((await level(product.id, location.id)).onHand).toBe(3);
    expect(calls).toHaveLength(0);
  });

  it("claims once when two claims for the same units race", async () => {
    const { po, itemId } = await receivedPo();
    const { admin } = mockAdmin();
    const input = { lines: [{ purchaseOrderItemId: itemId, type: "damaged", quantity: 10, stockSource: "on_hand" }] };

    const results = await Promise.all([
      createSupplierClaim(admin, SHOP, po.id, input),
      createSupplierClaim(admin, SHOP, po.id, input),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lines = await prisma.supplierClaimLine.findMany({ where: { claim: { shop: SHOP } } });
    expect(lines.reduce((s, l) => s + l.quantity, 0)).toBe(10);
  });

  it("refuses a PO with nothing received, and another shop's PO", async () => {
    const { product, supplier } = await seed();
    const sent = await createPo(product.id, supplier.id, { status: "sent" });
    const { admin } = mockAdmin();
    const line = { purchaseOrderItemId: sent.items[0].id, type: "damaged", quantity: 1, stockSource: "none" };

    expect((await createSupplierClaim(admin, SHOP, sent.id, { lines: [line] })).error).toMatch(/nothing has been received/i);
    expect((await createSupplierClaim(admin, OTHER_SHOP, sent.id, { lines: [line] })).error).toMatch(/not found/i);
  });
});

describe("disposeClaimLine", () => {
  async function quarantined() {
    const seeded = await seed({ stock: 10 });
    const po = await createPo(seeded.product.id, seeded.supplier.id, { status: "received", received: 10 });
    const { admin } = mockAdmin();
    const res = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "damaged", quantity: 4, stockSource: "on_hand" }],
    });
    const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: res.claimId } });
    return { ...seeded, po, line, claimId: res.claimId! };
  }

  it("writes off and returns quarantined units, removing them from on-hand", async () => {
    const { product, location, line } = await quarantined();
    const { admin, calls } = mockAdmin();

    expect((await disposeClaimLine(admin, SHOP, line.id, "write_off", 1)).ok).toBe(true);
    expect((await disposeClaimLine(admin, SHOP, line.id, "return_to_vendor", 2)).ok).toBe(true);

    const l = await level(product.id, location.id);
    expect(l.damaged).toBe(1);
    expect(l.onHand).toBe(6);
    expect(calls.every((c) => c.kind === "adjust" && c.name === "damaged")).toBe(true);
    const after = await prisma.supplierClaimLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ quantityWrittenOff: 1, quantityReturned: 2 });
  });

  it("restocks units that turned out sellable", async () => {
    const { product, location, line } = await quarantined();
    const { admin, calls } = mockAdmin();

    await disposeClaimLine(admin, SHOP, line.id, "restock", 3);

    const l = await level(product.id, location.id);
    expect(l.onHand).toBe(9);
    expect(l.damaged).toBe(1);
    expect(calls[0].kind).toBe("move");
  });

  it("refuses to dispose of more than is in quarantine", async () => {
    const { line } = await quarantined();
    const { admin } = mockAdmin();

    await disposeClaimLine(admin, SHOP, line.id, "write_off", 3);
    const result = await disposeClaimLine(admin, SHOP, line.id, "return_to_vendor", 2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 1 unit is in quarantine/i);
  });

  it("puts found units back and stops claiming them, until the supplier has decided", async () => {
    const { product, location, supplier } = await seed({ stock: 10 });
    const po = await createPo(product.id, supplier.id, { status: "received", received: 10 });
    const { admin } = mockAdmin();
    const res = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "missing", quantity: 3, stockSource: "on_hand" }],
    });
    const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: res.claimId } });

    expect((await disposeClaimLine(admin, SHOP, line.id, "found", 1)).ok).toBe(true);
    expect((await level(product.id, location.id)).onHand).toBe(8);

    // Accepting more than is still claimed (2) is refused.
    expect((await resolveClaim(SHOP, res.claimId!, [{ lineId: line.id, quantityAccepted: 3 }])).ok).toBe(false);
    expect((await resolveClaim(SHOP, res.claimId!, [{ lineId: line.id, quantityAccepted: 2 }])).ok).toBe(true);

    const late = await disposeClaimLine(admin, SHOP, line.id, "found", 1);
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/already decided/);
  });

  it("cannot touch another shop's claim line", async () => {
    const { line } = await quarantined();
    const { admin } = mockAdmin();
    expect((await disposeClaimLine(admin, OTHER_SHOP, line.id, "write_off", 1)).ok).toBe(false);
  });
});

describe("resolveClaim", () => {
  async function openClaimWithTwoUnits() {
    const { product, supplier } = await seed({ stock: 10 });
    const po = await createPo(product.id, supplier.id, { status: "received", received: 10 });
    const { admin } = mockAdmin();
    const res = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "damaged", quantity: 4, stockSource: "on_hand" }],
    });
    const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: res.claimId } });
    return { claimId: res.claimId!, line, supplier, admin };
  }

  it("defaults the credit to accepted units at the PO line's cost", async () => {
    const { claimId, line } = await openClaimWithTwoUnits();
    expect((await submitClaim(SHOP, claimId)).ok).toBe(true);

    const result = await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 3 }]);

    expect(result.ok).toBe(true);
    const after = await prisma.supplierClaimLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ decision: "partially_accepted", quantityAccepted: 3, creditAmount: 750 });
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim.status).toBe("resolved");
    expect(claim.submittedAt).not.toBeNull();
  });

  it("takes a negotiated credit, and records a rejection", async () => {
    const { claimId, line } = await openClaimWithTwoUnits();
    await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 0, creditAmount: 0 }]);
    const after = await prisma.supplierClaimLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ decision: "rejected", creditAmount: 0 });
  });

  it("refuses a second resolution and impossible quantities", async () => {
    const { claimId, line } = await openClaimWithTwoUnits();
    expect((await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 5 }])).error).toMatch(/between 0 and 4/);
    expect((await resolveClaim(SHOP, claimId, [])).error).toMatch(/every line/);
    await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 4 }]);
    expect((await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 4 }])).error).toMatch(/already resolved/);
  });

  it("summarises supplier-attributed vs merchant-absorbed damage per supplier", async () => {
    const { claimId, line, supplier, admin } = await openClaimWithTwoUnits();
    await disposeClaimLine(admin, SHOP, line.id, "restock", 1);
    await disposeClaimLine(admin, SHOP, line.id, "write_off", 2);
    await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 2 }]);

    const summary = await getSupplierClaimSummary(SHOP, supplier.id);
    // 4 claimed, 2 accepted, 1 restocked (no loss) -> 1 absorbed; 1 still quarantined.
    expect(summary).toMatchObject({
      openClaims: 0,
      unitsClaimed: 4,
      unitsAccepted: 2,
      damagedAbsorbed: 1,
      quarantined: 1,
      creditAgreed: 500,
    });
  });
});
