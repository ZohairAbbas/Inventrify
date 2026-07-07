import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } =
    await authenticate.webhook(request);

  switch (topic) {
    case "ORDERS_CREATE": {
      // Real-time: track weekly return rate denominator (order count per variant)
      const data = payload as {
        id: number;
        gateway?: string;
        line_items: { variant_id: number | null; quantity: number }[];
        created_at: string;
      };
      const isCod =
        data.gateway?.toLowerCase().includes("cod") ||
        data.gateway?.toLowerCase().includes("cash");
      if (isCod) {
        const weekStart = getWeekStart(new Date(data.created_at));
        for (const item of data.line_items) {
          if (!item.variant_id) continue;
          const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
          const product = await prisma.product.findFirst({
            where: { id: variantGid, shop },
          });
          if (!product) continue;
          await prisma.returnRateHistory.upsert({
            where: {
              productId_weekStart: { productId: product.id, weekStart },
            },
            create: {
              shop,
              productId: product.id,
              weekStart,
              returnRate: 0,
              orderCount: item.quantity,
            },
            update: { orderCount: { increment: item.quantity } },
          });
        }
      }
      break;
    }

    case "ORDERS_CANCELLED": {
      // Real-time: update return rate when a COD order is cancelled
      const data = payload as {
        id: number;
        gateway?: string;
        line_items: { variant_id: number | null; quantity: number }[];
        created_at: string;
      };
      const isCod =
        data.gateway?.toLowerCase().includes("cod") ||
        data.gateway?.toLowerCase().includes("cash");
      if (isCod) {
        const weekStart = getWeekStart(new Date(data.created_at));
        for (const item of data.line_items) {
          if (!item.variant_id) continue;
          const variantGid = `gid://shopify/ProductVariant/${item.variant_id}`;
          const product = await prisma.product.findFirst({
            where: { id: variantGid, shop },
          });
          if (!product) continue;
          // Find or create return rate record and recalculate
          const existing = await prisma.returnRateHistory.findUnique({
            where: {
              productId_weekStart: { productId: product.id, weekStart },
            },
          });
          if (existing && existing.orderCount > 0) {
            // Increment return count by estimating from existing rate
            const currentReturns = Math.round(
              existing.returnRate * existing.orderCount,
            );
            const newReturns = currentReturns + item.quantity;
            const newRate = Math.min(1, newReturns / existing.orderCount);
            await prisma.returnRateHistory.update({
              where: {
                productId_weekStart: { productId: product.id, weekStart },
              },
              data: { returnRate: newRate },
            });
            // Update product's cached return rate (rolling average of last 4 weeks)
            await updateProductReturnRate(product.id, shop);
          }
        }
      }
      break;
    }

    case "INVENTORY_LEVELS_UPDATE": {
      // Real-time stock update by inventory_item_id
      const data = payload as {
        inventory_item_id: number;
        available: number;
        location_id: number;
      };
      const inventoryItemGid = `gid://shopify/InventoryItem/${data.inventory_item_id}`;
      await prisma.product.updateMany({
        where: { shop, inventoryItemId: inventoryItemGid },
        data: { currentStock: data.available },
      });
      break;
    }

    case "APP_UNINSTALLED": {
      if (session) {
        // Delete in safe order to respect FK constraints
        await prisma.alert.deleteMany({ where: { shop } });
        await prisma.forecast.deleteMany({ where: { shop } });
        await prisma.returnRateHistory.deleteMany({ where: { shop } });
        await prisma.stockAdjustment.deleteMany({ where: { shop } });
        await prisma.stockSnapshot.deleteMany({ where: { shop } });
        await prisma.salesRecord.deleteMany({ where: { shop } });
        await prisma.seasonalEvent.deleteMany({ where: { shop } });

        const products = await prisma.product.findMany({
          where: { shop },
          select: { id: true },
        });
        const ids = products.map((p) => p.id);
        if (ids.length > 0) {
          await prisma.purchaseOrderItem.deleteMany({
            where: { productId: { in: ids } },
          });
        }
        await prisma.purchaseOrder.deleteMany({ where: { shop } });
        await prisma.supplier.deleteMany({ where: { shop } });
        await prisma.product.deleteMany({ where: { shop } });
        await prisma.shopSettings.deleteMany({ where: { shop } });
        await prisma.session.deleteMany({ where: { shop } });
      }
      break;
    }

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT": {
      // inventorify does not store personal customer data
      break;
    }

    default: {
      console.warn(`[inventorify] Unhandled webhook topic: ${topic}`);
    }
  }

  return new Response(null, { status: 200 });
};

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day; // Monday
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function updateProductReturnRate(productId: string, shop: string) {
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
  const records = await prisma.returnRateHistory.findMany({
    where: { productId, shop, weekStart: { gte: fourWeeksAgo } },
    orderBy: { weekStart: "desc" },
  });
  if (records.length === 0) return;

  // Weighted: recent week counts 2x
  const [latest, ...older] = records;
  const olderAvg =
    older.length > 0
      ? older.reduce((s, r) => s + r.returnRate, 0) / older.length
      : latest.returnRate;
  const weightedRate = (latest.returnRate * 2 + olderAvg) / 3;

  await prisma.product.update({
    where: { id: productId },
    data: { codReturnRate: Math.min(1, weightedRate) },
  });
}
