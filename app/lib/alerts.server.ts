import prisma from "../db.server";

export async function generateAlerts(shop: string): Promise<number> {
  const [products, settings] = await Promise.all([
    prisma.product.findMany({ where: { shop } }),
    prisma.shopSettings.findUnique({ where: { shop } }),
  ]);

  const deadStockDays = settings?.deadStockDays ?? 60;
  const deadStockMinUnits = settings?.deadStockMinUnits ?? 20;

  await prisma.alert.deleteMany({ where: { shop, isRead: false } });

  const nDaysAgo = new Date(Date.now() - deadStockDays * 86400000);

  // Single query replacing N individual aggregates (N+1 fix)
  const salesSums = await prisma.salesRecord.groupBy({
    by: ["productId"],
    where: { shop, date: { gte: nDaysAgo } },
    _sum: { quantity: true },
  });
  const salesMap = new Map(
    salesSums.map((s) => [s.productId, s._sum.quantity ?? 0]),
  );

  // Return rate spike detection: compare latest week vs 4-week avg
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
  const returnRateRecords = await prisma.returnRateHistory.findMany({
    where: { shop, weekStart: { gte: fourWeeksAgo } },
    orderBy: [{ productId: "asc" }, { weekStart: "desc" }],
  });
  // Group by productId
  const rrByProduct = new Map<
    string,
    { weekStart: Date; returnRate: number }[]
  >();
  for (const r of returnRateRecords) {
    const arr = rrByProduct.get(r.productId) ?? [];
    arr.push({ weekStart: r.weekStart, returnRate: r.returnRate });
    rrByProduct.set(r.productId, arr);
  }

  const alerts: {
    shop: string;
    type: string;
    productId: string;
    message: string;
  }[] = [];

  for (const product of products) {
    const displayName = product.variantTitle
      ? `${product.title} — ${product.variantTitle}`
      : product.title;

    if (product.currentStock <= 0) {
      alerts.push({
        shop,
        type: "stockout",
        productId: product.id,
        message: `${displayName} is out of stock.`,
      });
    } else if (product.currentStock <= product.reorderPoint) {
      alerts.push({
        shop,
        type: "low_stock",
        productId: product.id,
        message: `${displayName} is below reorder point (${product.currentStock} units left, reorder at ${product.reorderPoint}).`,
      });
    }

    // Dead stock: stock above threshold with no sales in configured period
    if (product.currentStock >= deadStockMinUnits) {
      const totalSold = salesMap.get(product.id) ?? 0;
      if (totalSold === 0) {
        alerts.push({
          shop,
          type: "dead_stock",
          productId: product.id,
          message: `${displayName} may be dead stock — ${product.currentStock} units with no sales in ${deadStockDays} days.`,
        });
      }
    }

    // Return rate spike: latest week > 1.5× 4-week average
    const rrHistory = rrByProduct.get(product.id) ?? [];
    if (rrHistory.length >= 2) {
      const [latest, ...older] = rrHistory;
      const olderAvg =
        older.reduce((s, r) => s + r.returnRate, 0) / older.length;
      if (olderAvg > 0 && latest.returnRate > olderAvg * 1.5 && latest.returnRate > 0.3) {
        alerts.push({
          shop,
          type: "return_rate_spike",
          productId: product.id,
          message: `${displayName} return rate spiked to ${(latest.returnRate * 100).toFixed(0)}% (was ${(olderAvg * 100).toFixed(0)}% avg).`,
        });
      }
    }
  }

  if (alerts.length > 0) {
    await prisma.alert.createMany({ data: alerts });
  }

  return alerts.length;
}

export async function getUnreadAlerts(shop: string) {
  return prisma.alert.findMany({
    where: { shop, isRead: false },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
}

/**
 * Every active alert for a shop, uncapped — for notification dispatch, which reconciles
 * against the complete set. Do not swap this for getUnreadAlerts(): its `take` would make
 * the alerts beyond the cap look like cleared conditions.
 */
export async function getAllUnreadAlerts(shop: string) {
  return prisma.alert.findMany({
    where: { shop, isRead: false },
    orderBy: { createdAt: "desc" },
  });
}

export async function markAlertRead(id: string) {
  return prisma.alert.update({ where: { id }, data: { isRead: true } });
}
