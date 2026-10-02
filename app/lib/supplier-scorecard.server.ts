import prisma from "../db.server";
import { OPEN_PO_STATUSES, outstandingQuantity } from "./purchase-order-status";
import { effectiveClaimQuantity } from "./supplier-claim";

/**
 * How reliable a supplier is, from the merchant's own history with them.
 *
 * Every rate is null rather than 0 when there is nothing to measure it on: a supplier
 * with no finished POs has an unknown fill rate, not a 0% one, and showing 0% would read
 * as an accusation.
 */
export interface SupplierScorecard {
  /** Units received / units ordered, on finished (received or closed) non-replacement POs. */
  fillRate: number | null;
  finishedPos: number;
  /** Share of first deliveries on or before the expected date, where both are known. */
  onTimeRate: number | null;
  onTimeSample: number;
  /** The lead time quoted on the supplier record, and the measured average. */
  quotedLeadTimeDays: number;
  actualLeadTimeDays: number | null;
  /** Damaged, defective and wrong units claimed / units received. Missing units are fill rate's job. */
  defectRate: number | null;
  unitsReceived: number;
  /** Units the supplier accepted / units claimed, on resolved claims. */
  acceptanceRate: number | null;
  /** Mean days from opening a claim to recording the supplier's decision. */
  avgDaysToResolve: number | null;
  resolvedClaims: number;
  /** Replacement units the supplier agreed to send that have not arrived yet. */
  replacementsOutstanding: number;
}

const DAY_MS = 86_400_000;
/** Calendar day in UTC, so a delivery at 23:00 on the due date is on time. */
const dayOf = (d: Date) => Math.floor(d.getTime() / DAY_MS);

export async function getSupplierScorecard(shop: string, supplierId: string): Promise<SupplierScorecard> {
  const [supplier, pos, claims] = await Promise.all([
    prisma.supplier.findFirst({ where: { id: supplierId, shop }, select: { leadTimeDays: true, avgActualLeadTime: true } }),
    prisma.purchaseOrder.findMany({
      where: { shop, supplierId, status: { not: "draft" } },
      select: {
        status: true,
        replacesClaimId: true,
        expectedDeliveryDate: true,
        actualDeliveryDate: true,
        items: { select: { quantityOrdered: true, quantityReceived: true, quantityCancelled: true } },
      },
    }),
    prisma.supplierClaim.findMany({
      where: { shop, supplierId },
      select: { status: true, createdAt: true, resolvedAt: true, lines: true },
    }),
  ]);

  let ordered = 0;
  let receivedOnFinished = 0;
  let finishedPos = 0;
  let onTime = 0;
  let onTimeSample = 0;
  let unitsReceived = 0;
  let replacementsOutstanding = 0;
  for (const po of pos) {
    const received = po.items.reduce((s, i) => s + i.quantityReceived, 0);
    unitsReceived += received;
    if (po.replacesClaimId) {
      // A replacement is the supplier making good, not a fresh order: it has no bearing
      // on how completely or punctually they fill orders.
      if (OPEN_PO_STATUSES.includes(po.status as (typeof OPEN_PO_STATUSES)[number])) {
        replacementsOutstanding += po.items.reduce((s, i) => s + outstandingQuantity(i), 0);
      }
      continue;
    }
    if (po.status === "received" || po.status === "closed") {
      finishedPos++;
      ordered += po.items.reduce((s, i) => s + i.quantityOrdered, 0);
      receivedOnFinished += received;
    }
    if (po.expectedDeliveryDate && po.actualDeliveryDate) {
      onTimeSample++;
      if (dayOf(po.actualDeliveryDate) <= dayOf(po.expectedDeliveryDate)) onTime++;
    }
  }

  let defective = 0;
  let claimedOnResolved = 0;
  let acceptedOnResolved = 0;
  let resolveDays = 0;
  let resolvedClaims = 0;
  for (const claim of claims) {
    for (const line of claim.lines) {
      if (line.type !== "missing") defective += effectiveClaimQuantity(line);
      if (claim.status === "resolved") {
        claimedOnResolved += effectiveClaimQuantity(line);
        acceptedOnResolved += line.quantityAccepted;
      }
    }
    if (claim.status === "resolved" && claim.resolvedAt) {
      resolvedClaims++;
      resolveDays += (claim.resolvedAt.getTime() - claim.createdAt.getTime()) / DAY_MS;
    }
  }

  // Over-delivery can push received past ordered; a fill rate above 100% means nothing.
  const ratio = (num: number, den: number) => (den > 0 ? Math.min(1, num / den) : null);
  return {
    fillRate: ratio(receivedOnFinished, ordered),
    finishedPos,
    onTimeRate: ratio(onTime, onTimeSample),
    onTimeSample,
    quotedLeadTimeDays: supplier?.leadTimeDays ?? 0,
    actualLeadTimeDays: supplier?.avgActualLeadTime ?? null,
    defectRate: ratio(defective, unitsReceived),
    unitsReceived,
    acceptanceRate: ratio(acceptedOnResolved, claimedOnResolved),
    avgDaysToResolve: resolvedClaims > 0 ? Math.round((resolveDays / resolvedClaims) * 10) / 10 : null,
    resolvedClaims,
    replacementsOutstanding,
  };
}
