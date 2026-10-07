import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { feedResponse, iso, keysetOrder, keysetWhere, numericId, openFeed, pageTake } from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";
import { stockLevelId } from "../lib/shopify-sync.server";

/**
 * GET /api/v1/growzar/stock-levels — stock per variant per location. Phase 5, G-INV5-2.
 *
 * `id` is `<variantId>:<locationId>`, so a row the sync deletes and later recreates is
 * the same row to Growzar. onHand is sellable physical stock: units in Shopify's
 * `damaged` state are split out into `damaged`, and available = onHand − reserved.
 *
 * Renaming or deactivating a location moves `updatedAt` on every row at it (see
 * updateLocation in shopify-sync.server), so `locationName` / `locationActive` never go
 * stale without the row looking changed. Rows the sync drops are listed in
 * `deletedStockLevelIds`.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.productLocationStock.findMany({
      where: { shop: facts.shop, ...keysetWhere(params) },
      orderBy: keysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        productId: true,
        onHand: true,
        reserved: true,
        damaged: true,
        updatedAt: true,
        location: { select: { shopifyLocationId: true, name: true, isActive: true } },
      },
    });

    return await feedResponse(
      feed.value,
      rows,
      (row) => ({
        id: stockLevelId(row.productId, row.location.shopifyLocationId),
        variantId: numericId(row.productId),
        locationId: numericId(row.location.shopifyLocationId),
        locationName: row.location.name,
        locationActive: row.location.isActive,
        onHand: row.onHand,
        reserved: row.reserved,
        damaged: row.damaged,
        available: row.onHand - row.reserved,
        updatedAt: iso(row.updatedAt),
      }),
      { feed: "stock-levels", key: "deletedStockLevelIds" },
    );
  } catch (err) {
    console.error("[growzar] stock-levels feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read stock levels.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
