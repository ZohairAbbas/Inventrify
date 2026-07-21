import prisma from "../db.server";

const DAY_MS = 86400000;

function appliesToProduct(productIds: string, productId?: string): boolean {
  if (!productIds.trim()) return true; // empty = applies to all products
  if (!productId) return false;
  return productIds.split(",").map((id) => id.trim()).includes(productId);
}

interface EventRow {
  startDate: Date;
  endDate: Date;
  impactMultiplier: number;
  leadTimeMultiplier: number;
  productIds: string;
}

async function eventsOverlapping(
  shop: string,
  from: Date,
  to: Date,
  productId?: string,
): Promise<EventRow[]> {
  const events = await prisma.seasonalEvent.findMany({
    where: { shop, startDate: { lte: to }, endDate: { gte: from } },
    select: {
      startDate: true,
      endDate: true,
      impactMultiplier: true,
      leadTimeMultiplier: true,
      productIds: true,
    },
  });
  return events.filter((e) => appliesToProduct(e.productIds, productId));
}

/**
 * Day-weighted average multiplier across an arbitrary window.
 *
 * Averaging over the window matters because the window that drives a *reorder point* is
 * the lead time (days away), while the window that drives a *forecast* is the horizon
 * (up to 90 days). A 3x Eid spike sitting inside the next 7 days is a completely
 * different signal from the same spike averaged across 90 — and the old code only ever
 * computed the horizon version, then applied it nowhere near the reorder point.
 */
export async function getWindowMultiplier(
  shop: string,
  from: Date,
  to: Date,
  productId?: string,
  cap = 3.0,
): Promise<number> {
  const windowMs = Math.max(DAY_MS, to.getTime() - from.getTime());
  const windowDays = windowMs / DAY_MS;

  const events = await eventsOverlapping(shop, from, to, productId);
  if (events.length === 0) return 1.0;

  let uplift = 0;
  for (const event of events) {
    const start = Math.max(event.startDate.getTime(), from.getTime());
    const finish = Math.min(event.endDate.getTime(), to.getTime());
    const days = Math.max(0, (finish - start) / DAY_MS);
    uplift += (event.impactMultiplier - 1) * days;
  }

  return Math.min(1.0 + uplift / windowDays, cap);
}

/** Compound impact multiplier for events active at a given instant. */
export async function getActiveEventMultiplier(
  shop: string,
  date: Date = new Date(),
  productId?: string,
): Promise<number> {
  const events = await eventsOverlapping(shop, date, date, productId);
  if (events.length === 0) return 1.0;
  const combined = events.reduce((m, e) => m * e.impactMultiplier, 1.0);
  return Math.min(combined, 5.0); // cap at 5×
}

/** Day-weighted multiplier over the forecast horizon [now, now + horizonDays]. */
export async function getHorizonMultiplier(
  shop: string,
  horizonDays: number,
  productId?: string,
): Promise<number> {
  const now = new Date();
  return getWindowMultiplier(
    shop,
    now,
    new Date(now.getTime() + horizonDays * DAY_MS),
    productId,
  );
}

/**
 * Demand multiplier over the replenishment window — the lead time, which is the period
 * a reorder point actually has to cover.
 */
export async function getLeadTimeMultiplier(
  shop: string,
  leadTimeDays: number,
  productId?: string,
): Promise<number> {
  const now = new Date();
  return getWindowMultiplier(
    shop,
    now,
    new Date(now.getTime() + Math.max(1, leadTimeDays) * DAY_MS),
    productId,
  );
}

/**
 * How much longer supply takes during a peak.
 *
 * Lead times stretch in exactly the periods demand spikes — customs backlogs before Eid,
 * courier saturation on 11.11 — so ordering on a normal lead time during a peak arrives
 * late twice over. Takes the maximum rather than a day-weighted average: a delay
 * anywhere in the ordering window delays the whole shipment.
 */
export async function getLeadTimeStretch(
  shop: string,
  leadTimeDays: number,
  productId?: string,
): Promise<number> {
  const now = new Date();
  const to = new Date(now.getTime() + Math.max(1, leadTimeDays) * DAY_MS);
  const events = await eventsOverlapping(shop, now, to, productId);
  if (events.length === 0) return 1.0;
  return Math.min(
    events.reduce((max, e) => Math.max(max, e.leadTimeMultiplier), 1.0),
    3.0,
  );
}

/** Upcoming events within the next N days */
export async function getUpcomingEvents(shop: string, horizonDays = 90) {
  const now = new Date();
  const end = new Date(now.getTime() + horizonDays * DAY_MS);
  return prisma.seasonalEvent.findMany({
    where: {
      shop,
      startDate: { lte: end },
      endDate: { gte: now },
    },
    orderBy: { startDate: "asc" },
  });
}
