import prisma from "../db.server";

/**
 * Full safety stock formula for COD markets:
 * SS = Z × σ_demand × √leadTime + Z × avgDailySales × σ_leadTime
 *
 * Where:
 *   Z            = service level Z-score (1.28=90%, 1.65=95%, 2.05=98%)
 *   σ_demand     = std dev of daily demand over last 90 days
 *   leadTime     = avg lead time in days
 *   avgDailySales = mean daily sales
 *   σ_leadTime   = std dev of actual lead times (from supplier history)
 */
export function calculateSafetyStock(
  z: number,
  demandStdDev: number,
  leadTimeDays: number,
  avgDailySales: number,
  leadTimeStdDev = 0,
): number {
  const demandComponent = z * demandStdDev * Math.sqrt(leadTimeDays);
  const leadTimeComponent = z * avgDailySales * leadTimeStdDev;
  return Math.max(0, Math.ceil(demandComponent + leadTimeComponent));
}

/** Compute standard deviation of daily demand from SalesRecord rows */
export function computeDemandStdDev(
  salesRows: { quantity: number }[],
  periodDays: number,
): number {
  // Build daily quantities including zero-days
  const dailyQty: number[] = salesRows.map((r) => r.quantity);
  const zeroDays = Math.max(0, periodDays - dailyQty.length);
  for (let i = 0; i < zeroDays; i++) dailyQty.push(0);

  const mean = dailyQty.reduce((a, b) => a + b, 0) / dailyQty.length;
  const variance =
    dailyQty.reduce((sum, q) => sum + Math.pow(q - mean, 2), 0) /
    dailyQty.length;
  return Math.sqrt(variance);
}

/** Compute and persist safetyStock on a product */
export async function recomputeSafetyStock(
  productId: string,
  shop: string,
): Promise<number> {
  const [product, settings] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      include: { supplier: true },
    }),
    prisma.shopSettings.findUnique({ where: { shop } }),
  ]);

  if (!product) return 0;

  const z = settings?.serviceLevel ?? 1.65;
  const fallbackDays = settings?.safetyStockDays ?? 7;

  const ninetyDaysAgo = new Date(Date.now() - 90 * 86400000);
  const salesRows = await prisma.salesRecord.findMany({
    where: { productId, date: { gte: ninetyDaysAgo } },
    select: { quantity: true },
  });

  if (salesRows.length < 7) {
    // Not enough data — fall back to simple formula
    const fallback = Math.ceil(product.avgDailySales * fallbackDays);
    await prisma.product.update({
      where: { id: productId },
      data: { safetyStock: fallback },
    });
    return fallback;
  }

  const demandStdDev = computeDemandStdDev(salesRows, 90);
  const leadTimeDays =
    product.supplier?.avgActualLeadTime ?? product.leadTimeDays;
  const leadTimeStdDev = product.supplier?.leadTimeVariance ?? 0;

  const ss = calculateSafetyStock(
    z,
    demandStdDev,
    leadTimeDays,
    product.avgDailySales,
    leadTimeStdDev,
  );

  await prisma.product.update({
    where: { id: productId },
    data: { safetyStock: ss },
  });

  return ss;
}
