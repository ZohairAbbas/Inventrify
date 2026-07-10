import prisma from "../db.server";

function appliesToProduct(productIds: string, productId?: string): boolean {
  if (!productIds.trim()) return true; // empty = applies to all products
  if (!productId) return false;
  return productIds.split(",").map((id) => id.trim()).includes(productId);
}

/** Returns compound impact multiplier for any active events right now (or a given date) */
export async function getActiveEventMultiplier(
  shop: string,
  date: Date = new Date(),
  productId?: string,
): Promise<number> {
  const events = await prisma.seasonalEvent.findMany({
    where: {
      shop,
      startDate: { lte: date },
      endDate: { gte: date },
    },
  });
  const applicable = events.filter((e) => appliesToProduct(e.productIds, productId));
  if (applicable.length === 0) return 1.0;
  const combined = applicable.reduce((m, e) => m * e.impactMultiplier, 1.0);
  return Math.min(combined, 5.0); // cap at 5×
}

/**
 * Returns the weighted average multiplier over a future horizon.
 * For each day in [now, now+horizonDays], check which events overlap
 * and average the multipliers.
 */
export async function getHorizonMultiplier(
  shop: string,
  horizonDays: number,
  productId?: string,
): Promise<number> {
  const now = new Date();
  const end = new Date(now.getTime() + horizonDays * 86400000);

  const events = await prisma.seasonalEvent.findMany({
    where: {
      shop,
      startDate: { lte: end },
      endDate: { gte: now },
    },
  });
  const applicable = events.filter((e) => appliesToProduct(e.productIds, productId));
  if (applicable.length === 0) return 1.0;

  // Count event-days and their multipliers
  let totalMultiplier = 0;
  for (const event of applicable) {
    const start = Math.max(event.startDate.getTime(), now.getTime());
    const finish = Math.min(event.endDate.getTime(), end.getTime());
    const days = Math.ceil((finish - start) / 86400000);
    totalMultiplier += (event.impactMultiplier - 1) * days;
  }

  // Blended: non-event days have multiplier 1.0
  const blended = 1.0 + totalMultiplier / horizonDays;
  return Math.min(blended, 3.0);
}

/** Upcoming events within the next N days */
export async function getUpcomingEvents(shop: string, horizonDays = 90) {
  const now = new Date();
  const end = new Date(now.getTime() + horizonDays * 86400000);
  return prisma.seasonalEvent.findMany({
    where: {
      shop,
      startDate: { lte: end },
      endDate: { gte: now },
    },
    orderBy: { startDate: "asc" },
  });
}
