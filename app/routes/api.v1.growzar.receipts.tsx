import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  createdKeysetOrder,
  dayOf,
  feedPartner,
  iso,
  keysetWhere,
  money,
  numericId,
  openFeed,
  pagedResponse,
  pageTake,
  settledWhere,
} from "../lib/growzar/feed.server";
import { growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/receipts — goods received against purchase orders, one row per
 * delivery, for Growzar's Books and Financify's. /api/v1/financify/receipts re-exports this
 * route, so both partners get the same body; the partner comes from the path (openFeed).
 *
 * Receipts are append-only: never edited, deleted or reversed. So the feed pages on
 * createdAt (`updatedSince` filters on it) and a row, once read, never changes.
 *
 * `quantity` is everything that arrived on the line; `quantityDamaged` is the part of it
 * that arrived damaged. The bill posted with the receipt covers the whole quantity at the
 * PO line's unit cost; `billLedgerEntryId` names it in the supplier-ledger feed, and is
 * null when the PO has no supplier (no bill is posted then).
 *
 * `receivedOn` is the delivery day in the shop's time zone; `receivedAt` is the stored
 * value as is (see dayOf).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const feed = await openFeed(request);
  if (!feed.ok) return feed.response;
  const { facts, params } = feed.value;

  try {
    const rows = await prisma.purchaseOrderReceipt.findMany({
      where: { shop: facts.shop, AND: [settledWhere(), keysetWhere(params, "createdAt")] },
      orderBy: createdKeysetOrder,
      take: pageTake(params),
      select: {
        id: true,
        purchaseOrderId: true,
        receivedAt: true,
        locationId: true,
        createdAt: true,
        purchaseOrder: { select: { poNumber: true, supplierId: true } },
        lines: {
          orderBy: { id: "asc" },
          select: {
            quantity: true,
            quantityDamaged: true,
            purchaseOrderItem: {
              select: { unitCost: true, product: { select: { id: true, inventoryItemId: true } } },
            },
          },
        },
      },
    });

    const page = rows.slice(0, params.limit);
    const [bills, locations] = await Promise.all([
      prisma.supplierLedgerEntry.findMany({
        where: { shop: facts.shop, sourceKey: { in: page.map((r) => `receipt:${r.id}`) } },
        select: { id: true, receiptId: true, currency: true },
      }),
      prisma.location.findMany({
        where: { shop: facts.shop, id: { in: page.flatMap((r) => (r.locationId ? [r.locationId] : [])) } },
        select: { id: true, shopifyLocationId: true },
      }),
    ]);
    const billOf = new Map(bills.map((b) => [b.receiptId, b]));
    const shopifyLocationOf = new Map(locations.map((l) => [l.id, l.shopifyLocationId]));

    return await pagedResponse(
      feed.value,
      rows,
      (r) => r.createdAt,
      (r) => {
        const bill = billOf.get(r.id);
        const currency = bill?.currency ?? facts.shopCurrency;
        return {
          id: r.id,
          poId: r.purchaseOrderId,
          poNumber: r.purchaseOrder.poNumber,
          supplierId: r.purchaseOrder.supplierId,
          locationId: r.locationId ? numericId(shopifyLocationOf.get(r.locationId)) : null,
          receivedAt: iso(r.receivedAt),
          receivedOn: dayOf(r.receivedAt, facts.shopTimezone),
          lines: r.lines.map((l) => ({
            variantId: numericId(l.purchaseOrderItem.product.id),
            inventoryItemId: numericId(l.purchaseOrderItem.product.inventoryItemId),
            quantity: l.quantity,
            quantityDamaged: l.quantityDamaged,
            unitCost: money(l.purchaseOrderItem.unitCost, currency),
          })),
          billLedgerEntryId: bill?.id ?? null,
          currency,
          createdAt: iso(r.createdAt),
        };
      },
    );
  } catch (err) {
    const partner = feedPartner(new URL(request.url).pathname);
    console.error(`[${partner}] receipts feed failed:`, err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read receipts.");
  }
};

export const action = async () => growzarError(405, "bad_request", "Feeds are read with GET.");
