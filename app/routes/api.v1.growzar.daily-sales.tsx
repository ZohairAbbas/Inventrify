import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  dayLabel,
  feedResponse,
  iso,
  keysetOrder,
  keysetWhere,
  numericId,
  openFeed,
  pageTake,
} from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/daily-sales — units sold per variant per shop-local day.
 * Phase 5, G-INV5-3. Inventorify owns units sold (rule #28); Growzar computes days of
 * cover from these rows and never re-derives them from Shopify.
 *
 * `date` is the shop-local day the stored row stands for (SalesRecord.date holds that
 * calendar date at 00:00 UTC). `id` is `<variantId>:<date>`.
 *
 * Rows are reconciled in place by the order sync and a day that recounts to zero stays
 * as `units: 0`, so nothing is deleted short of a shop purge — reported as 410 after an
 * uninstall, or `shopPurged` after a keep-session wipe. This feed therefore has no
 * tombstone list.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.salesRecord.findMany({
      where: { shop: facts.shop, ...keysetWhere(params) },
      orderBy: keysetOrder,
      take: pageTake(params),
      select: { id: true, productId: true, date: true, quantity: true, updatedAt: true },
    });

    return await feedResponse(feed.value, rows, (row) => {
      const variantId = numericId(row.productId);
      const date = dayLabel(row.date);
      return {
        id: `${variantId}:${date}`,
        variantId,
        date,
        units: row.quantity,
        updatedAt: iso(row.updatedAt),
      };
    });
  } catch (err) {
    console.error("[growzar] daily-sales feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read daily sales.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
