import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { feedResponse, iso, keysetOrder, keysetWhere, numericId, openFeed, pageTake } from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/return-restocks — what became of each returned line. Phase 5,
 * G-INV5-7.
 *
 * Only the part Inventorify owns: whether the merchant restocked the unit or wrote it
 * off, when, and where. The shipment, its city, courier and return reason are
 * Courierify's, so `shipmentId` (Courierify's id) and `lineItemId` are here only as the
 * join key.
 *
 * `variantId` is Shopify's variant id as Courierify reported it, else the product the
 * line was matched or assigned to; null when neither is known. `locationId` is the
 * Shopify location it was restocked at.
 *
 * Rows are never deleted short of a shop purge (410 / `shopPurged`), so there is no
 * tombstone list.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const [rows, locations] = await Promise.all([
      prisma.returnItem.findMany({
        where: { shop: facts.shop, ...keysetWhere(params) },
        orderBy: keysetOrder,
        take: pageTake(params),
        select: {
          id: true,
          shipmentId: true,
          lineItemId: true,
          shopifyVariantId: true,
          productId: true,
          quantity: true,
          status: true,
          resolvedAt: true,
          locationId: true,
          updatedAt: true,
        },
      }),
      prisma.location.findMany({ where: { shop: facts.shop }, select: { id: true, shopifyLocationId: true } }),
    ]);
    const shopifyLocation = new Map(locations.map((l) => [l.id, numericId(l.shopifyLocationId)]));

    return await feedResponse(feed.value, rows, (row) => ({
      id: row.id,
      shipmentId: row.shipmentId,
      lineItemId: row.lineItemId,
      variantId: numericId(row.shopifyVariantId) ?? numericId(row.productId),
      quantity: row.quantity,
      status: row.status,
      resolvedAt: iso(row.resolvedAt),
      locationId: row.locationId ? shopifyLocation.get(row.locationId) ?? null : null,
      updatedAt: iso(row.updatedAt),
    }));
  } catch (err) {
    console.error("[growzar] return-restocks feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read return restocks.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
