/**
 * Supplier ledger: automatic bills and credits, manual payments, reversals, and the
 * balance they add up to — for merchants who pay in advance and for those who pay on
 * delivery.
 *
 * Needs a scratch database; see the header of alert-dispatch.db.test.ts.
 *   npm run test:db
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

if (!/_test(\?|$)/.test(process.env.DATABASE_URL ?? "")) {
  throw new Error("Refusing to run: DATABASE_URL must point at a `*_test` database.");
}

const { receivePurchaseOrder, closePurchaseOrderRemainder } = await import("./purchase-order.server");
const { createSupplierClaim, resolveClaim } = await import("./supplier-claim.server");
const { recordLedgerEntry, reverseLedgerEntry, getSupplierStatement, getPoAccount, postReceiptBill } = await import(
  "./supplier-ledger.server"
);
const { default: prisma } = await import("../db.server");

const SHOP = "ledger-test.myshopify.com";
const OTHER_SHOP = "other-ledger-test.myshopify.com";

const admin = {
  graphql: async (query: string) => {
    const field = query.includes("moveInventory") ? "inventoryMoveQuantities" : "inventoryAdjustQuantities";
    return { status: 200, ok: true, json: async () => ({ data: { [field]: { userErrors: [] } } }) };
  },
} as unknown as AdminApiContext;

async function seed() {
  await prisma.shopSettings.create({ data: { shop: SHOP, currency: "PKR" } });
  const supplier = await prisma.supplier.create({ data: { shop: SHOP, name: "Lahore Textiles" } });
  const product = await prisma.product.create({
    data: {
      id: "gid://shopify/ProductVariant/ledger-1",
      shop: SHOP,
      productGid: "gid://shopify/Product/ledger-1",
      inventoryItemId: "gid://shopify/InventoryItem/ledger-1",
      title: "Kurta",
    },
  });
  const location = await prisma.location.create({
    data: { shop: SHOP, shopifyLocationId: "gid://shopify/Location/1", name: "Karachi WH" },
  });
  await prisma.productLocationStock.create({ data: { shop: SHOP, productId: product.id, locationId: location.id, onHand: 0 } });
  return { supplier, product };
}

async function createPo(productId: string, supplierId: string | null, opts: { status?: string; received?: number } = {}) {
  return prisma.purchaseOrder.create({
    data: {
      shop: SHOP,
      poNumber: `PO-${Math.random().toString(36).slice(2, 8)}`,
      status: opts.status ?? "sent",
      supplierId,
      totalCost: 2500,
      items: { create: [{ productId, quantityOrdered: 10, quantityReceived: opts.received ?? 0, unitCost: 250 }] },
    },
    include: { items: true },
  });
}

const balanceOf = async (supplierId: string) => (await getSupplierStatement(SHOP, supplierId)).balance;

beforeEach(async () => {
  for (const shop of [SHOP, OTHER_SHOP]) {
    await prisma.supplierLedgerEntry.deleteMany({ where: { shop } });
    await prisma.supplierClaimLine.deleteMany({ where: { claim: { shop } } });
    await prisma.supplierClaim.deleteMany({ where: { shop } });
    await prisma.purchaseOrderReceipt.deleteMany({ where: { shop } });
    await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { shop } } });
    await prisma.purchaseOrder.deleteMany({ where: { shop } });
    await prisma.productLocationStock.deleteMany({ where: { shop } });
    await prisma.product.deleteMany({ where: { shop } });
    await prisma.location.deleteMany({ where: { shop } });
    await prisma.supplier.deleteMany({ where: { shop } });
    await prisma.shopSettings.deleteMany({ where: { shop } });
  }
});

describe("automatic bills", () => {
  it("bills each delivery at the PO line's cost, damaged units included", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);
    const itemId = po.items[0].id;

    await receivePurchaseOrder(admin, SHOP, po.id, { quantities: { [itemId]: 6 }, damaged: { [itemId]: 2 } });
    await receivePurchaseOrder(admin, SHOP, po.id, { quantities: { [itemId]: 10 } });

    const entries = await prisma.supplierLedgerEntry.findMany({ where: { shop: SHOP }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => [e.type, e.amount.toNumber(), e.currency])).toEqual([
      ["bill", 1500, "PKR"],
      ["bill", 1000, "PKR"],
    ]);
    expect(await balanceOf(supplier.id)).toBe(2500);
  });

  it("bills nothing for a PO with no supplier", async () => {
    const { product } = await seed();
    const po = await createPo(product.id, null);
    await receivePurchaseOrder(admin, SHOP, po.id);
    expect(await prisma.supplierLedgerEntry.count({ where: { shop: SHOP } })).toBe(0);
  });

  it("never bills the same receipt twice", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);
    await receivePurchaseOrder(admin, SHOP, po.id);
    const receipt = await prisma.purchaseOrderReceipt.findFirstOrThrow({ where: { purchaseOrderId: po.id } });

    // A retry of the posting itself, inside a transaction — it must neither duplicate nor
    // abort the transaction it runs in.
    await prisma.$transaction(async (tx) => {
      await postReceiptBill(tx, {
        shop: SHOP,
        supplierId: supplier.id,
        purchaseOrderId: po.id,
        poNumber: po.poNumber,
        receiptId: receipt.id,
        receivedAt: new Date(),
        lines: [{ quantity: 10, unitCost: 250 }],
      });
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { notes: "still committed" } });
    });

    expect(await prisma.supplierLedgerEntry.count({ where: { shop: SHOP } })).toBe(1);
    const after = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(after.notes).toBe("still committed");
  });
});

describe("paying in advance vs on delivery", () => {
  it("advance payment runs negative until the goods arrive, then settles", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);

    await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 2500, purchaseOrderId: po.id });
    expect(await balanceOf(supplier.id)).toBe(-2500);

    await receivePurchaseOrder(admin, SHOP, po.id);
    expect(await balanceOf(supplier.id)).toBe(0);
    expect(await getPoAccount(SHOP, po.id)).toMatchObject({ billed: 2500, paid: 2500, net: 0 });
  });

  it("an advance on a short delivery leaves the supplier owing the difference", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);

    await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 2500, purchaseOrderId: po.id });
    await receivePurchaseOrder(admin, SHOP, po.id, { quantities: { [po.items[0].id]: 8 }, closeRemaining: true });

    // Paid for 10, received and billed 8: the supplier owes 500 back.
    expect(await balanceOf(supplier.id)).toBe(-500);
  });

  it("pay on delivery: owed after receipt, settled by payment", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);

    await receivePurchaseOrder(admin, SHOP, po.id);
    expect(await balanceOf(supplier.id)).toBe(2500);
    await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 2500 });
    expect(await balanceOf(supplier.id)).toBe(0);
  });
});

describe("claims on the account", () => {
  it("credits a resolved claim with the agreed amount", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);
    const itemId = po.items[0].id;
    const r = await receivePurchaseOrder(admin, SHOP, po.id, { quantities: { [itemId]: 10 }, damaged: { [itemId]: 4 } });
    const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: r.claimId } });

    await resolveClaim(SHOP, r.claimId!, [{ lineId: line.id, quantityAccepted: 4 }]);

    // Billed 10 × 250, credited 4 × 250.
    expect(await balanceOf(supplier.id)).toBe(1500);
    expect(await getPoAccount(SHOP, po.id)).toMatchObject({ billed: 2500, credited: 1000, net: 1500 });
  });

  it("posts no credit note for a rejected claim", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id, { status: "received", received: 10 });
    const c = await createSupplierClaim(admin, SHOP, po.id, {
      lines: [{ purchaseOrderItemId: po.items[0].id, type: "defective", quantity: 2, stockSource: "none" }],
    });
    const line = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: c.claimId } });

    await resolveClaim(SHOP, c.claimId!, [{ lineId: line.id, quantityAccepted: 0 }]);
    expect(await prisma.supplierLedgerEntry.count({ where: { shop: SHOP, type: "credit_note" } })).toBe(0);
  });

  it("bills invoiced-but-undelivered units, so an accepted claim nets to zero and a rejected one stays owed", async () => {
    const { supplier, product } = await seed();
    const accepted = await createPo(product.id, supplier.id, { status: "partially_received", received: 7 });
    const rejected = await createPo(product.id, supplier.id, { status: "partially_received", received: 7 });

    const a = await closePurchaseOrderRemainder(SHOP, accepted.id, { claimMissing: true });
    const b = await closePurchaseOrderRemainder(SHOP, rejected.id, { claimMissing: true });
    const aLine = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: a.claimId } });
    const bLine = await prisma.supplierClaimLine.findFirstOrThrow({ where: { claimId: b.claimId } });

    await resolveClaim(SHOP, a.claimId!, [{ lineId: aLine.id, quantityAccepted: 3 }]);
    await resolveClaim(SHOP, b.claimId!, [{ lineId: bLine.id, quantityAccepted: 0 }]);

    expect((await getPoAccount(SHOP, accepted.id)).net).toBe(0);
    expect((await getPoAccount(SHOP, rejected.id)).net).toBe(750);
  });
});

describe("manual entries and reversals", () => {
  it("validates amounts, adjustment direction, and ownership", async () => {
    const { supplier, product } = await seed();
    const other = await prisma.supplier.create({ data: { shop: SHOP, name: "Faisalabad Mills" } });
    const othersPo = await createPo(product.id, other.id);

    expect((await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 0 })).error).toMatch(/greater than zero/);
    expect((await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: -5 })).error).toMatch(/greater than zero/);
    expect((await recordLedgerEntry(SHOP, supplier.id, { type: "adjustment", amount: 5 })).error).toMatch(/increases or reduces/);
    expect((await recordLedgerEntry(SHOP, supplier.id, { type: "bill", amount: 5 })).error).toMatch(/unknown/i);
    expect((await recordLedgerEntry(OTHER_SHOP, supplier.id, { type: "payment", amount: 5 })).error).toMatch(/not found/i);
    expect(
      (await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 5, purchaseOrderId: othersPo.id })).error,
    ).toMatch(/not from this supplier/);
  });

  it("signs refunds and adjustments by what they do to the balance", async () => {
    const { supplier } = await seed();
    await recordLedgerEntry(SHOP, supplier.id, { type: "adjustment", amount: 1000, direction: "owe_more" });
    await recordLedgerEntry(SHOP, supplier.id, { type: "adjustment", amount: 300, direction: "owe_less" });
    await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 900 });
    // -200: the supplier owes 200. A refund of it brings the account back to settled.
    await recordLedgerEntry(SHOP, supplier.id, { type: "refund", amount: 200 });
    expect(await balanceOf(supplier.id)).toBe(0);
  });

  it("keeps cents exact where floats would drift", async () => {
    const { supplier } = await seed();
    for (let i = 0; i < 10; i++) await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 0.1 });
    expect(await balanceOf(supplier.id)).toBe(-1);
  });

  it("reverses an entry once, and never a reversal", async () => {
    const { supplier } = await seed();
    const pay = await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 400 });

    expect((await reverseLedgerEntry(SHOP, pay.entryId!)).ok).toBe(true);
    expect((await reverseLedgerEntry(SHOP, pay.entryId!)).error).toMatch(/already been reversed/);
    expect((await reverseLedgerEntry(OTHER_SHOP, pay.entryId!)).ok).toBe(false);

    const statement = await getSupplierStatement(SHOP, supplier.id);
    expect(statement.balance).toBe(0);
    const reversal = statement.rows.find((r) => r.isReversal)!;
    expect(reversal.amount).toBe(400);
    expect(statement.rows.find((r) => r.id === pay.entryId)?.reversed).toBe(true);
    expect((await reverseLedgerEntry(SHOP, reversal.id)).error).toMatch(/cannot itself be reversed/);
  });

  it("nets a reversed bill out of the PO's billed figure", async () => {
    const { supplier, product } = await seed();
    const po = await createPo(product.id, supplier.id);
    await receivePurchaseOrder(admin, SHOP, po.id);
    const bill = await prisma.supplierLedgerEntry.findFirstOrThrow({ where: { shop: SHOP, type: "bill" } });

    await reverseLedgerEntry(SHOP, bill.id);
    expect(await getPoAccount(SHOP, po.id)).toMatchObject({ billed: 0, net: 0 });
  });

  it("shows the running balance after each entry, newest first", async () => {
    const { supplier } = await seed();
    await recordLedgerEntry(SHOP, supplier.id, {
      type: "adjustment",
      amount: 1000,
      direction: "owe_more",
      occurredAt: new Date("2026-09-01T00:00:00Z"),
    });
    await recordLedgerEntry(SHOP, supplier.id, { type: "payment", amount: 600, occurredAt: new Date("2026-09-10T00:00:00Z") });

    const { rows } = await getSupplierStatement(SHOP, supplier.id);
    expect(rows.map((r) => [r.type, r.amount, r.balance])).toEqual([
      ["payment", -600, 400],
      ["adjustment", 1000, 1000],
    ]);
  });
});
