import prisma from "../db.server";
import { getStockStatus } from "./forecast.server";

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
  const products = await prisma.product.findMany({ where: { id: { in: ids } } });
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
  const activeSales = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: since } },
    _sum: { quantity: true },
    having: { quantity: { _sum: { gt: 0 } } },
  });
  const activeIds = new Set(activeSales.map((s) => s.productId));

  return prisma.product.findMany({
    where: {
      shop,
      currentStock: { gte: minUnits },
      id: { notIn: Array.from(activeIds) },
    },
    orderBy: { currentStock: "desc" },
    take: 20,
  });
}

/** Count of products by stock status */
export async function getStatusDistribution(shop: string) {
  const products = await prisma.product.findMany({
    where: { shop },
    select: { currentStock: true, reorderPoint: true },
  });

  const dist = { healthy: 0, low: 0, critical: 0, stockout: 0 };
  for (const p of products) {
    dist[getStockStatus(p.currentStock, p.reorderPoint)]++;
  }
  return dist;
}

/** Top products by COD return rate */
export async function getHighReturnRateProducts(shop: string, limit = 10) {
  return prisma.product.findMany({
    where: { shop, codReturnRate: { gt: 0 } },
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
