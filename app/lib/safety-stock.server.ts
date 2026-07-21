import prisma from "../db.server";
import { estimateDemand, stdDev } from "./demand.server";
import { serviceLevelZFor } from "./planning.server";

/**
 * Safety stock for COD:
 *
 *   SS = Z × σ_error × √leadTime + Z × avgDailySales × σ_leadTime
 *
 * σ_error is the standard deviation of *forecast error*, not of raw demand. This is the
 * textbook input and it matters here: for a trending or seasonal SKU the two differ a
 * lot, and using raw demand variance charges the buffer for variation the model already
 * predicts. Raw demand σ is the fallback when there is not enough history to backtest.
 *
 * The second term covers supply-side variability — the supplier arriving late — which is
 * usually the dominant risk in these markets.
 */
export function calculateSafetyStock(
  z: number,
  errorStdDev: number,
  leadTimeDays: number,
  avgDailySales: number,
  leadTimeStdDev = 0,
): number {
  const demandComponent = z * errorStdDev * Math.sqrt(Math.max(0, leadTimeDays));
  const leadTimeComponent = z * avgDailySales * Math.max(0, leadTimeStdDev);
  return Math.max(0, Math.ceil(demandComponent + leadTimeComponent));
}

/**
 * Standard deviation of daily demand from sparse rows.
 *
 * `periodDays` must be the number of days the SKU has actually existed, not a fixed
 * window: padding a three-week-old product out to 90 days invents 70 zero-demand days
 * and inflates σ, and therefore its safety stock, for no reason.
 */
export function computeDemandStdDev(
  salesRows: { quantity: number }[],
  periodDays: number,
): number {
  const dailyQty: number[] = salesRows.map((r) => r.quantity);
  const zeroDays = Math.max(0, periodDays - dailyQty.length);
  for (let i = 0; i < zeroDays; i++) dailyQty.push(0);
  return stdDev(dailyQty);
}

/** Compute and persist safetyStock on a product. */
export async function recomputeSafetyStock(
  productId: string,
  shop: string,
): Promise<number> {
  const [product, settings] = await Promise.all([
    // Scoped by shop: a product id alone must not be enough to touch another tenant.
    prisma.product.findFirst({
      where: { id: productId, shop },
      include: { supplier: true },
    }),
    prisma.shopSettings.findUnique({ where: { shop } }),
  ]);

  if (!product) return 0;

  const baseZ = settings?.serviceLevel ?? 1.65;
  const z = serviceLevelZFor(product.abcClass, baseZ);
  const fallbackDays = settings?.safetyStockDays ?? 7;

  const windowStart = new Date(Date.now() - 90 * 86400000);
  const salesRows = await prisma.salesRecord.findMany({
    where: { productId, date: { gte: windowStart } },
    select: { quantity: true, date: true },
  });

  if (salesRows.length < 7) {
    // Not enough data — fall back to a simple days-of-cover buffer.
    const fallback = Math.ceil(product.avgDailySales * fallbackDays);
    await prisma.product.update({
      where: { id: productId },
      data: { safetyStock: fallback },
    });
    return fallback;
  }

  const estimate = estimateDemand(salesRows, {
    windowStart,
    firstSoldAt: product.firstSoldAt,
  });

  // Prefer backtested forecast error; fall back to demand variability.
  const errorStdDev = estimate.residualStdDev ?? estimate.demandStdDev;

  const leadTimeDays = product.supplier?.avgActualLeadTime ?? product.leadTimeDays;
  const leadTimeStdDev = product.supplier?.leadTimeVariance ?? 0;

  const ss = calculateSafetyStock(
    z,
    errorStdDev,
    leadTimeDays,
    estimate.dailyRate,
    leadTimeStdDev,
  );

  await prisma.product.update({
    where: { id: productId },
    data: { safetyStock: ss },
  });

  return ss;
}
