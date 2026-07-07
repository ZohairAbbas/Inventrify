import prisma from "../db.server";
import { calculateSafetyStock, computeDemandStdDev } from "./safety-stock.server";
import { getHorizonMultiplier } from "./seasonality.server";

export interface OrderHistoryItem {
  quantity: number;
  createdAt: Date;
}

export interface ForecastResult {
  grossDemand: number;
  netDemand: number;
  deliveryRate: number;
  confidence: number;
  safetyStock: number;
  eventMultiplier: number;
}

export function forecastDemand(
  orderHistory: OrderHistoryItem[],
  days: number,
  codReturnRate: number,
  safetyStock = 0,
  eventMultiplier = 1.0,
): ForecastResult {
  const now = new Date();
  const cutoff90 = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const cutoff30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const last90 = orderHistory.filter((o) => o.createdAt >= cutoff90);
  const last30 = last90.filter((o) => o.createdAt >= cutoff30);

  const last90Total = last90.reduce((sum, o) => sum + o.quantity, 0);
  const last30Total = last30.reduce((sum, o) => sum + o.quantity, 0);
  const older60Total = last90Total - last30Total;

  const recentAvg = last30Total / 30;
  const olderAvg = older60Total / 60;
  // Recent 30d weighted 2x vs older 60d
  const weightedAvg = (recentAvg * 2 + olderAvg) / 3;

  const rawGross = Math.ceil(weightedAvg * days);
  const grossDemand = Math.ceil(rawGross * eventMultiplier);

  const deliveryRate = 1 - codReturnRate;
  const netDemand = Math.ceil(grossDemand * deliveryRate);

  // Confidence: higher with more data, lower with high return rates
  const dataPointDensity = Math.min(1, last90.length / 30);
  const confidence = Math.min(0.95, Math.max(0.2, dataPointDensity * 0.9));

  return { grossDemand, netDemand, deliveryRate, confidence, safetyStock, eventMultiplier };
}

export function calculateReorderPoint(
  avgDailySales: number,
  leadTimeDays: number,
  safetyStock = 0,
): number {
  return Math.ceil(avgDailySales * leadTimeDays) + safetyStock;
}

export function calculateDaysRemaining(
  currentStock: number,
  avgDailySales: number,
): number {
  if (avgDailySales <= 0) return 999;
  return Math.floor(currentStock / avgDailySales);
}

export function getStockStatus(
  currentStock: number,
  reorderPoint: number,
): "healthy" | "low" | "critical" | "stockout" {
  if (currentStock <= 0) return "stockout";
  if (currentStock <= reorderPoint * 0.5) return "critical";
  if (currentStock <= reorderPoint) return "low";
  return "healthy";
}

/** Generate forecasts for a product with safety stock + seasonality applied */
export async function generateAndSaveForecast(
  productId: string,
  shop: string,
  codReturnRate: number,
): Promise<{ f30: ForecastResult; f60: ForecastResult; f90: ForecastResult }> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [records, settings, product] = await Promise.all([
    prisma.salesRecord.findMany({
      where: { productId, date: { gte: ninetyDaysAgo } },
      orderBy: { date: "asc" },
    }),
    prisma.shopSettings.findUnique({ where: { shop } }),
    prisma.product.findUnique({
      where: { id: productId },
      include: { supplier: true },
    }),
  ]);

  const history: OrderHistoryItem[] = records.map((r) => ({
    quantity: r.quantity,
    createdAt: r.date,
  }));

  // Compute safety stock using proper formula
  const z = settings?.serviceLevel ?? 1.65;
  const fallbackDays = settings?.safetyStockDays ?? 7;
  const avgDailySales = product?.avgDailySales ?? 0;
  const leadTimeDays =
    product?.supplier?.avgActualLeadTime ?? product?.leadTimeDays ?? 7;
  const leadTimeStdDev = product?.supplier?.leadTimeVariance ?? 0;

  let safetyStock: number;
  if (records.length >= 7) {
    const demandStdDev = computeDemandStdDev(records, 90);
    safetyStock = calculateSafetyStock(
      z,
      demandStdDev,
      leadTimeDays,
      avgDailySales,
      leadTimeStdDev,
    );
  } else {
    safetyStock = Math.ceil(avgDailySales * fallbackDays);
  }

  // Get seasonality multipliers for each horizon
  const [mult30, mult60, mult90] = await Promise.all([
    getHorizonMultiplier(shop, 30),
    getHorizonMultiplier(shop, 60),
    getHorizonMultiplier(shop, 90),
  ]);

  const f30 = forecastDemand(history, 30, codReturnRate, safetyStock, mult30);
  const f60 = forecastDemand(history, 60, codReturnRate, safetyStock, mult60);
  const f90 = forecastDemand(history, 90, codReturnRate, safetyStock, mult90);

  const now = new Date();

  await prisma.$transaction([
    // Update product's safetyStock cache
    prisma.product.update({
      where: { id: productId },
      data: { safetyStock },
    }),
    // Upsert forecasts
    prisma.forecast.upsert({
      where: { productId_horizon: { productId, horizon: 30 } },
      create: {
        shop,
        productId,
        horizon: 30,
        forecastDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        grossDemand: f30.grossDemand,
        netDemand: f30.netDemand,
        confidence: f30.confidence,
        seasonalityApplied: mult30 !== 1.0,
        eventMultiplier: mult30,
        safetyStockUsed: safetyStock,
      },
      update: {
        forecastDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        grossDemand: f30.grossDemand,
        netDemand: f30.netDemand,
        confidence: f30.confidence,
        seasonalityApplied: mult30 !== 1.0,
        eventMultiplier: mult30,
        safetyStockUsed: safetyStock,
      },
    }),
    prisma.forecast.upsert({
      where: { productId_horizon: { productId, horizon: 60 } },
      create: {
        shop,
        productId,
        horizon: 60,
        forecastDate: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
        grossDemand: f60.grossDemand,
        netDemand: f60.netDemand,
        confidence: f60.confidence,
        seasonalityApplied: mult60 !== 1.0,
        eventMultiplier: mult60,
        safetyStockUsed: safetyStock,
      },
      update: {
        forecastDate: new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000),
        grossDemand: f60.grossDemand,
        netDemand: f60.netDemand,
        confidence: f60.confidence,
        seasonalityApplied: mult60 !== 1.0,
        eventMultiplier: mult60,
        safetyStockUsed: safetyStock,
      },
    }),
    prisma.forecast.upsert({
      where: { productId_horizon: { productId, horizon: 90 } },
      create: {
        shop,
        productId,
        horizon: 90,
        forecastDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
        grossDemand: f90.grossDemand,
        netDemand: f90.netDemand,
        confidence: f90.confidence,
        seasonalityApplied: mult90 !== 1.0,
        eventMultiplier: mult90,
        safetyStockUsed: safetyStock,
      },
      update: {
        forecastDate: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
        grossDemand: f90.grossDemand,
        netDemand: f90.netDemand,
        confidence: f90.confidence,
        seasonalityApplied: mult90 !== 1.0,
        eventMultiplier: mult90,
        safetyStockUsed: safetyStock,
      },
    }),
  ]);

  return { f30, f60, f90 };
}
