import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { applyLocalStockState, pushStockStateToShopify, resolveDefaultLocationId, type StockStateChange } from "./stock.server";
import {
  CLAIM_TYPES,
  absorbedDamagedUnits,
  countsAgainstReceived,
  deriveDecision,
  effectiveClaimQuantity,
  holdsQuarantine,
  quarantinedQuantity,
  type ClaimDisposition,
  type ClaimStockSource,
  type ClaimType,
} from "./supplier-claim";

/**
 * Supplier claims: what a supplier owes the merchant for one purchase order.
 *
 * A claim is opened from three places, all through openClaim below:
 *
 *   - receiving, for units that arrived damaged (stockSource "receipt") — they are booked
 *     straight into Shopify's `damaged` state and never become sellable,
 *   - closing a PO short, for units the supplier invoiced but never sent ("none"),
 *   - the PO page after the fact, for problems found once stock was on the shelf
 *     ("on_hand", which moves stock) or already gone ("none", which does not).
 *
 * Stock and claim rows change in one transaction, so a claim never describes a stock
 * movement that did not happen. Shopify is told afterwards and, as everywhere else in the
 * app, a Shopify failure is a warning rather than a rollback.
 */

/** Thrown inside a transaction to roll it back with a message meant for the merchant. */
export class ClaimError extends Error {}

/** Every quarantine movement names its claim in Shopify's inventory history. */
const claimUri = (claimId: string) => `gid://inventorify/SupplierClaim/${claimId}`;

export interface NewClaimLine {
  purchaseOrderItemId: string;
  type: ClaimType;
  quantity: number;
  stockSource: ClaimStockSource;
  locationId: string | null;
}

/**
 * Create a claim and its lines inside the caller's transaction, enforcing the limits.
 *
 * The PO row is locked first. Every limit is "what has been claimed so far on this line,
 * plus this", and two concurrent claims each reading "so far" before the other wrote
 * would together claim more units than ever arrived. The lock also makes the claim-number
 * sequence safe.
 *
 * Limits per PO line:
 *   - lines about delivered units (everything but missing+none) <= quantityReceived
 *   - missing units never delivered (missing+none)              <= quantityCancelled
 */
export async function openClaim(
  tx: Prisma.TransactionClient,
  shop: string,
  poId: string,
  lines: NewClaimLine[],
  opts: { notes?: string | null; userId?: string | null } = {},
) {
  await tx.$queryRaw`SELECT id FROM "PurchaseOrder" WHERE id = ${poId} AND shop = ${shop} FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({
    where: { id: poId, shop },
    include: { items: { include: { claimLines: true, product: { select: { title: true, variantTitle: true } } } } },
  });
  if (!po) throw new ClaimError("Purchase order not found");

  const itemsById = new Map(po.items.map((i) => [i.id, i]));
  for (const line of lines) {
    if (!itemsById.has(line.purchaseOrderItemId)) {
      throw new ClaimError("A claimed line is not on this purchase order");
    }
  }

  for (const item of po.items) {
    const mine = lines.filter((l) => l.purchaseOrderItemId === item.id);
    if (mine.length === 0) continue;
    const name = item.product.variantTitle ? `${item.product.title} — ${item.product.variantTitle}` : item.product.title;

    const priorDelivered = item.claimLines
      .filter(countsAgainstReceived)
      .reduce((s, l) => s + effectiveClaimQuantity(l), 0);
    const newDelivered = mine.filter(countsAgainstReceived).reduce((s, l) => s + l.quantity, 0);
    if (priorDelivered + newDelivered > item.quantityReceived) {
      const left = Math.max(0, item.quantityReceived - priorDelivered);
      throw new ClaimError(
        `${name}: only ${left} more of the ${item.quantityReceived} received unit${item.quantityReceived === 1 ? "" : "s"} can be claimed`,
      );
    }

    const priorUndelivered = item.claimLines
      .filter((l) => !countsAgainstReceived(l))
      .reduce((s, l) => s + l.quantity, 0);
    const newUndelivered = mine.filter((l) => !countsAgainstReceived(l)).reduce((s, l) => s + l.quantity, 0);
    if (priorUndelivered + newUndelivered > item.quantityCancelled) {
      const left = Math.max(0, item.quantityCancelled - priorUndelivered);
      throw new ClaimError(
        item.quantityCancelled === 0
          ? `${name}: nothing was cancelled on this line, so there is no undelivered stock to claim — close the PO short first, or claim units that arrived`
          : `${name}: only ${left} more undelivered unit${left === 1 ? "" : "s"} can be claimed`,
      );
    }
  }

  const sequence = (await tx.supplierClaim.count({ where: { purchaseOrderId: po.id } })) + 1;
  return tx.supplierClaim.create({
    data: {
      shop,
      claimNumber: `${po.poNumber}-C${sequence}`,
      purchaseOrderId: po.id,
      supplierId: po.supplierId,
      notes: opts.notes?.trim() || null,
      createdByUserId: opts.userId ?? null,
      lines: {
        create: lines.map((l) => {
          const item = itemsById.get(l.purchaseOrderItemId)!;
          return {
            purchaseOrderItemId: item.id,
            productId: item.productId,
            type: l.type,
            quantity: l.quantity,
            unitCost: item.unitCost,
            stockSource: l.stockSource,
            locationId: l.locationId,
          };
        }),
      },
    },
    include: { lines: true },
  });
}

/** The stock movement a new claim line makes, if any. */
function openingMovement(line: { type: string; stockSource: string; quantity: number }): StockStateChange | null {
  if (line.stockSource !== "on_hand") return null;
  // Missing units were counted in but are not there: they leave stock. Anything else is
  // physically present but unsellable: it moves into quarantine.
  return line.type === "missing"
    ? { available: -line.quantity, damaged: 0 }
    : { available: -line.quantity, damaged: line.quantity };
}

export interface ClaimLineInput {
  purchaseOrderItemId: string;
  type: string;
  quantity: number;
  /** "on_hand": the units are in sellable stock now. "none": they are not (sold, gone). */
  stockSource: string;
}

/**
 * Open a claim for problems found after receipt — from the PO page.
 */
export async function createSupplierClaim(
  admin: AdminApiContext,
  shop: string,
  poId: string,
  input: { lines: ClaimLineInput[]; notes?: string | null; locationId?: string | null; userId?: string | null },
): Promise<{ ok: boolean; error?: string; claimId?: string; shopifyWarnings: string[] }> {
  const shopifyWarnings: string[] = [];
  const po = await prisma.purchaseOrder.findFirst({ where: { id: poId, shop }, select: { id: true, status: true } });
  if (!po) return { ok: false, error: "Purchase order not found", shopifyWarnings };
  if (po.status === "draft" || po.status === "sent") {
    return { ok: false, error: "Nothing has been received on this purchase order yet", shopifyWarnings };
  }

  const lines = input.lines.filter((l) => l.quantity !== 0);
  if (lines.length === 0) return { ok: false, error: "Enter a quantity for at least one line", shopifyWarnings };
  for (const l of lines) {
    if (!CLAIM_TYPES.includes(l.type as ClaimType)) return { ok: false, error: "Unknown claim type", shopifyWarnings };
    if (!Number.isInteger(l.quantity) || l.quantity < 1) {
      return { ok: false, error: "Claimed quantities must be whole numbers of at least 1", shopifyWarnings };
    }
    if (l.stockSource !== "on_hand" && l.stockSource !== "none") {
      return { ok: false, error: "Say whether the units are in stock", shopifyWarnings };
    }
  }

  const locationId = lines.some((l) => l.stockSource === "on_hand")
    ? await resolveDefaultLocationId(shop, input.locationId ?? null)
    : null;
  if (lines.some((l) => l.stockSource === "on_hand") && !locationId) {
    return {
      ok: false,
      error: "Moving stock needs a synced location — re-sync the catalogue, or claim the units as not in stock",
      shopifyWarnings,
    };
  }

  let claim;
  try {
    claim = await prisma.$transaction(async (tx) => {
      const created = await openClaim(
        tx,
        shop,
        po.id,
        lines.map((l) => ({
          purchaseOrderItemId: l.purchaseOrderItemId,
          type: l.type as ClaimType,
          quantity: l.quantity,
          stockSource: l.stockSource as ClaimStockSource,
          locationId: l.stockSource === "on_hand" ? locationId : null,
        })),
        { notes: input.notes, userId: input.userId },
      );
      for (const line of created.lines) {
        const move = openingMovement(line);
        if (!move) continue;
        const error = await applyLocalStockState(tx, shop, line.productId, line.locationId!, move);
        if (error) throw new ClaimError(error);
      }
      return created;
    });
  } catch (err) {
    if (err instanceof ClaimError) return { ok: false, error: err.message, shopifyWarnings };
    throw err;
  }

  for (const line of claim.lines) {
    const move = openingMovement(line);
    if (!move) continue;
    const res = await pushStockStateToShopify(admin, shop, line.productId, line.locationId!, move, {
      reason: line.type === "missing" ? "correction" : "damaged",
      ledgerDocumentUri: claimUri(claim.id),
    });
    if (!res.ok && res.error) shopifyWarnings.push(res.error);
  }

  return { ok: true, claimId: claim.id, shopifyWarnings };
}

/**
 * Decide what happens to a claim line's units physically.
 *
 *   write_off / return_to_vendor   quarantined units leave the premises
 *   restock                        quarantined units turned out sellable
 *   found                          missing units (claimed from stock) turned up after all
 *
 * Allowed after the claim is resolved — goods often go back to the supplier only once
 * the credit is agreed — except `found`, which changes what was claimed and so must come
 * before the supplier's decision is recorded.
 */
export async function disposeClaimLine(
  admin: AdminApiContext,
  shop: string,
  lineId: string,
  action: string,
  quantity: number,
): Promise<{ ok: boolean; error?: string; shopifyWarning?: string }> {
  if (!["write_off", "return_to_vendor", "restock", "found"].includes(action)) {
    return { ok: false, error: "Unknown action" };
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    return { ok: false, error: "Quantity must be a whole number of at least 1" };
  }
  const disposition = action as ClaimDisposition;

  let line;
  try {
    line = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "SupplierClaimLine" WHERE id = ${lineId} FOR UPDATE`;
      const current = await tx.supplierClaimLine.findFirst({
        where: { id: lineId, claim: { shop } },
        include: { claim: { select: { id: true, status: true } } },
      });
      if (!current) throw new ClaimError("Claim line not found");

      let move: StockStateChange;
      let counter: "quantityWrittenOff" | "quantityReturned" | "quantityRestocked" | "quantityFound";
      if (disposition === "found") {
        if (current.type !== "missing" || current.stockSource !== "on_hand") {
          throw new ClaimError("Only missing units that were removed from stock can be marked found");
        }
        if (current.claim.status === "resolved") {
          throw new ClaimError("The supplier has already decided this claim — record the units as a stock adjustment instead");
        }
        const left = effectiveClaimQuantity(current);
        if (quantity > left) throw new ClaimError(`Only ${left} unit${left === 1 ? " is" : "s are"} still missing on this line`);
        move = { available: quantity, damaged: 0 };
        counter = "quantityFound";
      } else {
        if (!holdsQuarantine(current) || !current.locationId) {
          throw new ClaimError("This line has no quarantined stock");
        }
        const held = quarantinedQuantity(current);
        if (quantity > held) throw new ClaimError(`Only ${held} unit${held === 1 ? " is" : "s are"} in quarantine on this line`);
        move =
          disposition === "restock" ? { available: quantity, damaged: -quantity } : { available: 0, damaged: -quantity };
        counter =
          disposition === "write_off"
            ? "quantityWrittenOff"
            : disposition === "return_to_vendor"
              ? "quantityReturned"
              : "quantityRestocked";
      }

      const error = await applyLocalStockState(tx, shop, current.productId, current.locationId!, move);
      if (error) throw new ClaimError(error);
      await tx.supplierClaimLine.update({ where: { id: current.id }, data: { [counter]: { increment: quantity } } });
      return { ...current, move };
    });
  } catch (err) {
    if (err instanceof ClaimError) return { ok: false, error: err.message };
    throw err;
  }

  const res = await pushStockStateToShopify(admin, shop, line.productId, line.locationId!, line.move, {
    reason: disposition === "write_off" ? "damaged" : "correction",
    ledgerDocumentUri: claimUri(line.claim.id),
  });
  return { ok: true, shopifyWarning: res.ok ? undefined : res.error };
}

/** Record that the claim has gone to the supplier. */
export async function submitClaim(shop: string, claimId: string): Promise<{ ok: boolean; error?: string }> {
  const { count } = await prisma.supplierClaim.updateMany({
    where: { id: claimId, shop, status: "open" },
    data: { status: "submitted", submittedAt: new Date() },
  });
  return count === 1 ? { ok: true } : { ok: false, error: "Only an open claim can be marked as sent" };
}

/**
 * Record the supplier's answer, line by line, and resolve the claim.
 *
 * `creditAmount` defaults to accepted units at the PO line's unit cost — what the
 * merchant paid. It can be set to anything non-negative: suppliers negotiate (half off
 * for slightly damaged goods), and a replacement instead of a credit is a zero credit
 * with the units still accepted.
 */
export async function resolveClaim(
  shop: string,
  claimId: string,
  decisions: { lineId: string; quantityAccepted: number; creditAmount?: number | null }[],
): Promise<{ ok: boolean; error?: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      // The lines are locked before they are read: accepted quantities are checked
      // against quantity minus found, and a `found` committing between that check and
      // this write would leave more accepted than is still claimed.
      await tx.$queryRaw`SELECT id FROM "SupplierClaimLine" WHERE "claimId" = ${claimId} FOR UPDATE`;
      const claim = await tx.supplierClaim.findFirst({ where: { id: claimId, shop }, include: { lines: true } });
      if (!claim) throw new ClaimError("Claim not found");
      if (claim.status === "resolved") throw new ClaimError("This claim is already resolved");

      const byLine = new Map(decisions.map((d) => [d.lineId, d]));
      const updates: { id: string; data: Prisma.SupplierClaimLineUpdateInput }[] = [];
      for (const line of claim.lines) {
        const d = byLine.get(line.id);
        if (!d) throw new ClaimError("Record a decision for every line");
        const effective = effectiveClaimQuantity(line);
        if (!Number.isInteger(d.quantityAccepted) || d.quantityAccepted < 0 || d.quantityAccepted > effective) {
          throw new ClaimError(`Accepted quantity must be between 0 and ${effective}`);
        }
        const credit = d.creditAmount ?? d.quantityAccepted * line.unitCost;
        if (!Number.isFinite(credit) || credit < 0) throw new ClaimError("Credit must be zero or more");
        updates.push({
          id: line.id,
          data: {
            quantityAccepted: d.quantityAccepted,
            creditAmount: Math.round(credit * 100) / 100,
            decision: deriveDecision(d.quantityAccepted, effective),
          },
        });
      }

      // Guarded on status so two submits racing past the read above cannot both resolve.
      const { count } = await tx.supplierClaim.updateMany({
        where: { id: claim.id, shop, status: { not: "resolved" } },
        data: { status: "resolved", resolvedAt: new Date() },
      });
      if (count === 0) throw new ClaimError("This claim is already resolved");
      for (const u of updates) await tx.supplierClaimLine.update({ where: { id: u.id }, data: u.data });
      return { ok: true };
    });
  } catch (err) {
    if (err instanceof ClaimError) return { ok: false, error: err.message };
    throw err;
  }
}

export interface SupplierClaimSummary {
  openClaims: number;
  /** Units claimed across all claims, net of missing units that turned up. */
  unitsClaimed: number;
  /** On resolved claims: units the supplier accepted responsibility for. */
  unitsAccepted: number;
  /** On resolved claims: damaged units the supplier did not accept — the merchant's loss. */
  damagedAbsorbed: number;
  /** Units sitting in quarantine now, awaiting write-off, return or restock. */
  quarantined: number;
  /** Credit the supplier agreed to, in the store's currency. */
  creditAgreed: number;
}

/**
 * The supplier-attributed vs merchant-absorbed split, per supplier.
 *
 * Deliberately not folded into the dashboard's "Damaged" figure: that one belongs to the
 * fulfilment pipeline (what happened to shipped orders), and inbound supplier defects
 * would distort its delivery rates. Claims create no StockAdjustment rows, so supplier
 * damage never inflated that figure in the first place.
 */
export async function getSupplierClaimSummary(shop: string, supplierId: string): Promise<SupplierClaimSummary> {
  const claims = await prisma.supplierClaim.findMany({
    where: { shop, supplierId },
    select: { status: true, lines: true },
  });
  const summary: SupplierClaimSummary = {
    openClaims: 0,
    unitsClaimed: 0,
    unitsAccepted: 0,
    damagedAbsorbed: 0,
    quarantined: 0,
    creditAgreed: 0,
  };
  for (const claim of claims) {
    if (claim.status !== "resolved") summary.openClaims++;
    for (const line of claim.lines) {
      summary.unitsClaimed += effectiveClaimQuantity(line);
      summary.quarantined += quarantinedQuantity(line);
      if (claim.status === "resolved") {
        summary.unitsAccepted += line.quantityAccepted;
        summary.damagedAbsorbed += absorbedDamagedUnits(line);
        summary.creditAgreed += line.creditAmount;
      }
    }
  }
  summary.creditAgreed = Math.round(summary.creditAgreed * 100) / 100;
  return summary;
}
