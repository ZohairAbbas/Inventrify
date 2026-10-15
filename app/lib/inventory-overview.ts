/**
 * Shaping for the dashboard's "Inventory right now" section: per-SKU status, the
 * catalogue totals behind the KPI tiles, and the filter/sort applied to the SKU table.
 *
 * Pure and separate from the loader for the same reason the needs-action queue it replaced was:
 * the tiles and chip counts describe the whole catalogue while the table carries one
 * page of it. Both are derived here, from one set of rows, so they cannot disagree.
 */

export const OVERVIEW_FILTERS = ["all", "out", "low", "slow"] as const;
export type OverviewFilter = (typeof OVERVIEW_FILTERS)[number];

export const OVERVIEW_SORTS = ["value", "days", "margin", "available"] as const;
export type OverviewSort = (typeof OVERVIEW_SORTS)[number];

export const isOverviewFilter = (v: string | null | undefined): v is OverviewFilter =>
  v != null && (OVERVIEW_FILTERS as readonly string[]).includes(v);
export const isOverviewSort = (v: string | null | undefined): v is OverviewSort =>
  v != null && (OVERVIEW_SORTS as readonly string[]).includes(v);

/** "healthy" is everything not in one of the three filterable states. */
export type OverviewStatus = "out" | "low" | "slow" | "healthy";

export interface OverviewInput {
  id: string;
  /** Sellable physical units (Product.currentStock — damaged already excluded). */
  onHand: number;
  /** Committed to unfulfilled orders (sum of ProductLocationStock.reserved). */
  booked: number;
  /** Shopify `damaged` state: physically present, not sellable. */
  damaged: number;
  /** Outstanding units on open purchase orders. */
  incoming: number;
  /** Value of `incoming` at the PO's own unit cost. */
  incomingCost: number;
  unitCost: number;
  /** Shopify selling price; null when not yet synced. */
  price: number | null;
  avgDailySales: number;
  /**
   * The app-wide stock status (getStockStatus on inventory position), so "Low" here is
   * the same judgement the Inventory page and the alerts make.
   */
  planningStatus: "healthy" | "low" | "critical" | "stockout";
  /** Matches Analytics' dead-stock rule: enough units on hand and no sales in the window. */
  deadStock: boolean;
}

export interface OverviewRow extends OverviewInput {
  available: number;
  status: OverviewStatus;
  /** Days of available stock at the current sales pace; null when nothing is selling. */
  daysLeft: number | null;
  atCost: number;
  /** Null when the SKU has no price — unknown, not zero. */
  atRetail: number | null;
  /** Fraction of price; null without both a price and a cost. */
  marginPct: number | null;
}

const isPriced = (price: number | null): price is number => price != null && price > 0;

/**
 * Status as the dashboard shows it.
 *
 * "Out of stock" is literal — nothing available to sell right now — even when a PO is on
 * its way. The planning status would call that SKU healthy (inventory position counts
 * stock on order), which is the right input for reordering and the wrong answer to "can I
 * sell this today". Below that, Low is the planning rule's low or critical.
 */
export function overviewStatus(available: number, input: Pick<OverviewInput, "planningStatus" | "deadStock">): OverviewStatus {
  if (available <= 0) return "out";
  if (input.planningStatus === "low" || input.planningStatus === "critical" || input.planningStatus === "stockout") {
    return "low";
  }
  if (input.deadStock) return "slow";
  return "healthy";
}

export function toOverviewRow(input: OverviewInput): OverviewRow {
  const onHand = Math.max(0, input.onHand);
  const available = onHand - input.booked;
  const daysLeft =
    input.avgDailySales > 0 ? (available <= 0 ? 0 : Math.floor(available / input.avgDailySales)) : null;
  return {
    ...input,
    available,
    status: overviewStatus(available, input),
    daysLeft,
    atCost: onHand * input.unitCost,
    atRetail: isPriced(input.price) ? onHand * input.price : null,
    marginPct:
      isPriced(input.price) && input.unitCost > 0 ? (input.price - input.unitCost) / input.price : null,
  };
}

export type OverviewCounts = Record<OverviewFilter, number>;

export interface OverviewTotals {
  skus: number;
  onHand: number;
  booked: number;
  available: number;
  /** Booked units at selling price — the order value they are held for. */
  bookedRetail: number;
  bookedCost: number;
  availableCost: number;
  damaged: number;
  damagedCost: number;
  incoming: number;
  incomingCost: number;
  atCost: number;
  /** Over priced SKUs only; see pricedSkus. */
  atRetail: number;
  /** Cost of the same priced SKUs, so the margin compares like with like. */
  pricedAtCost: number;
  pricedSkus: number;
  costedSkus: number;
  counts: OverviewCounts;
}

export function summarise(rows: readonly OverviewRow[]): OverviewTotals {
  const t: OverviewTotals = {
    skus: rows.length,
    onHand: 0,
    booked: 0,
    available: 0,
    bookedRetail: 0,
    bookedCost: 0,
    availableCost: 0,
    damaged: 0,
    damagedCost: 0,
    incoming: 0,
    incomingCost: 0,
    atCost: 0,
    atRetail: 0,
    pricedAtCost: 0,
    pricedSkus: 0,
    costedSkus: 0,
    counts: { all: rows.length, out: 0, low: 0, slow: 0 },
  };
  for (const r of rows) {
    const onHand = Math.max(0, r.onHand);
    t.onHand += onHand;
    t.booked += r.booked;
    // An oversold SKU has negative availability; it does not cancel another SKU's units.
    t.available += Math.max(0, r.available);
    t.bookedCost += r.booked * r.unitCost;
    t.availableCost += Math.max(0, r.available) * r.unitCost;
    t.damaged += r.damaged;
    t.damagedCost += r.damaged * r.unitCost;
    t.incoming += r.incoming;
    t.incomingCost += r.incomingCost;
    t.atCost += r.atCost;
    if (r.unitCost > 0) t.costedSkus++;
    if (r.atRetail != null) {
      t.atRetail += r.atRetail;
      t.pricedAtCost += r.atCost;
      t.pricedSkus++;
    }
    if (isPriced(r.price)) t.bookedRetail += r.booked * r.price;
    if (r.status !== "healthy") t.counts[r.status]++;
  }
  return t;
}

const SORTERS: Record<OverviewSort, (a: OverviewRow, b: OverviewRow) => number> = {
  value: (a, b) => b.atCost - a.atCost,
  // Nothing selling means no runway to count down; those go last, not first.
  days: (a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity),
  margin: (a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity),
  available: (a, b) => b.available - a.available,
};

/** The filtered, sorted, truncated table rows. `matched` is the size before truncation. */
export function selectOverviewRows<T extends OverviewRow>(
  rows: readonly T[],
  filter: OverviewFilter,
  sort: OverviewSort,
  limit: number,
): { rows: T[]; matched: number } {
  const filtered = filter === "all" ? rows.slice() : rows.filter((r) => r.status === filter);
  // id as a tie-break so equal values do not reorder between requests.
  filtered.sort((a, b) => SORTERS[sort](a, b) || a.id.localeCompare(b.id));
  return { rows: filtered.slice(0, limit), matched: filtered.length };
}
