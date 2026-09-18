import prisma from "../db.server";
import { shopDateKey } from "./tz.server";
import { reconcileFloor } from "./order-sync.server";

/**
 * Rebuild SalesRecord days that the order sync deleted.
 *
 * Until the fix to syncOrderHistory, every hourly run deleted SalesRecord from 90 days
 * back but Shopify only returned 60, so days 61–90 were lost for every variant still
 * selling. The orders behind them survive: OrderLineItem (variant, quantity, orderedAt)
 * and OrderRegion (whether the order was cancelled) are upserted by the same sync and
 * never pruned. Bucketing those lines to the shop's calendar reproduces what the sync
 * itself would have written.
 *
 * Only days with no SalesRecord at all are restored. A day that exists is left alone even
 * if it disagrees, because it may carry webhook demand the order lines do not.
 */

export interface OrderLine {
  orderName: string;
  productId: string;
  quantity: number;
  orderedAt: Date;
}

/**
 * Units per variant per shop-local day, from order lines.
 *
 * `liveOrders` are the orders known not to be cancelled. A line whose order is not in it
 * is skipped — a cancelled order is not demand, and an order with no region row is
 * unknown, so it is not guessed at.
 */
export function reconstructDailySales(
  lines: OrderLine[],
  liveOrders: Set<string>,
  timezone: string,
): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const line of lines) {
    if (!liveOrders.has(line.orderName)) continue;
    const day = shopDateKey(line.orderedAt, timezone).getTime();
    if (!out.has(line.productId)) out.set(line.productId, new Map());
    const days = out.get(line.productId)!;
    days.set(day, (days.get(day) ?? 0) + line.quantity);
  }
  return out;
}

export interface RepairPlan {
  /** Rows that would be inserted. */
  restore: { productId: string; date: Date; quantity: number }[];
  /** Variant-days the order lines support that already have a SalesRecord. */
  presentDays: number;
  /** Of those, how many hold a different quantity (reported, never changed). */
  mismatchedDays: number;
}

/**
 * Days to restore: reconstructed, older than `before`, and absent from storage.
 *
 * `before` keeps this out of the days the hourly sync rebuilds, so the two never write
 * the same day.
 */
export function planRepair(
  reconstructed: Map<string, Map<number, number>>,
  stored: Map<string, Map<number, number>>,
  before: Date,
): RepairPlan {
  const plan: RepairPlan = { restore: [], presentDays: 0, mismatchedDays: 0 };
  for (const [productId, days] of reconstructed) {
    const have = stored.get(productId);
    for (const [day, quantity] of days) {
      if (day >= before.getTime()) continue;
      const existing = have?.get(day);
      if (existing === undefined) {
        plan.restore.push({ productId, date: new Date(day), quantity });
      } else {
        plan.presentDays++;
        if (existing !== quantity) plan.mismatchedDays++;
      }
    }
  }
  plan.restore.sort(
    (a, b) => a.productId.localeCompare(b.productId) || a.date.getTime() - b.date.getTime(),
  );
  return plan;
}

/** Build the repair plan for one shop from what is stored. Reads only. */
export async function planShopRepair(shop: string, now = new Date()): Promise<RepairPlan> {
  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { timezone: true },
  });
  const timezone = settings?.timezone ?? "UTC";
  // Only days the sync no longer reconciles. Without read_all_orders that is the
  // sync's floor; assuming that here is safe either way, since it only narrows the plan.
  const before = reconcileFloor(now, false, timezone);

  const [products, lines, regions, rows] = await Promise.all([
    prisma.product.findMany({ where: { shop }, select: { id: true } }),
    prisma.orderLineItem.findMany({
      where: { shop },
      select: { orderName: true, productId: true, quantity: true, orderedAt: true },
    }),
    prisma.orderRegion.findMany({
      where: { shop, isCancelled: false },
      select: { orderName: true },
    }),
    prisma.salesRecord.findMany({
      where: { shop, date: { lt: before } },
      select: { productId: true, date: true, quantity: true },
    }),
  ]);

  // A SalesRecord needs its Product; a variant deleted since cannot be restored.
  const known = new Set(products.map((p) => p.id));
  const reconstructed = reconstructDailySales(
    lines.filter((l) => known.has(l.productId)),
    new Set(regions.map((r) => r.orderName)),
    timezone,
  );

  const stored = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (!stored.has(r.productId)) stored.set(r.productId, new Map());
    stored.get(r.productId)!.set(r.date.getTime(), r.quantity);
  }

  return planRepair(reconstructed, stored, before);
}

/**
 * Insert a plan's rows. Never overwrites: skipDuplicates keeps any row written since the
 * plan was made. Moves firstSoldAt earlier where a restored day predates it, or the
 * demand window would ignore the restored days.
 */
export async function applyShopRepair(shop: string, plan: RepairPlan): Promise<number> {
  if (plan.restore.length === 0) return 0;
  const { count } = await prisma.salesRecord.createMany({
    data: plan.restore.map((r) => ({ shop, ...r })),
    skipDuplicates: true,
  });

  const earliest = new Map<string, Date>();
  for (const r of plan.restore) {
    const cur = earliest.get(r.productId);
    if (!cur || r.date < cur) earliest.set(r.productId, r.date);
  }
  for (const [productId, date] of earliest) {
    await prisma.product.updateMany({
      where: { shop, id: productId, OR: [{ firstSoldAt: null }, { firstSoldAt: { gt: date } }] },
      data: { firstSoldAt: date },
    });
  }
  return count;
}
