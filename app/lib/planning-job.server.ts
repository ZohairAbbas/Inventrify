import prisma from "../db.server";
import { classifyAbc, classifyXyz } from "./planning.server";
import { densify, stdDev } from "./demand.server";
import { generateAndSaveForecast } from "./forecast.server";

const DAY_MS = 86400000;

/**
 * Recompute ABC (revenue contribution) and XYZ (demand variability) for a shop.
 *
 * These drive the per-class service level in serviceLevelZFor(), which is what stops a
 * single global Z-score buying the same safety stock for the SKUs that pay the bills
 * and for the long tail.
 */
export async function recomputeClassifications(
  shop: string,
): Promise<{ classified: number }> {
  const since = new Date(Date.now() - 90 * DAY_MS);

  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: { id: true, unitCost: true, avgMargin: true, firstSoldAt: true },
  });
  if (products.length === 0) return { classified: 0 };

  const sales = await prisma.salesRecord.findMany({
    where: { shop, date: { gte: since } },
    select: { productId: true, quantity: true, date: true },
  });

  const byProduct = new Map<string, { date: Date; quantity: number }[]>();
  for (const row of sales) {
    const arr = byProduct.get(row.productId) ?? [];
    arr.push({ date: row.date, quantity: row.quantity });
    byProduct.set(row.productId, arr);
  }

  const revenueInputs = products.map((p) => {
    const rows = byProduct.get(p.id) ?? [];
    const units = rows.reduce((s, r) => s + r.quantity, 0);
    // Unit revenue from cost and margin; falls back to units when cost is unknown so
    // ABC still ranks by volume rather than collapsing to all-C.
    const unitRevenue =
      p.unitCost > 0 && p.avgMargin > 0 && p.avgMargin < 0.95
        ? p.unitCost / (1 - p.avgMargin)
        : p.unitCost > 0
          ? p.unitCost
          : 1;
    return { productId: p.id, revenue: units * unitRevenue };
  });

  const abc = classifyAbc(revenueInputs);
  const end = new Date();

  let classified = 0;
  for (const p of products) {
    const rows = byProduct.get(p.id) ?? [];
    const start = p.firstSoldAt && p.firstSoldAt > since ? p.firstSoldAt : since;
    const series = densify(rows, start, end);
    const mean = series.length
      ? series.reduce((a, b) => a + b, 0) / series.length
      : 0;
    const cv = mean > 0 ? stdDev(series) / mean : Infinity;

    await prisma.product.update({
      where: { id: p.id },
      data: {
        abcClass: abc.get(p.id) ?? "C",
        xyzClass: Number.isFinite(cv) ? classifyXyz(cv) : "Z",
      },
    });
    classified++;
  }

  return { classified };
}

/**
 * Score forecasts whose horizon has elapsed against what actually shipped.
 *
 * Nothing previously measured whether a forecast was right. Bias is the important
 * output: a persistent negative bias across a shop is exactly the fingerprint of
 * systematically under-buying, which is what planning on net-of-returns demand used to
 * cause. MAPE is reported per SKU so merchants can see which forecasts to trust.
 */
export async function scoreForecastAccuracy(
  shop: string,
): Promise<{ scored: number }> {
  const due = await prisma.forecastAccuracy.findMany({
    where: { shop, evaluatedAt: null, dueAt: { lte: new Date() } },
    take: 2000,
  });
  if (due.length === 0) return { scored: 0 };

  let scored = 0;
  for (const row of due) {
    const windowStart = new Date(row.dueAt.getTime() - row.horizon * DAY_MS);
    const actual = await prisma.salesRecord.aggregate({
      where: {
        productId: row.productId,
        date: { gte: windowStart, lt: row.dueAt },
      },
      _sum: { quantity: true },
    });

    await prisma.forecastAccuracy.update({
      where: { id: row.id },
      data: { actual: actual._sum.quantity ?? 0, evaluatedAt: new Date() },
    });
    scored++;
  }

  // Roll the scored rows up into per-product MAPE and bias.
  const productIds = [...new Set(due.map((d) => d.productId))];
  for (const productId of productIds) {
    const history = await prisma.forecastAccuracy.findMany({
      where: { productId, evaluatedAt: { not: null }, actual: { not: null } },
      orderBy: { dueAt: "desc" },
      take: 12,
    });
    if (history.length === 0) continue;

    // MAPE is undefined where actual is 0, so those rows are excluded from it but kept
    // for bias — otherwise a SKU that stopped selling would look perfectly forecast.
    const withActuals = history.filter((h) => (h.actual ?? 0) > 0);
    const mape =
      withActuals.length > 0
        ? withActuals.reduce(
            (s, h) => s + Math.abs(h.predicted - (h.actual as number)) / (h.actual as number),
            0,
          ) / withActuals.length
        : null;

    const bias =
      history.reduce((s, h) => s + (h.predicted - (h.actual as number)), 0) /
      history.length;

    await prisma.product.update({
      where: { id: productId },
      data: { forecastMape: mape, forecastBias: bias },
    });
  }

  return { scored };
}

/** Refresh stored forecasts for every active product in a shop. */
export async function refreshForecasts(
  shop: string,
  limit = 5000,
): Promise<{ refreshed: number; errors: number }> {
  const products = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: { id: true },
    take: limit,
  });

  let refreshed = 0;
  let errors = 0;
  for (const p of products) {
    try {
      await generateAndSaveForecast(p.id, shop);
      refreshed++;
    } catch (err) {
      errors++;
      console.error(
        `[inventorify] forecast failed for ${p.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { refreshed, errors };
}
