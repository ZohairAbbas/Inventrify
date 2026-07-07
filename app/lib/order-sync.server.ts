import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";

const ORDERS_QUERY = `
  query getOrders($cursor: String, $query: String) {
    orders(first: 50, after: $cursor, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          createdAt
          cancelledAt
          lineItems(first: 50) {
            edges {
              node {
                variant { id }
                quantity
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function toMidnightUTC(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export async function syncOrderHistory(
  admin: AdminApiContext,
  shop: string,
): Promise<{ recordsSynced: number; variantsSeen: number }> {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const sinceStr = since.toISOString().split("T")[0];

  // Map: variantGid → { dateStr → totalQty }
  const salesMap = new Map<string, Map<string, number>>();

  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: {
        cursor,
        query: `created_at:>=${sinceStr} status:any`,
      },
    });

    const json = await response.json();
    const ordersData = json.data?.orders;
    if (!ordersData) break;

    for (const { node: order } of ordersData.edges) {
      // Skip cancelled orders
      if (order.cancelledAt) continue;

      const dateStr = (order.createdAt as string).split("T")[0];

      for (const { node: lineItem } of order.lineItems.edges) {
        const variantId: string | undefined = lineItem.variant?.id;
        if (!variantId) continue;

        if (!salesMap.has(variantId)) salesMap.set(variantId, new Map());
        const dayMap = salesMap.get(variantId)!;
        dayMap.set(dateStr, (dayMap.get(dateStr) ?? 0) + lineItem.quantity);
      }
    }

    hasNextPage = ordersData.pageInfo.hasNextPage;
    cursor = ordersData.pageInfo.endCursor;
  }

  let recordsSynced = 0;
  const variantsSeen = salesMap.size;

  for (const [variantId, dayMap] of salesMap) {
    // Only process variants we're tracking
    const product = await prisma.product.findUnique({
      where: { id: variantId },
    });
    if (!product) continue;

    // Replace last-90-days records for this product
    await prisma.salesRecord.deleteMany({
      where: { productId: variantId, date: { gte: since } },
    });

    const records = Array.from(dayMap.entries()).map(([dateStr, quantity]) => ({
      shop,
      productId: variantId,
      date: toMidnightUTC(dateStr),
      quantity,
    }));

    if (records.length > 0) {
      await prisma.salesRecord.createMany({ data: records, skipDuplicates: true });
      recordsSynced += records.length;
    }

    // Cache avgDailySales on Product — weighted: recent 30d counts 2x vs older 60d
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentQty = records.filter(r => r.date >= thirtyDaysAgo).reduce((s, r) => s + r.quantity, 0);
    const olderQty = records.filter(r => r.date < thirtyDaysAgo).reduce((s, r) => s + r.quantity, 0);
    const recentAvg = recentQty / 30;
    const olderAvg = olderQty / 60;
    const avgDailySales = (recentAvg * 2 + olderAvg) / 3;

    await prisma.product.update({
      where: { id: variantId },
      data: { avgDailySales },
    });
  }

  return { recordsSynced, variantsSeen };
}
