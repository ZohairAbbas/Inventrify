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
          createdAt
          cancelledAt
          paymentGatewayNames
          lineItems(first: 100) {
            edges {
              node {
                variant { id }
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
  createdAt: string;
  cancelledAt: string | null;
  paymentGatewayNames: string[] | null;
  lineItems: Paged<{ variant: { id: string } | null; quantity: number }>;
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
    select: { timezone: true, codGateways: true },
  });
  const timezone = settings?.timezone ?? "UTC";
  const codGateways = parseCodGateways(settings?.codGateways);

  // variantGid -> (dateKey ISO -> qty)
  const salesMap = new Map<string, Map<string, number>>();
  // variantGid -> (weekStart ISO -> COD order units), the RTO denominator.
  const codMap = new Map<string, Map<string, number>>();

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
        // Skip cancelled orders
        if (order.cancelledAt) continue;

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

        for (const { node: lineItem } of order.lineItems.edges) {
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

  return { recordsSynced, variantsSeen, completed };
}
