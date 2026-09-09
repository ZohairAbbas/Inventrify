/**
 * Capital-tied-up arithmetic, shared by the dashboard KPI and the daily snapshot that
 * draws its sparkline.
 *
 * These two must agree. The KPI is computed live from Product rows at request time; the
 * sparkline is read from ShopDailySnapshot rows written hours earlier by the sync cron.
 * If the formulas diverge, the card shows a number and a trend line that describe
 * different quantities — which is worse than showing no trend at all, because it looks
 * authoritative. Hence one implementation, imported by both.
 */

/** The Product columns every figure here is derived from. */
export type CapitalInputs = {
  currentStock: number;
  unitCost: number;
  avgMargin: number;
  fulfilledInTransit: number;
};

/**
 * Estimated retail price of one unit.
 *
 * COD float is money owed back by the courier, so in-route stock is valued at what it
 * sells for, not what it cost. Margin is only trusted between 0 and 0.95: at 1.0 the
 * division explodes, and a margin at or above 0.95 is almost always a data-entry error
 * (a percentage entered as 95 rather than 0.95) which would inflate the float twentyfold.
 * Outside that band, fall back to cost — understating the float is the safer error.
 */
export function estimateUnitPrice(p: Pick<CapitalInputs, "unitCost" | "avgMargin">): number {
  return p.unitCost > 0 && p.avgMargin > 0 && p.avgMargin < 0.95
    ? p.unitCost / (1 - p.avgMargin)
    : p.unitCost;
}

/**
 * On-hand stock valued at cost.
 *
 * Negative stock is an oversell or backorder, not negative-value inventory. Multiplying
 * it by cost subtracts real money from the total — on one live shop that read as Rs
 * 194,475 less than the stock physically on the shelves — so it is floored at zero.
 */
export function computeStockAtCost(products: readonly CapitalInputs[]): number {
  return products.reduce((sum, p) => sum + Math.max(0, p.currentStock) * p.unitCost, 0);
}

/** Retail value of units dispatched and not yet collected — cash sitting with the courier. */
export function computeCodFloat(products: readonly CapitalInputs[]): number {
  return products.reduce((sum, p) => sum + p.fulfilledInTransit * estimateUnitPrice(p), 0);
}

/** Units that have left the building and not yet resolved. */
export function computeInRouteUnits(products: readonly Pick<CapitalInputs, "fulfilledInTransit">[]): number {
  return products.reduce((sum, p) => sum + (p.fulfilledInTransit || 0), 0);
}
