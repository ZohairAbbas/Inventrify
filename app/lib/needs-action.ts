/**
 * Shaping for the dashboard's "Needs action" queue: which SKUs qualify, in what order,
 * and how many of each severity exist.
 *
 * Pure and separate from the loader because the invariant that matters here is not
 * obvious from reading it: the counts beside the filter chips describe the *whole*
 * catalogue, while the rows describe only the page being shown. Those two are computed
 * from different sets and must still agree, which is exactly the kind of thing that
 * silently drifts. Tested rather than trusted.
 */

export const ACTION_FILTERS = ["all", "stockout", "critical", "low"] as const;
export type ActionFilter = (typeof ACTION_FILTERS)[number];

/** Statuses that constitute "needs action", worst first. */
export const STATUS_RANK: Record<string, number> = { stockout: 0, critical: 1, low: 2 };

export const isActionFilter = (v: string | null | undefined): v is ActionFilter =>
  v != null && (ACTION_FILTERS as readonly string[]).includes(v);

export type ActionCounts = Record<ActionFilter, number>;

export interface Rankable {
  status: string;
  /** Days of cover left; null when the SKU has no demand and so no runway. */
  daysRemaining: number | null;
}

/**
 * Count every severity across the full catalogue.
 *
 * Computed before any filtering or slicing, so a chip reading "Stockout 340" is true even
 * though the list below it holds 25 rows.
 */
export function countByStatus(all: readonly Rankable[]): ActionCounts {
  const counts: ActionCounts = { all: 0, stockout: 0, critical: 0, low: 0 };
  for (const p of all) {
    if (!(p.status in STATUS_RANK)) continue;
    counts.all++;
    if (p.status === "stockout") counts.stockout++;
    else if (p.status === "critical") counts.critical++;
    else if (p.status === "low") counts.low++;
  }
  return counts;
}

/**
 * Select, order and page the queue.
 *
 * Sorted by severity first, then by how soon the SKU runs out. SKUs with no demand sort
 * last within their severity: "no data" is not "zero days left", and putting them at the
 * top would bury the SKUs that genuinely run out on Tuesday.
 */
export function selectActionRows<T extends Rankable>(
  all: readonly T[],
  filter: ActionFilter,
  limit: number,
): T[] {
  return all
    .filter((p) => p.status in STATUS_RANK && (filter === "all" || p.status === filter))
    .sort(
      (a, b) =>
        STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
        (a.daysRemaining ?? Infinity) - (b.daysRemaining ?? Infinity),
    )
    .slice(0, limit);
}
