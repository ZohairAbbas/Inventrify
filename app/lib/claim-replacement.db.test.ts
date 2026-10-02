/**
 * Phase 4 of supplier claims: replacement goods, emailed claims, and the supplier
 * scorecard.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

let sendResult: { data?: unknown; error?: { message: string } | null } = { data: { id: "test" }, error: null };
const sendSpy = vi.fn(async (_payload: Record<string, unknown>) => sendResult);
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendSpy };
  },
}));
process.env.RESEND_API_KEY = "test-key";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { receivePurchaseOrder, closePurchaseOrderRemainder } = await import("./purchase-order.server");
const { createSupplierClaim, resolveClaim } = await import("./supplier-claim.server");
const { getPoAccount, getSupplierStatement } = await import("./supplier-ledger.server");
const { getSupplierScorecard } = await import("./supplier-scorecard.server");
const { emailClaimToSupplier } = await import("./purchase-order-email.server");
const { getInventoryPositions } = await import("./planning.server");
const { default: prisma } = await import("../db.server");

const SHOP = "replacement-test.myshopify.com";

const admin = {
  graphql: async (query: string) => {
    const field = query.includes("moveInventory") ? "inventoryMoveQuantities" : "inventoryAdjustQuantities";
    return { status: 200, ok: true, json: async () => ({ data: { [field]: { userErrors: [] } } }) };
  },
} as unknown as AdminApiContext;

async function seed() {
  await prisma.shopSettings.create({ data: { shop: SHOP, currency: "PKR" } });
  const supplier = await prisma.supplier.create({
    data: { shop: SHOP, name: "Lahore Textiles", email: "orders@lahore.example", contactName: "Bilal" },
  });
  const product = await prisma.product.create({
    data: {
      id: "gid://shopify/ProductVariant/repl-1",
      shop: SHOP,
      productGid: "gid://shopify/Product/repl-1",
      inventoryItemId: "gid://shopify/InventoryItem/repl-1",
      title: "Kurta",
      sku: "KUR-1",
    },
  });
  const location = await prisma.location.create({
    data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/1", name: "Karachi WH" },
  });
  await prisma.productLocationStock.create({ data: { shop: SHOP, productId: product.id, locationId: location.id, onHand: 0 } });
  return { supplier, product };
}

async function createPo(productId: string, supplierId: string, opts: { expected?: Date } = {}) {
  return prisma.purchaseOrder.create({
    data: {
      shop: SHOP,
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      status: "sent",
      supplierId,
      sentAt: new Date("2026-07-01T00:00:00Z"),
      expectedDeliveryDate: opts.expected ?? null,
      items: { create: [{ productId, quantityOrdered: 10, unitCost: 250 }] },
    },
    include: { items: true },
  });
}

/** Receive a PO in full with `damaged` units, and return the claim opened for them. */
async function damagedDelivery(productId: string, supplierId: string, damaged: number) {
  const po = await createPo(productId, supplierId);
  const itemId = po.items[0].id;
  const r = await receivePurchaseOrder(admin, SHOP, po.id, {
    quantities: { [itemId]: 10 },
    damaged: { [itemId]: damaged },
    actualDeliveryDate: new Date("2026-07-09T00:00:00Z"),
  });
  const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: r.claimId } });
  return { po, claimId: r.claimId!, line };
}

beforeEach(async () => {
  sendSpy.mockClear();
  sendResult = { data: { id: "test" }, error: null };
  await prisma.supplierLedgerEntry.deleteMany({ where: { shop: SHOP } });
  // Replacement POs point at claims; unlink before the claims go.
  await prisma.purchaseOrder.updateMany({ where: { shop: SHOP }, data: { replacesClaimId: null } });
  await prisma.supplierClaimLine.deleteMany({ where: { claim: { shop: SHOP } } });
  await prisma.supplierClaim.deleteMany({ where: { shop: SHOP } });
  await prisma.purchaseOrderReceipt.deleteMany({ where: { shop: SHOP } });
  await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop: SHOP } } });
  await prisma.purchaseOrder.deleteMany({ where: { shop: SHOP } });
  await prisma.productLocationStock.deleteMany({ where: { shop: SHOP } });
  await prisma.product.deleteMany({ where: { shop: SHOP } });
  await prisma.location.deleteMany({ where: { shop: SHOP } });
  await prisma.supplier.deleteMany({ where: { shop: SHOP } });
  await prisma.shopSettings.deleteMany({ where: { shop: SHOP } });
});

describe("replacements", () => {
  it("raises a free, linked replacement PO that counts as incoming stock — and posts no credit", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);

    const result = await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 3, remedy: "replacement" }]);

    expect(result.ok).toBe(true);
    const replacement = await prisma.purchaseOrder.findUniqueOrThrow({
      where: { id: result.replacementPoId! },
      include: { items: true },
    });
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(replacement).toMatchObject({ status: "sent", supplierId: supplier.id, replacesClaimId: claimId, totalCost: 0 });
    expect(replacement.poNumber).toBe(`${claim.claimNumber}-R`);
    expect(replacement.items[0]).toMatchObject({ quantityOrdered: 3, unitCost: 0, replacesClaimLineId: line.id });

    const after = await prisma.supplierClaimLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(after).toMatchObject({ remedy: "replacement", creditAmount: 0, decision: "accepted" });
    expect(await prisma.supplierLedgerEntry.count({ where: { shop: SHOP, type: "credit_note" } })).toBe(0);
    expect((await getInventoryPositions(SHOP, [product.id])).get(product.id)?.onOrder).toBe(3);
  });

  it("credits some lines and replaces others in one decision", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);
    await receivePurchaseOrder(admin, SHOP, po.id);
    const c = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "defective", quantity: 2, stockSource: "none" }],
    });
    const c2 = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "damaged", quantity: 1, stockSource: "none" }],
    });
    const [l1] = await prisma.supplierClaimLine.findMany({ where: { claimId: c.claimId } });
    const [l2] = await prisma.supplierClaimLine.findMany({ where: { claimId: c2.claimId } });

    await resolveClaim(SHOP, c.claimId!, [{ lineId: l1.id, quantityAccepted: 2, remedy: "credit" }]);
    const r2 = await resolveClaim(SHOP, c2.claimId!, [{ lineId: l2.id, quantityAccepted: 1, remedy: "replacement" }]);

    expect((await getPoAccount(SHOP, po.id)).credited).toBe(500);
    expect(r2.replacementPoId).toBeTruthy();
  });

  it("is received free of charge and does not count toward lead time", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    const { replacementPoId } = await resolveClaim(SHOP, claimId, [
      { lineId: line.id, quantityAccepted: 3, remedy: "replacement" },
    ]);
    const before = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });

    const r = await receivePurchaseOrder(admin, SHOP, replacementPoId!, { actualDeliveryDate: new Date("2026-08-20T00:00:00Z") });

    expect(r.status).toBe("received");
    expect((await getPoAccount(SHOP, replacementPoId!)).billed).toBe(0);
    const after = await prisma.supplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(after.totalPosReceived).toBe(before.totalPosReceived);
    expect(after.avgActualLeadTime).toBe(before.avgActualLeadTime);
  });

  it("values a claim on damaged replacements at the original cost", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    const { replacementPoId } = await resolveClaim(SHOP, claimId, [
      { lineId: line.id, quantityAccepted: 3, remedy: "replacement" },
    ]);
    const replacement = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: replacementPoId! }, include: { items: true } });

    const r = await receivePurchaseOrder(admin, SHOP, replacementPoId!, {
      quantities: { [replacement.items[0].id]: 3 },
      damaged: { [replacement.items[0].id]: 1 },
    });

    const again = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: r.claimId } });
    expect(again.unitCost).toBe(250);
  });

  it("credits undelivered replacements at the original cost when closed short, instead of claiming them", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    const { replacementPoId } = await resolveClaim(SHOP, claimId, [
      { lineId: line.id, quantityAccepted: 3, remedy: "replacement" },
    ]);
    const replacement = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: replacementPoId! }, include: { items: true } });
    await receivePurchaseOrder(admin, SHOP, replacementPoId!, { quantities: { [replacement.items[0].id]: 1 } });

    const closed = await closePurchaseOrderRemainder(SHOP, replacementPoId!, { claimMissing: true });

    expect(closed.ok).toBe(true);
    expect(closed.claimId).toBeUndefined();
    expect(await getPoAccount(SHOP, replacementPoId!)).toMatchObject({ credited: 500, net: -500 });
    // Original delivery billed 2500; the 2 replacements that never came are owed back.
    expect((await getSupplierStatement(SHOP, supplier.id)).balance).toBe(2000);
  });

  it("does the same when the short close happens while receiving", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    const { replacementPoId } = await resolveClaim(SHOP, claimId, [
      { lineId: line.id, quantityAccepted: 3, remedy: "replacement" },
    ]);
    const replacement = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: replacementPoId! }, include: { items: true } });

    const r = await receivePurchaseOrder(admin, SHOP, replacementPoId!, {
      quantities: { [replacement.items[0].id]: 2 },
      closeRemaining: true,
      claimMissing: true,
    });

    expect(r.claimId).toBeUndefined();
    expect((await getPoAccount(SHOP, replacementPoId!)).credited).toBe(250);
  });
});

describe("emailClaimToSupplier", () => {
  it("emails the claim, records it, and marks an open claim as sent", async () => {
    const { supplier, product } = await seed();
    const { claimId } = await damagedDelivery(product.id, supplier.id, 3);

    const result = await emailClaimToSupplier(claimId, SHOP);

    expect(result).toEqual({ ok: true, emailedTo: "orders@lahore.example" });
    const payload = sendSpy.mock.calls[0][0] as { to: string; subject: string; html: string };
    expect(payload.subject).toMatch(/3 units/);
    expect(payload.html).toContain("Damaged");
    expect(payload.html).toContain("KUR-1");
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim).toMatchObject({ status: "submitted", emailedTo: "orders@lahore.example" });
    expect(claim.submittedAt).not.toBeNull();
  });

  it("records nothing when the provider rejects the message", async () => {
    const { supplier, product } = await seed();
    const { claimId } = await damagedDelivery(product.id, supplier.id, 3);
    sendResult = { error: { message: "Domain not verified" } };

    const result = await emailClaimToSupplier(claimId, SHOP);

    expect(result.ok).toBe(false);
    const claim = await prisma.supplierClaim.findUniqueOrThrow({ where: { id: claimId } });
    expect(claim).toMatchObject({ status: "open", emailedAt: null });
  });

  it("refuses a supplier without an email, and a resolved claim", async () => {
    const { supplier, product } = await seed();
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    await prisma.supplier.update({ where: { id: supplier.id }, data: { email: null } });
    expect((await emailClaimToSupplier(claimId, SHOP)).error).toMatch(/no email address/);

    await resolveClaim(SHOP, claimId, [{ lineId: line.id, quantityAccepted: 0 }]);
    expect((await emailClaimToSupplier(claimId, SHOP)).error).toMatch(/already resolved/);
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

describe("getSupplierScorecard", () => {
  it("reports unknown rather than zero when there is nothing to measure", async () => {
    const { supplier } = await seed();
    const card = await getSupplierScorecard(SHOP, supplier.id);
    expect(card).toMatchObject({ fillRate: null, onTimeRate: null, defectRate: null, acceptanceRate: null, avgDaysToResolve: null });
  });

  it("measures fill, punctuality, defects and claims — ignoring replacement POs", async () => {
    const { supplier, product } = await seed();
    // PO 1: on time (due 07-10, first delivery 07-09), 10 of 10, 3 damaged -> replaced.
    const { claimId, line } = await damagedDelivery(product.id, supplier.id, 3);
    await prisma.purchaseOrder.updateMany({
      where: { shop: SHOP, replacesClaimId: null },
      data: { expectedDeliveryDate: new Date("2026-07-10T00:00:00Z") },
    });
    await prisma.supplierClaim.update({ where: { id: claimId }, data: { createdAt: new Date(Date.now() - 4 * 86_400_000) } });
    const { replacementPoId } = await resolveClaim(SHOP, claimId, [
      { lineId: line.id, quantityAccepted: 2, remedy: "replacement" },
    ]);

    // PO 2: late (due 07-01), 6 of 10 then closed short.
    const late = await createPo(product.id, supplier.id, { expected: new Date("2026-07-01T00:00:00Z") });
    await receivePurchaseOrder(admin, SHOP, late.id, {
      quantities: { [late.items[0].id]: 6 },
      closeRemaining: true,
      actualDeliveryDate: new Date("2026-07-05T00:00:00Z"),
    });

    const card = await getSupplierScorecard(SHOP, supplier.id);

    expect(card.finishedPos).toBe(2); // the open replacement PO is not counted
    expect(card.fillRate).toBeCloseTo(16 / 20);
    expect(card.onTimeRate).toBe(0.5);
    expect(card.defectRate).toBeCloseTo(3 / 16);
    expect(card.acceptanceRate).toBeCloseTo(2 / 3);
    expect(card.avgDaysToResolve).toBeCloseTo(4, 0);
    expect(card.replacementsOutstanding).toBe(2);
    expect(replacementPoId).toBeTruthy();
  });
});
