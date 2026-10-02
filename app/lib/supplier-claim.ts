/**
 * Supplier-claim vocabulary and the arithmetic every page and report must agree on.
 *
 * Not a .server module: the PO page needs the same rules to decide which actions a claim
 * line offers, and the damage report needs them to split supplier-attributed from
 * merchant-absorbed units.
 */

export type ClaimType = "missing" | "damaged" | "defective" | "wrong_item";
export type ClaimStockSource = "receipt" | "on_hand" | "none";
export type ClaimStatus = "open" | "submitted" | "resolved";
export type ClaimDecision = "pending" | "accepted" | "partially_accepted" | "rejected";
export type ClaimDisposition = "write_off" | "return_to_vendor" | "restock" | "found";

export const CLAIM_TYPES: ClaimType[] = ["missing", "damaged", "defective", "wrong_item"];

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  missing: "Missing",
  damaged: "Damaged",
  defective: "Defective",
  wrong_item: "Wrong item",
};

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  open: "open",
  submitted: "sent to supplier",
  resolved: "resolved",
};

export const DISPOSITION_LABELS: Record<ClaimDisposition, string> = {
  write_off: "Write off",
  return_to_vendor: "Return to supplier",
  restock: "Restock as sellable",
  found: "Found",
};

export interface ClaimLineQuantities {
  type: string;
  quantity: number;
  stockSource: string;
  quantityWrittenOff: number;
  quantityReturned: number;
  quantityRestocked: number;
  quantityFound: number;
}

/** Units the claim is still about: missing units that turned up are no longer owed. */
export function effectiveClaimQuantity(line: ClaimLineQuantities): number {
  return Math.max(0, line.quantity - line.quantityFound);
}

/** True for lines whose units sit physically in quarantine (Shopify `damaged`). */
export function holdsQuarantine(line: Pick<ClaimLineQuantities, "type" | "stockSource">): boolean {
  return line.type !== "missing" && line.stockSource !== "none";
}

/** Units of this line still in quarantine, awaiting a decision about what to do with them. */
export function quarantinedQuantity(line: ClaimLineQuantities): number {
  if (!holdsQuarantine(line)) return 0;
  return Math.max(
    0,
    line.quantity - line.quantityWrittenOff - line.quantityReturned - line.quantityRestocked,
  );
}

/**
 * Units that count against what was RECEIVED on the PO line. Everything except a missing
 * line with no stock behind it — those are units that were never delivered, and count
 * against what was cancelled instead.
 */
export function countsAgainstReceived(line: Pick<ClaimLineQuantities, "type" | "stockSource">): boolean {
  return !(line.type === "missing" && line.stockSource === "none");
}

/** The decision implied by how much of the claim the supplier accepted. */
export function deriveDecision(accepted: number, effective: number): ClaimDecision {
  if (accepted <= 0) return "rejected";
  return accepted >= effective ? "accepted" : "partially_accepted";
}

/**
 * Damaged units the merchant ends up bearing on a resolved line: what the supplier did
 * not accept, less anything that was restocked as sellable after all (no loss there).
 * Missing units are not damage and are reported separately.
 */
export function absorbedDamagedUnits(
  line: ClaimLineQuantities & { quantityAccepted: number },
): number {
  if (line.type === "missing") return 0;
  return Math.max(0, effectiveClaimQuantity(line) - line.quantityRestocked - line.quantityAccepted);
}
