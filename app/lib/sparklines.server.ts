import prisma from "../db.server";
import { getStockStatus } from "./forecast.server";
import { dayKey, densify, toSeries, utcDayStart, type Series } from "./sparklines";

/**
 * Daily series behind the dashboard's KPI sparklines.
 *
 * Three of the five come from history recorded as it happened (SalesRecord,
 * ShopDailySnapshot). The stock-status counts are *reconstructed*: StockSnapshot stores
 * what each SKU's stock was on a given day, but not what its reorder point was, so the
 * series applies today's thresholds to historical stock. Editing a reorder point
 * therefore rewrites the shape of past days. That is acceptable for a trend line and not
 * for a headline number, which is why the current Low/Critical counts on the dashboard
 * are computed live rather than read from the last point of these series.
 */
export type DashboardSparklines = {
  unitsSold: Series | null;
  /**
   * Stock at cost *plus* COD float — the same sum the Capital KPI displays.
   *
   * Deliberately not the stock-at-cost series alone. A trend line that charts a different
   * quantity from the figure above it is worse than no trend at all, because it still
   * looks authoritative: the card would show total capital rising while the line beneath
   * it fell, with nothing on screen explaining why.
   */
  capital: Series | null;
  /**
   * COD float, matching the In-transit card's headline figure — which is a currency
   * amount, not the unit count in its caption. Same reasoning as `capital` above: the
   * line has to chart the number it sits under.
   */
  codFloat: Series | null;
  lowStock: Series | null;
  critical: Series | null;
};

/**
 * Build every dashboard sparkline in one round of queries.
 *
 * Deliberately not one query per card: this runs on every dashboard load. The stock
 * series is the largest read on the page — one row per product per day — so it is
 * aggregated in memory rather than issued as 30 grouped queries. All four are covered by
 * existing (shop, date) indexes.
 */
export async function getDashboardSparklines(
  shop: string,
  days = 30,
): Promise<DashboardSparklines> {
  const from = utcDayStart(days - 1);

  const [sales, snapshots, products, stockRows] = await Promise.all([
    prisma.salesRecord.groupBy({
      by: ["date"],
      where: { shop, date: { gte: from } },
      _sum: { quantity: true },
    }),
    prisma.shopDailySnapshot.findMany({
      where: { shop, date: { gte: from } },
      // inRouteUnits is recorded daily but not read here: both cards that could show it
      // lead with a currency figure, and their lines chart that instead.
      select: { date: true, stockAtCost: true, codFloat: true },
      orderBy: { date: "asc" },
    }),
    // Reorder points are current-only; no history of them exists. See the type doc above.
    prisma.product.findMany({
      where: { shop, isArchived: false },
      select: { id: true, reorderPoint: true },
    }),
    prisma.stockSnapshot.findMany({
      where: { shop, date: { gte: from } },
      select: { date: true, productId: true, stock: true },
    }),
  ]);

  // ---- units sold: real history, and a day with no row really is zero sales.
  const salesByDay = new Map(sales.map((r) => [dayKey(r.date), r._sum.quantity ?? 0]));
  const unitsSold = toSeries(
    densify(salesByDay, days, { carryForward: false }),
    salesByDay.size,
  );

  // ---- capital and in-route: recorded daily, gaps carried forward.
  const snapshotSeries = (value: (s: (typeof snapshots)[number]) => number) =>
    toSeries(
      densify(new Map(snapshots.map((s) => [dayKey(s.date), value(s)])), days, {
        carryForward: true,
      }),
      snapshots.length,
    );

  // ---- stock status: replay each day's stock against today's reorder points. Products
  // absent from a day's snapshot are skipped rather than counted as zero stock, which
  // would read as a stockout for every SKU added later than that day.
  const reorderPoints = new Map(products.map((p) => [p.id, p.reorderPoint]));
  const lowByDay = new Map<string, number>();
  const critByDay = new Map<string, number>();
  for (const row of stockRows) {
    const reorderPoint = reorderPoints.get(row.productId);
    if (reorderPoint === undefined) continue; // archived or deleted since
    const key = dayKey(row.date);
    const status = getStockStatus(row.stock, reorderPoint);
    if (status === "low") {
      lowByDay.set(key, (lowByDay.get(key) ?? 0) + 1);
    } else if (status === "critical" || status === "stockout") {
      critByDay.set(key, (critByDay.get(key) ?? 0) + 1);
    }
  }

  // Distinct days actually snapshotted — not the size of either count map, since a day on
  // which nothing was low is still an observed day and would otherwise shorten the window
  // below the threshold and hide a legitimately healthy shop's chart.
  const observedStockDays = new Set(stockRows.map((r) => dayKey(r.date))).size;

  return {
    unitsSold,
    // Matches the Capital KPI's own arithmetic — see the type doc.
    capital: snapshotSeries((s) => s.stockAtCost + s.codFloat),
    codFloat: snapshotSeries((s) => s.codFloat),
    lowStock: toSeries(densify(lowByDay, days, { carryForward: false }), observedStockDays),
    critical: toSeries(densify(critByDay, days, { carryForward: false }), observedStockDays),
  };
}
