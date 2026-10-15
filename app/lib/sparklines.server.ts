import prisma from "../db.server";
import { dayKey, densify, toSeries, utcDayStart, type Series } from "./sparklines";

/** Daily series behind the dashboard's trend lines. Both are history recorded as it happened. */
export type DashboardSparklines = {
  /** Units sold per day, under the period's "Stock out · sold" tile. */
  unitsSold: Series | null;
  /**
   * On-hand stock at cost, from ShopDailySnapshot — the same arithmetic
   * (computeStockAtCost) as the "Inventory cost" figure it sits under. A line charting a
   * different quantity from the number above it is worse than no line, because it still
   * looks authoritative.
   */
  stockAtCost: Series | null;
};

/** Build every dashboard sparkline in one round of queries; both use (shop, date) indexes. */
export async function getDashboardSparklines(
  shop: string,
  days = 30,
): Promise<DashboardSparklines> {
  const from = utcDayStart(days - 1);

  const [sales, snapshots] = await Promise.all([
    prisma.salesRecord.groupBy({
      by: ["date"],
      where: { shop, date: { gte: from } },
      _sum: { quantity: true },
    }),
    prisma.shopDailySnapshot.findMany({
      where: { shop, date: { gte: from } },
      select: { date: true, stockAtCost: true },
      orderBy: { date: "asc" },
    }),
  ]);

  // Real history: a day with no row really is zero sales.
  const salesByDay = new Map(sales.map((r) => [dayKey(r.date), r._sum.quantity ?? 0]));
  const unitsSold = toSeries(
    densify(salesByDay, days, { carryForward: false }),
    salesByDay.size,
  );

  // Recorded daily; a missed day carries the previous reading rather than reading as a dip.
  const stockAtCost = toSeries(
    densify(new Map(snapshots.map((s) => [dayKey(s.date), s.stockAtCost])), days, {
      carryForward: true,
    }),
    snapshots.length,
  );

  return { unitsSold, stockAtCost };
}
