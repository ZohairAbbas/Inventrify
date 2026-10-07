import prisma from "../db.server";
import { shopDateKey } from "./tz.server";

/**
 * The daily stock snapshot: one row per live variant per shop-local day.
 *
 * Run hourly. The first run after the shop's local midnight records the day's opening
 * stock; every later run that day writes nothing, because (productId, date) is unique.
 * A missed hour is caught up by the next run, so a day is lost only if the job is down
 * for the shop's whole local day.
 *
 * Reads `currentStock` from our own table — kept current by the hourly product sync and
 * the inventory webhooks — so it makes no Shopify calls of its own.
 *
 * The day is built in the same timezone the sales history uses (ShopSettings.timezone),
 * so a snapshot and a day of sales with the same date label cover the same hours.
 */
export async function writeDailySnapshots(
  shop: string,
  now: Date = new Date(),
): Promise<{ date: string; written: number; variants: number }> {
  const settings = await prisma.shopSettings.findUnique({ where: { shop }, select: { timezone: true } });
  const date = shopDateKey(now, settings?.timezone ?? "UTC");

  const live = await prisma.product.findMany({
    where: { shop, isArchived: false },
    select: { id: true, currentStock: true },
  });
  if (live.length === 0) return { date: date.toISOString().slice(0, 10), written: 0, variants: 0 };

  const { count } = await prisma.stockSnapshot.createMany({
    data: live.map((p) => ({ shop, productId: p.id, date, stock: p.currentStock, observedAt: now })),
    skipDuplicates: true,
  });
  return { date: date.toISOString().slice(0, 10), written: count, variants: live.length };
}
