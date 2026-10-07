import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { feedResponse, iso, keysetOrder, keysetWhere, numericId, openFeed, pageTake } from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";
import { shopDateString } from "../lib/tz.server";

/**
 * GET /api/v1/growzar/stock-snapshots — the daily stock snapshot. Phase 5, G-INV5-6.
 *
 * `date` is the shop-local day on which the stock was observed (`observedAt`), in the
 * timezone the sales history uses. For rows the scheduled job writes that is the stored
 * day. Older rows were written by the product sync per UTC day, and labelling them by
 * when they were observed puts them on the right local day as well. A day with no row
 * is a day nobody observed: no history is invented.
 *
 * Rows are never deleted short of a shop purge (410 / `shopPurged`), so there is no
 * tombstone list. `id` is the row's own id: across the switch from UTC-day to
 * shop-day rows, two rows can fall on one local date.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const [rows, settings] = await Promise.all([
      prisma.stockSnapshot.findMany({
        where: { shop: facts.shop, ...keysetWhere(params) },
        orderBy: keysetOrder,
        take: pageTake(params),
        select: { id: true, productId: true, stock: true, observedAt: true, updatedAt: true },
      }),
      prisma.shopSettings.findUnique({ where: { shop: facts.shop }, select: { timezone: true } }),
    ]);
    const timezone = settings?.timezone ?? "UTC";

    return await feedResponse(feed.value, rows, (row) => ({
      id: row.id,
      variantId: numericId(row.productId),
      date: shopDateString(row.observedAt, timezone),
      stock: row.stock,
      observedAt: iso(row.observedAt),
      updatedAt: iso(row.updatedAt),
    }));
  } catch (err) {
    console.error("[growzar] stock-snapshots feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read stock snapshots.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
