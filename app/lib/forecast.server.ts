import prisma from "../db.server";
import { calculateSafetyStock } from "./safety-stock.server";
import {
  getHorizonMultiplier,
  getLeadTimeMultiplier,
  getLeadTimeStretch,
} from "./seasonality.server";
import { estimateDemand, type DemandMethod } from "./demand.server";
import {
  computeProcurementPlan,
  estimateRestockRate,
  getInventoryPositions,
  resolveReturnRate,
  serviceLevelZFor,
} from "./planning.server";

const DAY_MS = 86400000;

export interface OrderHistoryItem {
  quantity: number;
  createdAt: Date;
}

export interface ForecastResult {
  /** Units that must physically ship over the horizon. Drives stock cover. */
  grossDemand: number;
  /** Units expected to be kept by customers. Drives revenue, never stock. */
  netDemand: number;
  /** Units to buy: gross minus sellable RTO units arriving in the horizon. */
  procurementUnits: number;
  expectedReturnsSellable: number;
  deliveryRate: number;
  confidence: number;
  safetyStock: number;
  eventMultiplier: number;
  method: DemandMethod;
  /** 80% prediction interval around grossDemand. */
  pi80Low: number;
  pi80High: number;
}

/** z for a two-sided 80% interval. */
const Z80 = 1.2816;

/**
 * Turn a daily demand rate into a horizon forecast.
 *
 * `codReturnRate` no longer reduces the planning quantity. It splits it: gross is what
 * ships, net is what is kept, and returns re-enter as supply. See planning.server.ts for
 * why treating RTO as a demand reduction systematically under-buys.
 */
export function forecastDemand(
  dailyRate: number,
  days: number,
  codReturnRate: number,
  safetyStock = 0,
  eventMultiplier = 1.0,
  opts: {
    residualStdDev?: number | null;
    method?: DemandMethod;
    observedDays?: number;
    restockRate?: number;
  } = {},
): ForecastResult {
  const grossDemand = Math.max(0, Math.ceil(dailyRate * days * eventMultiplier));

  const deliveryRate = 1 - Math.min(1, Math.max(0, codReturnRate));
  const netDemand = Math.ceil(grossDemand * deliveryRate);

  const restockRate = opts.restockRate ?? 0.75;
  const expectedReturnsSellable = Math.floor(
    grossDemand * Math.min(1, Math.max(0, codReturnRate)) * restockRate,
  );
  const procurementUnits = Math.max(0, grossDemand - expectedReturnsSellable);

  // Prediction interval from backtested one-step error, widened over the horizon by
  // sqrt(h) (errors accumulate as a random walk). Falls back to a wide-but-honest band
  // when there is no residual estimate.
  const residual = opts.residualStdDev;
  let pi80Low = grossDemand;
  let pi80High = grossDemand;
  if (residual != null && residual > 0) {
    const spread = Z80 * residual * Math.sqrt(days);
    pi80Low = Math.max(0, Math.floor(grossDemand - spread));
    pi80High = Math.ceil(grossDemand + spread);
  }

  // Confidence reflects how much history backs the estimate AND how wide the interval
  // is relative to the point forecast. The old value was min(0.95, days_with_sales/30 *
  // 0.9) — purely a row count, presented to merchants as forecast reliability.
  const observedDays = opts.observedDays ?? 0;
  const coverage = Math.min(1, observedDays / 60);
  const relativeSpread =
    grossDemand > 0 && pi80High > pi80Low
      ? Math.min(1, (pi80High - pi80Low) / (2 * grossDemand))
      : residual == null
        ? 1
        : 0;
  const confidence = Math.min(0.95, Math.max(0.05, coverage * (1 - relativeSpread)));

  return {
    grossDemand,
    netDemand,
    procurementUnits,
    expectedReturnsSellable,
    deliveryRate,
    confidence,
    safetyStock,
    eventMultiplier,
    method: opts.method ?? "moving_average",
    pi80Low,
    pi80High,
  };
}

/**
 * Reorder point = demand over the lead time + safety stock.
 *
 * Both seasonal inputs are applied here, and both were previously missing. Seasonality
 * only ever touched the forecast table, so during Ramadan or White Friday the reorder
 * points, status badges, alerts and bulk-PO quantities all still assumed baseline
 * demand — the app could not tell anyone to buy for the peak. Lead-time stretch matters
 * for the same reason: ordering on a normal lead time during a peak arrives late.
 */
export function calculateReorderPoint(
  avgDailySales: number,
  leadTimeDays: number,
  safetyStock = 0,
  demandMultiplier = 1.0,
  leadTimeMultiplier = 1.0,
): number {
  const effectiveLeadTime = Math.max(0, leadTimeDays) * Math.max(1, leadTimeMultiplier);
  return (
    Math.ceil(Math.max(0, avgDailySales) * effectiveLeadTime * Math.max(0, demandMultiplier)) +
    safetyStock
  );
}

/**
 * Days of cover remaining. Returns null — not a sentinel — when there is no demand to
 * divide by. The old code returned 999 from one call site and silently substituted a
 * 0.5/day floor at another, so the same "no demand" state was reported two different
 * ways, both of which looked like real numbers.
 */
export function calculateDaysRemaining(
  currentStock: number,
  avgDailySales: number,
): number | null {
  if (avgDailySales <= 0) return null;
  // Negative stock means the shop has oversold and owes units; there is no runway left
  // to count down. Dividing it through produced displays like "-136d", which reads as a
  // measurement but means nothing to anyone.
  if (currentStock <= 0) return 0;
  return Math.floor(currentStock / avgDailySales);
}

export function getStockStatus(
  inventoryPosition: number,
  reorderPoint: number,
): "healthy" | "low" | "critical" | "stockout" {
  if (inventoryPosition <= 0) return "stockout";
  if (reorderPoint <= 0) return "healthy";
  if (inventoryPosition <= reorderPoint * 0.5) return "critical";
  if (inventoryPosition <= reorderPoint) return "low";
  return "healthy";
}

/** Generate forecasts for a product with safety stock + seasonality applied */
export async function generateAndSaveForecast(
  productId: string,
  shop: string,
  codReturnRate?: number,
): Promise<{ f30: ForecastResult; f60: ForecastResult; f90: ForecastResult }> {
  const windowStart = new Date(Date.now() - 90 * DAY_MS);

  const [records, settings, product] = await Promise.all([
    prisma.salesRecord.findMany({
      where: { productId, date: { gte: windowStart } },
      orderBy: { date: "asc" },
    }),
    prisma.shopSettings.findUnique({ where: { shop } }),
    // Shop-scoped: previously a bare findUnique by id.
    prisma.product.findFirst({
      where: { id: productId, shop },
      include: { supplier: true },
    }),
  ]);

  if (!product) {
    const empty = forecastDemand(0, 30, 0, 0, 1);
    return { f30: empty, f60: empty, f90: empty };
  }

  const estimate = estimateDemand(records, {
    windowStart,
    firstSoldAt: product.firstSoldAt,
  });

  const baseZ = settings?.serviceLevel ?? 1.65;
  const z = serviceLevelZFor(product.abcClass, baseZ);
  const fallbackDays = settings?.safetyStockDays ?? 7;
  const leadTimeDays = product.supplier?.avgActualLeadTime ?? product.leadTimeDays ?? 7;
  const leadTimeStdDev = product.supplier?.leadTimeVariance ?? 0;

  const errorStdDev = estimate.residualStdDev ?? estimate.demandStdDev;

  const safetyStock =
    records.length >= 7
      ? calculateSafetyStock(z, errorStdDev, leadTimeDays, estimate.dailyRate, leadTimeStdDev)
      : Math.ceil(estimate.dailyRate * fallbackDays);

  // RTO rate: the resolved, single-writer value.
  const resolved = resolveReturnRate(product);
  const returnRate = codReturnRate ?? resolved.rate;
  const restockRate = await estimateRestockRate(shop, productId);

  const [mult30, mult60, mult90, leadMult, leadStretch] = await Promise.all([
    getHorizonMultiplier(shop, 30, productId),
    getHorizonMultiplier(shop, 60, productId),
    getHorizonMultiplier(shop, 90, productId),
    getLeadTimeMultiplier(shop, leadTimeDays, productId),
    getLeadTimeStretch(shop, leadTimeDays, productId),
  ]);

  const common = {
    residualStdDev: estimate.residualStdDev,
    method: estimate.method,
    observedDays: estimate.observedDays,
    restockRate,
  };

  const f30 = forecastDemand(estimate.dailyRate, 30, returnRate, safetyStock, mult30, common);
  const f60 = forecastDemand(estimate.dailyRate, 60, returnRate, safetyStock, mult60, common);
  const f90 = forecastDemand(estimate.dailyRate, 90, returnRate, safetyStock, mult90, common);

  // The reorder point is what actually triggers buying, so it gets the seasonal
  // treatment too.
  const reorderPoint = calculateReorderPoint(
    estimate.dailyRate,
    leadTimeDays,
    safetyStock,
    leadMult,
    leadStretch,
  );

  const now = new Date();
  const horizons: [number, ForecastResult, number][] = [
    [30, f30, mult30],
    [60, f60, mult60],
    [90, f90, mult90],
  ];

  await prisma.$transaction([
    prisma.product.update({
      where: { id: productId },
      data: {
        safetyStock,
        reorderPoint,
        avgDailySales: estimate.dailyRate,
        codReturnRate: returnRate,
        returnRateSource: resolved.source,
      },
    }),
    ...horizons.map(([horizon, f, mult]) => {
      const payload = {
        forecastDate: new Date(now.getTime() + horizon * DAY_MS),
        grossDemand: f.grossDemand,
        netDemand: f.netDemand,
        procurementUnits: f.procurementUnits,
        expectedReturnsSellable: f.expectedReturnsSellable,
        pi80Low: f.pi80Low,
        pi80High: f.pi80High,
        method: f.method,
        confidence: f.confidence,
        seasonalityApplied: mult !== 1.0,
        eventMultiplier: mult,
        safetyStockUsed: safetyStock,
      };
      return prisma.forecast.upsert({
        where: { productId_horizon: { productId, horizon } },
        create: { shop, productId, horizon, ...payload },
        update: payload,
      });
    }),
    // Forecast-vs-actual ledger, so accuracy can be scored once the horizon elapses.
    ...horizons.map(([horizon, f]) =>
      prisma.forecastAccuracy.upsert({
        where: {
          productId_horizon_dueAt: {
            productId,
            horizon,
            dueAt: new Date(now.getTime() + horizon * DAY_MS),
          },
        },
        create: {
          shop,
          productId,
          horizon,
          dueAt: new Date(now.getTime() + horizon * DAY_MS),
          predicted: f.grossDemand,
        },
        update: { predicted: f.grossDemand },
      }),
    ),
  ]);

  return { f30, f60, f90 };
}

/**
 * Suggested purchase quantity for a product, accounting for what is already coming.
 */
export async function suggestOrderQuantity(
  shop: string,
  productId: string,
  coverageDays?: number,
) {
  const [product, settings] = await Promise.all([
    prisma.product.findFirst({ where: { id: productId, shop } }),
    prisma.shopSettings.findUnique({ where: { shop } }),
  ]);
  if (!product) return null;

  const days = coverageDays ?? settings?.coverageDays ?? 30;
  const positions = await getInventoryPositions(shop, [productId]);
  const position = positions.get(productId);

  const multiplier = await getHorizonMultiplier(shop, days, productId);
  const shipUnits = product.avgDailySales * days * multiplier;
  const { rate } = resolveReturnRate(product);
  const restockRate = await estimateRestockRate(shop, productId);

  return computeProcurementPlan({
    shipUnits,
    returnRate: rate,
    restockRate,
    position: position?.position ?? product.currentStock,
    safetyStock: product.safetyStock,
    moq: product.moq,
    casePackSize: product.casePackSize,
  });
}
