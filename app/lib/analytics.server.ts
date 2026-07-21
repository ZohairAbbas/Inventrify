import prisma from "../db.server";
import { getStockStatus } from "./forecast.server";
import { getInventoryPositions } from "./planning.server";

/** Daily sales totals across all products for the last N days */
export async function getSalesTrend(shop: string, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const records = await prisma.salesRecord.findMany({
    where: { shop, date: { gte: since } },
    select: { date: true, quantity: true },
    orderBy: { date: "asc" },
  });

  const byDate = new Map<string, number>();
  for (const r of records) {
    const d = r.date.toISOString().slice(0, 10);
    byDate.set(d, (byDate.get(d) ?? 0) + r.quantity);
  }

  const result: { date: string; quantity: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    result.push({ date: d, quantity: byDate.get(d) ?? 0 });
  }
  return result;
}

/** Period-over-period totals: last 30d vs prior 30d */
export async function getPeriodComparison(shop: string) {
  const now = Date.now();
  const thirtyDaysAgo = new Date(now - 30 * 86400000);
  const sixtyDaysAgo = new Date(now - 60 * 86400000);

  const [current, prior] = await Promise.all([
    prisma.salesRecord.aggregate({
      where: { shop, date: { gte: thirtyDaysAgo } },
      _sum: { quantity: true },
    }),
    prisma.salesRecord.aggregate({
      where: {
        shop,
        date: { gte: sixtyDaysAgo, lt: thirtyDaysAgo },
      },
      _sum: { quantity: true },
    }),
  ]);

  const currentTotal = current._sum.quantity ?? 0;
  const priorTotal = prior._sum.quantity ?? 0;
  const change =
    priorTotal > 0 ? ((currentTotal - priorTotal) / priorTotal) * 100 : null;

  return { currentTotal, priorTotal, changePct: change };
}

/** Top N products by units sold in last N days */
export async function getTopMovers(shop: string, days = 30, limit = 10) {
  const since = new Date(Date.now() - days * 86400000);
  const sums = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: since } },
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
