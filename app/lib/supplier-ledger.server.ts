import { Prisma } from "@prisma/client";
import prisma from "../db.server";

/**
 * The supplier ledger: an append-only account per supplier whose sum is the balance.
 *
 * Sign convention, everywhere: positive means the merchant owes the supplier, negative
 * means the supplier owes the merchant. Either can be normal — a merchant who pays in
 * advance runs negative until the goods arrive; one who pays on delivery runs positive
 * until they pay.
 *
 * Bills and claim credits are posted automatically, inside the same transaction as the
 * receipt or claim that causes them, and each carries a unique `sourceKey` so it can
 * never post twice. Payments, refunds and adjustments are entered by the merchant.
 * Nothing is ever edited or deleted: a mistake is undone by a reversal entry.
 */

export type LedgerEntryType = "bill" | "payment" | "credit_note" | "refund" | "adjustment" | "reversal";
export type ManualEntryType = "payment" | "refund" | "adjustment";

type Db = Prisma.TransactionClient | typeof prisma;

/** Round to the cent and hand Prisma an exact decimal, never a binary float. */
function money(value: number): Prisma.Decimal {
  return new Prisma.Decimal((Math.round(value * 100) / 100).toFixed(2));
}

async function shopCurrency(db: Db, shop: string): Promise<string> {
  const settings = await db.shopSettings.findUnique({ where: { shop }, select: { currency: true } });
  return settings?.currency ?? "USD";
}

interface AutoEntry {
  shop: string;
  supplierId: string;
  type: "bill" | "credit_note";
  /** Magnitude; the sign comes from the type. */
  amount: number;
  occurredAt: Date;
  sourceKey: string;
  purchaseOrderId?: string | null;
  claimId?: string | null;
  receiptId?: string | null;
  note?: string | null;
  userId?: string | null;
}

/**
 * Post an automatic entry, at most once per sourceKey.
 *
 * `createMany({ skipDuplicates })` is INSERT ... ON CONFLICT DO NOTHING. A plain create
 * that collided on sourceKey would raise, and inside a Postgres transaction any error
 * aborts the whole transaction — the receipt or claim it belongs to would be lost with it.
 */
async function postAutoEntry(db: Db, entry: AutoEntry): Promise<void> {
  if (entry.amount <= 0) return;
  const signed = entry.type === "bill" ? entry.amount : -entry.amount;
  await db.supplierLedgerEntry.createMany({
    data: [
      {
        shop: entry.shop,
        supplierId: entry.supplierId,
        type: entry.type,
        amount: money(signed),
        currency: await shopCurrency(db, entry.shop),
        occurredAt: entry.occurredAt,
        sourceKey: entry.sourceKey,
        purchaseOrderId: entry.purchaseOrderId ?? null,
        claimId: entry.claimId ?? null,
        receiptId: entry.receiptId ?? null,
        note: entry.note ?? null,
        createdByUserId: entry.userId ?? null,
      },
    ],
    skipDuplicates: true,
  });
}

/**
 * Bill a delivery: every unit that arrived, at the PO line's cost. Damaged units are
 * included — the supplier shipped and invoiced them; what is owed back for them is the
 * claim's credit, posted when the supplier agrees to it.
 */
export async function postReceiptBill(
  db: Db,
  args: {
    shop: string;
    supplierId: string;
    purchaseOrderId: string;
    poNumber: string;
    receiptId: string;
    receivedAt: Date;
    lines: { quantity: number; unitCost: number }[];
    userId?: string | null;
  },
): Promise<void> {
  await postAutoEntry(db, {
    shop: args.shop,
    supplierId: args.supplierId,
    type: "bill",
    amount: args.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0),
    occurredAt: args.receivedAt,
    sourceKey: `receipt:${args.receiptId}`,
    purchaseOrderId: args.purchaseOrderId,
    receiptId: args.receiptId,
    note: `Delivery against ${args.poNumber}`,
    userId: args.userId,
  });
}

/**
 * Bill units claimed as invoiced but never sent.
 *
 * Receipts bill only what arrived, so a claim for undelivered units would otherwise
 * credit the merchant for something never billed — the supplier would end up owing for
 * goods nobody paid for. Billing them here, alongside the claim, makes the pair net to
 * zero when the supplier accepts and leaves the merchant owing when the supplier disputes,
 * which is the truth in both cases.
 */
export async function postUndeliveredBill(
  db: Db,
  args: {
    shop: string;
    supplierId: string;
    purchaseOrderId: string;
    claimId: string;
    claimNumber: string;
    lines: { quantity: number; unitCost: number }[];
    userId?: string | null;
  },
): Promise<void> {
  await postAutoEntry(db, {
    shop: args.shop,
    supplierId: args.supplierId,
    type: "bill",
    amount: args.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0),
    occurredAt: new Date(),
    sourceKey: `claim:${args.claimId}:bill`,
    purchaseOrderId: args.purchaseOrderId,
    claimId: args.claimId,
    note: `Invoiced but not delivered (${args.claimNumber})`,
    userId: args.userId,
  });
}

/** Credit the merchant for a resolved claim: the sum the supplier agreed to. */
export async function postClaimCredit(
  db: Db,
  args: {
    shop: string;
    supplierId: string;
    purchaseOrderId: string;
    claimId: string;
    claimNumber: string;
    credit: number;
    userId?: string | null;
  },
): Promise<void> {
  await postAutoEntry(db, {
    shop: args.shop,
    supplierId: args.supplierId,
    type: "credit_note",
    amount: args.credit,
    occurredAt: new Date(),
    sourceKey: `claim:${args.claimId}:credit`,
    purchaseOrderId: args.purchaseOrderId,
    claimId: args.claimId,
    note: `Credit for ${args.claimNumber}`,
    userId: args.userId,
  });
}

/** Ceiling on a single manual entry; anything above is almost certainly a typo. */
const MAX_ENTRY = 1_000_000_000;

/**
 * Record a payment, refund or adjustment entered by the merchant.
 *
 *   payment     merchant paid the supplier                 (balance goes down)
 *   refund      supplier paid money back                   (balance goes up)
 *   adjustment  `direction` says which way: "owe_more" for an opening balance owed or a
 *               freight charge, "owe_less" for an opening credit or a discount
 */
export async function recordLedgerEntry(
  shop: string,
  supplierId: string,
  input: {
    type: string;
    amount: number;
    direction?: string | null;
    occurredAt?: Date | null;
    reference?: string | null;
    note?: string | null;
    purchaseOrderId?: string | null;
    userId?: string | null;
  },
): Promise<{ ok: boolean; error?: string; entryId?: string }> {
  if (!["payment", "refund", "adjustment"].includes(input.type)) return { ok: false, error: "Unknown entry type" };
  if (!Number.isFinite(input.amount) || input.amount <= 0) return { ok: false, error: "Enter an amount greater than zero" };
  if (input.amount > MAX_ENTRY) return { ok: false, error: "That amount looks too large — check it and try again" };
  if (input.type === "adjustment" && input.direction !== "owe_more" && input.direction !== "owe_less") {
    return { ok: false, error: "Say whether the adjustment increases or reduces what you owe" };
  }

  const supplier = await prisma.supplier.findFirst({ where: { id: supplierId, shop }, select: { id: true } });
  if (!supplier) return { ok: false, error: "Supplier not found" };
  if (input.purchaseOrderId) {
    const po = await prisma.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, shop, supplierId },
      select: { id: true },
    });
    if (!po) return { ok: false, error: "That purchase order is not from this supplier" };
  }

  const owesMore = input.type === "refund" || (input.type === "adjustment" && input.direction === "owe_more");
  const entry = await prisma.supplierLedgerEntry.create({
    data: {
      shop,
      supplierId,
      type: input.type,
      amount: money(owesMore ? input.amount : -input.amount),
      currency: await shopCurrency(prisma, shop),
      occurredAt: input.occurredAt ?? new Date(),
      reference: input.reference?.trim().slice(0, 120) || null,
      note: input.note?.trim().slice(0, 500) || null,
      purchaseOrderId: input.purchaseOrderId || null,
      createdByUserId: input.userId ?? null,
    },
  });
  return { ok: true, entryId: entry.id };
}

/**
 * Undo one entry by posting its exact negation.
 *
 * Automatic entries can be reversed too — a receipt booked against the wrong PO, say —
 * but their sourceKey is not reused, so the reversed bill does not come back on a retry.
 * The unique `reversalOf` index is the double-click guard, as for stock adjustments.
 */
export async function reverseLedgerEntry(
  shop: string,
  entryId: string,
  opts: { note?: string | null; userId?: string | null } = {},
): Promise<{ ok: boolean; error?: string }> {
  const entry = await prisma.supplierLedgerEntry.findFirst({ where: { id: entryId, shop } });
  if (!entry) return { ok: false, error: "Entry not found" };
  if (entry.type === "reversal") return { ok: false, error: "A reversal cannot itself be reversed — record a new entry instead" };

  try {
    await prisma.supplierLedgerEntry.create({
      data: {
        shop,
        supplierId: entry.supplierId,
        type: "reversal",
        amount: entry.amount.negated(),
        currency: entry.currency,
        occurredAt: new Date(),
        reference: entry.reference,
        note: opts.note?.trim() || `Reverses ${entry.type.replace("_", " ")}`,
        purchaseOrderId: entry.purchaseOrderId,
        claimId: entry.claimId,
        receiptId: entry.receiptId,
        reversalOf: entry.id,
        createdByUserId: opts.userId ?? null,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "This entry has already been reversed" };
    }
    throw err;
  }
  return { ok: true };
}

export interface LedgerRow {
  id: string;
  type: string;
  amount: number;
  /** Balance after this entry, in occurredAt order. */
  balance: number;
  currency: string;
  occurredAt: Date;
  reference: string | null;
  note: string | null;
  purchaseOrderId: string | null;
  poNumber: string | null;
  claimId: string | null;
  reversed: boolean;
  isReversal: boolean;
}

/**
 * A supplier's statement, newest first, with the running balance after each entry.
 *
 * The running balance is computed from the full history rather than the page shown, so
 * the figure beside the newest entry is always the true balance.
 */
export async function getSupplierStatement(
  shop: string,
  supplierId: string,
  limit = 100,
): Promise<{ balance: number; currency: string | null; rows: LedgerRow[]; truncated: boolean }> {
  const entries = await prisma.supplierLedgerEntry.findMany({
    where: { shop, supplierId },
    orderBy: [{ occurredAt: "asc" }, { createdAt: "asc" }],
  });
  const reversedIds = new Set(entries.filter((e) => e.reversalOf).map((e) => e.reversalOf as string));
  const poIds = [...new Set(entries.map((e) => e.purchaseOrderId).filter((id): id is string => !!id))];
  const pos = await prisma.purchaseOrder.findMany({ where: { id: { in: poIds }, shop }, select: { id: true, poNumber: true } });
  const poNumbers = new Map(pos.map((p) => [p.id, p.poNumber]));

  // Summed as Decimal, converted once per row for display.
  let running = new Prisma.Decimal(0);
  const rows: LedgerRow[] = entries.map((e) => {
    running = running.plus(e.amount);
    return {
      id: e.id,
      type: e.type,
      amount: e.amount.toNumber(),
      balance: running.toNumber(),
      currency: e.currency,
      occurredAt: e.occurredAt,
      reference: e.reference,
      note: e.note,
      purchaseOrderId: e.purchaseOrderId,
      poNumber: e.purchaseOrderId ? (poNumbers.get(e.purchaseOrderId) ?? null) : null,
      claimId: e.claimId,
      reversed: reversedIds.has(e.id),
      isReversal: e.type === "reversal",
    };
  });
  rows.reverse();
  return {
    balance: running.toNumber(),
    currency: entries[0]?.currency ?? null,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

export interface PoAccount {
  billed: number;
  credited: number;
  paid: number;
  /** billed - credited - paid (+ refunds and adjustments linked to this PO). */
  net: number;
  entries: number;
}

/** Money posted against one purchase order. Reversals net out against their originals. */
export async function getPoAccount(shop: string, purchaseOrderId: string): Promise<PoAccount> {
  const entries = await prisma.supplierLedgerEntry.findMany({
    where: { shop, purchaseOrderId },
    select: { id: true, type: true, amount: true, reversalOf: true },
  });
  const typeById = new Map(entries.map((e) => [e.id, e.type]));
  const totals = { bill: new Prisma.Decimal(0), credit_note: new Prisma.Decimal(0), payment: new Prisma.Decimal(0) };
  let net = new Prisma.Decimal(0);
  for (const e of entries) {
    net = net.plus(e.amount);
    // A reversal counts against the bucket of the entry it reverses.
    const bucket = (e.type === "reversal" ? typeById.get(e.reversalOf ?? "") : e.type) as keyof typeof totals;
    if (bucket in totals) totals[bucket] = totals[bucket].plus(e.amount);
  }
  return {
    billed: totals.bill.toNumber(),
    credited: totals.credit_note.negated().toNumber(),
    paid: totals.payment.negated().toNumber(),
    net: net.toNumber(),
    entries: entries.length,
  };
}
