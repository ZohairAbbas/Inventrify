import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  dayLabel,
  feedResponse,
  iso,
  keysetOrder,
  keysetWhere,
  money,
  numericId,
  openFeed,
  pageTake,
} from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";
import { outstandingQuantity } from "../lib/purchase-order-status";

/**
 * GET /api/v1/growzar/purchase-orders — purchase orders with their lines nested.
 * Phase 5, G-INV5-4. Inventorify owns purchase orders (rule #18).
 *
 * Drafts are included with their status; Growzar treats only sent / partially_received
 * as on the way. `onOrder` = ordered − received − cancelled, floored at 0.
 *
 * A change to any line moves the PO's updatedAt (database trigger, migration
 * 20261007160000), as does renaming its supplier. Deleted drafts are listed in
 * `deletedPurchaseOrderIds`.
 *
 * `expectedDeliveryDate` is a day the merchant picked, stored as that date at 00:00 UTC,
 * so it is sent as `YYYY-MM-DD`. `actualDeliveryDate` is when the first delivery was
 * booked, an instant.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.purchaseOrder.findMany({
      where: { shop: facts.shop, ...keysetWhere(params) },
      orderBy: keysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        poNumber: true,
        status: true,
        supplierId: true,
        supplier: { select: { name: true } },
        createdAt: true,
        sentAt: true,
        expectedDeliveryDate: true,
        actualDeliveryDate: true,
        totalCost: true,
        updatedAt: true,
        items: {
          orderBy: { id: "asc" },
          select: {
            productId: true,
            quantityOrdered: true,
            quantityReceived: true,
            quantityCancelled: true,
            unitCost: true,
          },
        },
      },
    });

    return await feedResponse(
      feed.value,
      rows,
      (po) => ({
        id: po.id,
        poNumber: po.poNumber,
        status: po.status,
        supplierId: po.supplierId,
        supplierName: po.supplier?.name ?? null,
        createdAt: iso(po.createdAt),
        sentAt: iso(po.sentAt),
        expectedDeliveryDate: po.expectedDeliveryDate ? dayLabel(po.expectedDeliveryDate) : null,
        actualDeliveryDate: iso(po.actualDeliveryDate),
        totalCost: money(po.totalCost, facts.shopCurrency),
        items: po.items.map((item) => ({
          variantId: numericId(item.productId),
          quantityOrdered: item.quantityOrdered,
          quantityReceived: item.quantityReceived,
          quantityCancelled: item.quantityCancelled,
          onOrder: outstandingQuantity(item),
          unitCost: money(item.unitCost, facts.shopCurrency),
        })),
        updatedAt: iso(po.updatedAt),
      }),
      { feed: "purchase-orders", key: "deletedPurchaseOrderIds" },
    );
  } catch (err) {
    console.error("[growzar] purchase-orders feed failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read purchase orders.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
