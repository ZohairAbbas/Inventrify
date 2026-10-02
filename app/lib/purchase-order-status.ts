/**
 * Purchase-order statuses and the one definition of "still on order".
 *
 * Not a .server module: the PO pages need the same rules to decide which controls to
 * show, and planning, alerts and the sync's archive guard need them to decide which POs
 * still count. Before partial receipts each of those hard-coded `status: "sent"`, and a
 * PO that was received short dropped its missing units from "on order" the moment it was
 * marked received.
 */

export type POStatus = "draft" | "sent" | "partially_received" | "received" | "closed";

/** Stock is still expected against these. */
export const OPEN_PO_STATUSES: POStatus[] = ["sent", "partially_received"];

/**
 * A receipt may be booked against these. Draft is included because receiving a PO that
 * was never marked sent has always been allowed; it simply contributes no lead time.
 */
export const RECEIVABLE_PO_STATUSES: POStatus[] = ["draft", ...OPEN_PO_STATUSES];

export const PO_STATUS_LABELS: Record<POStatus, string> = {
  draft: "draft",
  sent: "sent",
  partially_received: "partially received",
  received: "received",
  closed: "closed short",
};

export interface POLineQuantities {
  quantityOrdered: number;
  quantityReceived: number;
  quantityCancelled: number;
}

/** Units still expected from the supplier on one line. Over-delivery is not negative. */
export function outstandingQuantity(line: POLineQuantities): number {
  return Math.max(0, line.quantityOrdered - line.quantityReceived - line.quantityCancelled);
}

/**
 * The status a PO's lines imply once it has left draft.
 *
 * `fallback` is returned when nothing has arrived and nothing is cancelled — the PO is
 * exactly where it was (sent, or a draft being received outside the usual flow).
 */
export function derivePoStatus(lines: POLineQuantities[], fallback: POStatus): POStatus {
  const outstanding = lines.reduce((s, l) => s + outstandingQuantity(l), 0);
  if (outstanding === 0 && lines.length > 0) {
    return lines.some((l) => l.quantityCancelled > 0) ? "closed" : "received";
  }
  return lines.some((l) => l.quantityReceived > 0) ? "partially_received" : fallback;
}
