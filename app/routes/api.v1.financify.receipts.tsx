/**
 * GET /api/v1/financify/receipts — the Growzar receipts feed, served to Financify Books under its
 * own key and secret (the partner comes from this path; see openFeed).
 */
export { loader, action } from "./api.v1.growzar.receipts";
