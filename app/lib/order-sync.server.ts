import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { graphqlWithRetry, type Paged } from "./shopify-graphql.server";
import { isCodOrder, parseCodGateways } from "./cod.server";
import { shopDateKey, shopWeekStart } from "./tz.server";
import { estimateDemand } from "./demand.server";

const ORDERS_QUERY = `
  query getOrders($cursor: String, $query: String) {
    orders(first: 100, after: $cursor, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          cancelledAt
          paymentGatewayNames
          tags
          displayFulfillmentStatus
          shippingAddress { city province country }
          lineItems(first: 100) {
            edges {
              node {
                variant { id sku }
                quantity
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

interface OrderNode {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  paymentGatewayNames: string[] | null;
  tags: string[] | null;
  displayFulfillmentStatus: string | null;
  shippingAddress: { city: string | null; province: string | null; country: string | null } | null;
  lineItems: Paged<{
    variant: { id: string; sku: string | null } | null;
    quantity: number;
  }>;
}

interface OrdersResponse {
  orders: Paged<OrderNode>;
}

const SYNC_WINDOW_DAYS = 90;

/**
 * Rebuild the trailing-90-day demand history from Shopify.
 *
 * This is a reconciliation pass: ORDERS_CREATE keeps demand current in real time, and
 * this re-derives the window from the source of truth to repair anything missed while
 * the app was down or webhooks were failing.
 */
export async function syncOrderHistory(
  admin: AdminApiContext,
  shop: string,
): Promise<{ recordsSynced: number; variantsSeen: number; completed: boolean; error?: string }> {
  const since = new Date(Date.now() - SYNC_WINDOW_DAYS * 86400000);
  const sinceStr = since.toISOString().split("T")[0];

  const settings = await prisma.shopSettings.findUnique({
    where: { shop },
    select: { timezone: true, codGateways: true, confirmedOrderTag: true },
  });
  const timezone = settings?.timezone ?? "UTC";
  const codGateways = parseCodGateways(settings?.codGateways);
  const confirmedTag = (settings?.confirmedOrderTag ?? "").trim().toLowerCase();

  // variantGid -> (dateKey ISO -> qty)
  const salesMap = new Map<string, Map<string, number>>();
  // variantGid -> (weekStart ISO -> COD order units), the RTO denominator.
  const codMap = new Map<string, Map<string, number>>();
  // Per-order delivery region — the denominator for regional RTO analysis.
  const regions: {
    orderName: string;
    city: string | null;
    province: string | null;
    country: string | null;
    units: number;
    isCod: boolean;
    isConfirmed: boolean;
    isDispatched: boolean;
    isCancelled: boolean;
    orderedAt: Date;
  }[] = [];
  // Per-order SKU breakdown — the join that turns an order-level courier outcome into a
  // per-SKU return rate. See OrderOutcome / rto-attribution.server.ts.
  const orderLines: {
    orderName: string;
    productId: string;
    sku: string | null;
    quantity: number;
    orderedAt: Date;
  }[] = [];

  let cursor: string | null = null;
  let hasNextPage = true;
  let completed = false;
  let fatalError: string | undefined;

  try {
    while (hasNextPage) {
      const data: OrdersResponse = await graphqlWithRetry<OrdersResponse>(
        admin,
        ORDERS_QUERY,
        { cursor, query: `created_at:>=${sinceStr} status:any` },
      );

      for (const { node: order } of data.orders.edges) {
        // Cancelled orders are excluded from demand but still recorded in the funnel,
        // because "how many placed orders die before dispatch" is exactly the question
        // the funnel exists to answer.
        if (order.cancelledAt) {
          if (order.name) {
            regions.push({
              orderName: order.name,
              city: normaliseCity(order.shippingAddress?.city),
              province: order.shippingAddress?.province ?? null,
              country: order.shippingAddress?.country ?? null,
              units: 0,
              isCod: isCodOrder(
                { payment_gateway_names: order.paymentGatewayNames },
                codGateways,
              ),
              isConfirmed: false,
              isDispatched: false,
              isCancelled: true,
              orderedAt: new Date(order.createdAt),
            });
          }
          continue;
        }

        const placedAt = new Date(order.createdAt);
        const dateKey = shopDateKey(placedAt, timezone).toISOString();
        const weekKey = shopWeekStart(placedAt, timezone).toISOString();
        const isCod = isCodOrder(
          { payment_gateway_names: order.paymentGatewayNames },
          codGateways,
        );

        if (order.lineItems.pageInfo?.hasNextPage) {
          // >100 line items on one order is vanishingly rare, but silently dropping
          // the tail would understate demand, so make it visible.
          console.warn(
            `[inventorify] order ${order.id} has more line items than fetched; demand may be understated`,
          );
        }

        let orderUnits = 0;
        for (const { node: lineItem } of order.lineItems.edges) {
          orderUnits += lineItem.quantity;
          const variantId = lineItem.variant?.id;
          if (!variantId) continue;

          if (!salesMap.has(variantId)) salesMap.set(variantId, new Map());
          const dayMap = salesMap.get(variantId)!;
          dayMap.set(dateKey, (dayMap.get(dateKey) ?? 0) + lineItem.quantity);

          if (isCod) {
            if (!codMap.has(variantId)) codMap.set(variantId, new Map());
            const weekMap = codMap.get(variantId)!;
            weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + lineItem.quantity);
          }

          if (order.name) {
            orderLines.push({
              orderName: order.name,
              productId: variantId,
              sku: lineItem.variant?.sku ?? null,
              quantity: lineItem.quantity,
              orderedAt: placedAt,
            });
          }
        }

        if (order.name) {
          regions.push({
            orderName: order.name,
            // Normalised so "karachi", "Karachi " and "KARACHI" do not become three
            // separate cities in the breakdown.
            city: normaliseCity(order.shippingAddress?.city),
            province: order.shippingAddress?.province ?? null,
            country: order.shippingAddress?.country ?? null,
            units: orderUnits,
            isCod,
            // No configured tag means confirmation is not tracked; the funnel then
            // reports it as untracked rather than as 0% confirmed.
            isConfirmed: confirmedTag
              ? (order.tags ?? []).some((t) => t.trim().toLowerCase() === confirmedTag)
              : false,
            isDispatched: ["FULFILLED", "PARTIALLY_FULFILLED"].includes(
              order.displayFulfillmentStatus ?? "",
            ),
            isCancelled: false,
            orderedAt: placedAt,
          });
        }
      }

      hasNextPage = data.orders.pageInfo.hasNextPage;
      cursor = data.orders.pageInfo.endCursor;
    }
    completed = true;
  } catch (err) {
    fatalError = err instanceof Error ? err.message : "Unknown error";
    console.error(`[inventorify] order sync aborted for ${shop}: ${fatalError}`);
  }

  // A partial fetch must never be written as if it were the whole window: replacing
  // 90 days of history from an aborted walk would delete real demand.
  if (!completed) {
    return { recordsSynced: 0, variantsSeen: salesMap.size, completed, error: fatalError };
  }

  let recordsSynced = 0;
  const variantsSeen = salesMap.size;

  // Only variants we track, resolved in one query rather than one per variant.
  const tracked = await prisma.product.findMany({
    where: { shop, id: { in: [...salesMap.keys()] } },
    select: { id: true },
  });

  for (const { id: variantId } of tracked) {
    const dayMap = salesMap.get(variantId);
    if (!dayMap) continue;

    const records = [...dayMap.entries()].map(([dateIso, quantity]) => ({
      shop,
      productId: variantId,
      date: new Date(dateIso),
      quantity,
    }));

    // Delete-then-insert is only safe inside a transaction. Previously a crash between
    // the two statements left the product with no demand history at all.
    await prisma.$transaction([
      prisma.salesRecord.deleteMany({
        where: { productId: variantId, date: { gte: since } },
      }),
      prisma.salesRecord.createMany({ data: records, skipDuplicates: true }),
    ]);
    recordsSynced += records.length;

    const firstSold = records.reduce<Date | null>(
      (min, r) => (min === null || r.date < min ? r.date : min),
      null,
    );
    // One estimator for the whole app: the cached avgDailySales that drives reorder
    // points is now the same number the forecast uses, rather than a second, slightly
    // different moving average maintained in parallel here.
    const { dailyRate } = estimateDemand(records, {
      windowStart: since,
      firstSoldAt: firstSold,
    });

    await prisma.product.update({
      where: { id: variantId },
      data: {
        avgDailySales: dailyRate,
        // Bounds the variance window so a SKU launched three weeks ago is not treated
        // as having 70 days of zero demand.
        ...(firstSold ? { firstSoldAt: firstSold } : {}),
      },
    });

    // Backfill the COD order counts that form the RTO denominator. Without this a
    // fresh install had no return-rate history until a week of webhooks accumulated.
    const weekMap = codMap.get(variantId);
    if (weekMap) {
      for (const [weekIso, orderCount] of weekMap) {
        await prisma.returnRateHistory.upsert({
          where: {
            productId_weekStart: { productId: variantId, weekStart: new Date(weekIso) },
          },
          create: {
            shop,
            productId: variantId,
            weekStart: new Date(weekIso),
            returnRate: 0,
            orderCount,
          },
          update: { orderCount },
        });
      }
    }
  }

  // Persist the per-order SKU breakdown. Only variants we track, and summed per
  // (order, product) so a repeated product across lines becomes one row.
  const trackedIds = new Set(tracked.map((t) => t.id));
  const byOrderProduct = new Map<string, (typeof orderLines)[number]>();
  for (const line of orderLines) {
    if (!trackedIds.has(line.productId)) continue;
    const key = `${line.orderName}\u0000${line.productId}`;
    const existing = byOrderProduct.get(key);
    if (existing) existing.quantity += line.quantity;
    else byOrderProduct.set(key, { ...line });
  }
  for (const line of byOrderProduct.values()) {
    await prisma.orderLineItem.upsert({
      where: {
        shop_orderName_productId: {
          shop,
          orderName: line.orderName,
          productId: line.productId,
        },
      },
      create: { shop, ...line },
      update: { sku: line.sku, quantity: line.quantity, orderedAt: line.orderedAt },
    });
  }

  // Persist delivery regions. Upserted per order so a re-run is idempotent.
  for (const region of regions) {
    await prisma.orderRegion.upsert({
      where: { shop_orderName: { shop, orderName: region.orderName } },
      create: { shop, ...region },
      update: {
        city: region.city,
        province: region.province,
        country: region.country,
        units: region.units,
        isCod: region.isCod,
        isConfirmed: region.isConfirmed,
        isDispatched: region.isDispatched,
        isCancelled: region.isCancelled,
      },
    });
  }

  return { recordsSynced, variantsSeen, completed };
}

/** Trim, collapse whitespace and title-case a city so it groups consistently. */
function normaliseCity(city: string | null | undefined): string | null {
  if (!city) return null;
  const cleaned = city.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
