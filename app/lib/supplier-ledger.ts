import { formatCurrency } from "./format";

/**
 * Ledger vocabulary shared by the supplier and PO pages. The sign convention matches
 * supplier-ledger.server.ts: positive = the merchant owes the supplier.
 */

export const LEDGER_TYPE_LABELS: Record<string, string> = {
  bill: "Bill",
  payment: "Payment",
  credit_note: "Credit note",
  refund: "Refund received",
  adjustment: "Adjustment",
  reversal: "Reversal",
};

/** "You owe Rs 5,000" / "Lahore Textiles owes you Rs 1,200" / "Settled". */
export function describeBalance(balance: number, currency: string, supplierName = "Supplier"): string {
  if (Math.abs(balance) < 0.005) return "Settled";
  return balance > 0
    ? `You owe ${formatCurrency(balance, currency)}`
    : `${supplierName} owes you ${formatCurrency(-balance, currency)}`;
}
