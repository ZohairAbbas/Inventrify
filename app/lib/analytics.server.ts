import prisma from "../db.server";
import { previousRange, type DateRange } from "./date-range";
import { getStockStatus } from "./forecast.server";
import { getInventoryPositions } from "./planning.server";

/** Daily sales totals across all products for the last N days */
export async function getSalesTrend(shop: string, range: DateRange) {
  const records = await prisma.salesRecord.findMany({
    where: { shop, date: { gte: range.from, lt: range.to } },
    select: { date: true, quantity: true },
    orderBy: { date: "asc" },
  });

  const byDate = new Map<string, number>();
  for (const r of records) {
    const d = r.date.toISOString().slice(0, 10);
    byDate.set(d, (byDate.get(d) ?? 0) + r.quantity);
  }

  // Walk the window itself rather than counting back from today, so a custom range
  // that ends in the past plots its own days instead of a trailing block of zeros.
  const result: { date: string; quantity: number }[] = [];
  for (let t = range.from.getTime(); t < range.to.getTime(); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    result.push({ date: d, quantity: byDate.get(d) ?? 0 });
  }
  return result;
}

/** Period-over-period totals: the last `days` against the equal window before it. */
export async function getPeriodComparison(shop: string, range: DateRange) {
  const prior = previousRange(range);

  const [current, priorAgg] = await Promise.all([
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: range.from, lt: range.to } },
      _sum: { quantity: true },
    }),
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: prior.from, lt: prior.to } },
      _sum: { quantity: true },
    }),
  ]);

  const currentTotal = current._sum.quantity ?? 0;
  const priorTotal = priorAgg._sum.quantity ?? 0;
  const change =
    priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : null;

  return { currentTotal, priorTotal, changePct: change };
}

/** Top N products by units sold in last N days */
export async function getTopMovers(shop: string, range: DateRange, limit = 10) {
  const sums = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: range.from, lt: range.to } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });

  const ids = sums.map((s) => s.productId);
  // Shop-scoped. The ids happen to come from a shop-filtered groupBy, but a bare
  // findMany by id is one refactor away from leaking across tenants.
  const products = await prisma.product.findMany({
    where: { id: { in: ids }, shop },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  return sums
    .map((s) => ({
      product: productMap.get(s.productId),
      totalSold: s._sum.quantity ?? 0,
    }))
    .filter((r) => r.product != null) as {
    product: (typeof products)[0];
    totalSold: number;
  }[];
}

/** Products with no sales in N days but stock above minimum */
export async function getDeadStock(shop: string, days = 60, minUnits = 20) {
  const since = new Date(Date.now() - days * 86400000);

  // Candidates first, then subtract the ones that sold. Passing every active product id
  // into a `notIn` sent the whole catalogue to the database on each call, which is fine
  // at 500 SKUs and a problem at 50k.
  const candidates = await prisma.product.findMany({
    where: { shop, isArchived: false, currentStock: { gte: minUnits } },
    orderBy: { currentStock: "desc" },
    take: 200,
  });
  if (candidates.length === 0) return [];

  const sold = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: {
      shop,
      date: { gte: since },
      productId: { in: candidates.map((c) => c.id) },
    },
    _sum: { quantity: true },
    having: { quantity: { _sum: { gt: 0 } } },
  });
  const soldIds = new Set(sold.map((s) => s.productId));

  return candidates.filter((c) => !soldIds.has(c.id)).slice(0, 20);
}

/** Count of products by stock status */
export async function getStatusDistribution(shop: string) {
  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: { id: true, currentStock: true, reorderPoint: true },
  });

  // Judged on inventory position so the distribution matches what the inventory page
  // shows, rather than counting reordered SKUs as still critical.
  const positions = await getInventoryPositions(shop, products.map((p) => p.id));

  const dist = { healthy: 0, low: 0, critical: 0, stockout: 0 };
  for (const p of products) {
    const position = positions.get(p.id)?.position ?? p.currentStock;
    dist[getStockStatus(position, p.reorderPoint)]++;
  }
  return dist;
}

/** Top products by COD return rate */
export async function getHighReturnRateProducts(shop: string, limit = 10) {
  return prisma.product.findMany({
    where: { shop, isArchived: false, codReturnRate: { gt: 0 } },
    orderBy: { codReturnRate: "desc" },
    take: limit,
    select: {
      id: true,
      title: true,
      variantTitle: true,
      sku: true,
      codReturnRate: true,
      currentStock: true,
      avgDailySales: true,
    },
  });
}

/** Stock snapshot trend for a product (last 30 days) */
export async function getStockTrend(productId: string) {
  const since = new Date(Date.now() - 30 * 86400000);
  return prisma.stockSnapshot.findMany({
    where: { productId, date: { gte: since } },
    orderBy: { date: "asc" },
    select: { date: true, stock: true },
  });
}

export interface RegionRto {
  city: string;
  shippedUnits: number;
  returnedUnits: number;
  /** 0..1 — returned / shipped. */
  rtoRate: number;
}

/**
 * RTO broken down by delivery city.
 *
 * A shop-wide return rate averages together routes that behave completely differently —
 * in these markets the spread between a metro and an upcountry route is routinely
 * 15-20 percentage points. Without the breakdown there is no way to see which
 * destinations are unprofitable, or to act on them (COD-restrict, prepay-only, switch
 * carrier).
 *
 * Only COD orders form the denominator: a prepaid order that is refused is not an RTO in
 * the sense that matters here.
 */
export async function getRtoByRegion(
  shop: string,
  range: DateRange,
  minShipped = 10,
): Promise<RegionRto[]> {
  const [shipped, returned] = await Promise.all([
    prisma.orderRegion.groupBy({
      by: ["city"],
      where: {
        shop,
        isCod: true,
        orderedAt: { gte: range.from, lt: range.to },
        city: { not: null },
      },
      _sum: { units: true },
    }),
    prisma.returnItem.groupBy({
      by: ["city"],
      where: {
        shop,
        city: { not: null },
        createdAt: { gte: range.from, lt: range.to },
      },
      _sum: { quantity: true },
    }),
  ]);

  const returnedByCity = new Map(
    returned
      .filter((r) => r.city != null)
      .map((r) => [r.city as string, r._sum.quantity ?? 0]),
  );

  return shipped
    .filter((s) => s.city != null)
    .map((s) => {
      const city = s.city as string;
      const shippedUnits = s._sum.units ?? 0;
      const returnedUnits = returnedByCity.get(city) ?? 0;
      return {
        city,
        shippedUnits,
        returnedUnits,
        rtoRate: shippedUnits > 0 ? returnedUnits / shippedUnits : 0,
      };
    })
    // Small samples produce meaningless rates; a city with 2 shipments and 1 return is
    // not a 50% RTO route.
    .filter((r) => r.shippedUnits >= minShipped)
    .sort((a, b) => b.rtoRate - a.rtoRate);
}

export interface CodFunnel {
  placed: number;
  confirmed: number;
  dispatched: number;
  cancelled: number;
  /** Placed but neither dispatched nor cancelled — still sitting in limbo. */
  pending: number;
  /** False when the merchant has not told us which tag marks an order confirmed. */
  confirmationTracked: boolean;
  /** Share of placed orders that never reached dispatch. */
  attritionRate: number;
}

/**
 * The COD order funnel: placed -> confirmed -> dispatched.
 *
 * This matters for inventory, not just reporting. Demand is recorded when an order is
 * *placed*, but only *dispatched* units actually consume stock. In COD markets a
 * meaningful share of placed orders never ship — call-centre confirmation fails, the
 * number is unreachable, the order is fake. Every one of those inflates the demand signal
 * that drives reorder points.
 *
 * Cancellations are already backed out of demand by the orders/cancelled webhook. What
 * this exposes is the rest of the gap: orders that quietly never dispatch. Surfacing the
 * attrition rate lets a merchant judge how much to trust the forecast, rather than the app
 * silently changing the demand basis underneath them.
 */
export async function getCodFunnel(shop: string, range: DateRange): Promise<CodFunnel> {
  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { confirmedOrderTag: true },
  });
  const confirmationTracked = !!settings?.confirmedOrderTag?.trim();

  const scope = { shop, isCod: true, orderedAt: { gte: range.from, lt: range.to } };
  const [placed, confirmed, dispatched, cancelled] = await Promise.all([
    prisma.orderRegion.count({ where: scope }),
    prisma.orderRegion.count({ where: { ...scope, isConfirmed: true } }),
    prisma.orderRegion.count({ where: { ...scope, isDispatched: true } }),
    prisma.orderRegion.count({ where: { ...scope, isCancelled: true } }),
  ]);

  const pending = Math.max(0, placed - dispatched - cancelled);

  return {
    placed,
    confirmed,
    dispatched,
    cancelled,
    pending,
    confirmationTracked,
    attritionRate: placed > 0 ? (placed - dispatched) / placed : 0,
  };
}
