import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isCodOrder, parseCodGateways } from "../lib/cod.server";
import { shopDateKey, shopWeekStart } from "../lib/tz.server";
import { purgeShopData } from "../lib/shop-purge.server";

interface OrderPayload {
  id: number;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  financial_status?: string | null;
  line_items: { variant_id: number | null; quantity: number }[];
  created_at: string;
}

/**
 * Claim a webhook delivery, returning false if we have already processed it.
 *
 * Shopify retries any delivery that does not return 2xx quickly enough, and retries are
 * not rare. Every handler here mutates counters (`increment`, sales quantities), so a
 * replay used to silently double-count demand and inflate the return-rate denominator
 * permanently. The webhook id is unique per delivery, so inserting it is an atomic claim.
 */
async function claimDelivery(
  webhookId: string | null,
  shop: string,
  topic: string,
): Promise<boolean> {
  // Without an id we cannot dedupe; process it rather than drop data.
  if (!webhookId) return true;
  try {
    await prisma.webhookEvent.create({
      data: { id: webhookId, shop, topic },
    });
    return true;
  } catch {
    // Unique violation => this delivery was already handled.
    return false;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, payload } = await authenticate.webhook(request);

  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!(await claimDelivery(webhookId, shop, topic))) {
    return new Response(null, { status: 200 });
  }

  switch (topic) {
    case "ORDERS_CREATE": {
      const data = payload as OrderPayload;

      const settings = await prisma.shopSettings.findUnique({
        where: { shop },
        select: { timezone: true, codGateways: true },
      });
      const timezone = settings?.timezone ?? "UTC";
      const placedAt = new Date(data.created_at);
      const dateKey = shopDateKey(placedAt, timezone);

      // Demand is recorded here, in real time.
      //
      // Previously SalesRecord was only ever written by the 90-day backfill, which runs
      // on install and on a manual re-sync. Between those runs every forecast, reorder
      // point and alert silently operated on stale demand.
      const byVariant = new Map<string, number>();
      for (const item of data.line_items) {
        if (!item.variant_id) continue;
        const gid = `gid://shopify/ProductVariant/${item.variant_id}`;
        byVariant.set(gid, (byVariant.get(gid) ?? 0) + item.quantity);
      }
      if (byVariant.size === 0) break;

      const products = await prisma.product.findMany({
        where: { shop, id: { in: [...byVariant.keys()] } },
        select: { id: true, firstSoldAt: true },
      });

      const isCod = isCodOrder(data, parseCodGateways(settings?.codGateways));
      const weekStart = shopWeekStart(placedAt, timezone);

      for (const product of products) {
        const qty = byVariant.get(product.id) ?? 0;
        if (qty <= 0) continue;

        await prisma.salesRecord.upsert({
          where: { productId_date: { productId: product.id, date: dateKey } },
          create: { shop, productId: product.id, date: dateKey, quantity: qty },
          update: { quantity: { increment: qty } },
        });

        // Bounds the demand-variance window so a new SKU is not padded with fake
        // zero-demand days it never existed for.
        if (!product.firstSoldAt || product.firstSoldAt > dateKey) {
          await prisma.product.update({
            where: { id: product.id },
            data: { firstSoldAt: dateKey },
          });
        }

        // COD orders additionally form the denominator for RTO tracking.
        if (isCod) {
          await prisma.returnRateHistory.upsert({
            where: { productId_weekStart: { productId: product.id, weekStart } },
            create: {
              shop,
              productId: product.id,
              weekStart,
              returnRate: 0,
              orderCount: qty,
            },
            update: { orderCount: { increment: qty } },
          });
        }
      }
      break;
    }

    case "ORDERS_CANCELLED": {
      // A pre-dispatch cancellation is NOT an RTO.
      //
      // The old handler folded cancellations into returnRate, which drove safety stock.
      // They are economically opposite: a cancelled order never left the warehouse (no
      // freight, no round trip, stock was only ever reserved), whereas an RTO is a full
      // outbound+inbound journey with damage risk. Conflating them inflated buffers and
      // fought with the authoritative Courierify rate. Cancellations are tracked on
      // their own field and deliberately do not widen safety stock.
      const data = payload as OrderPayload;

      const settings = await prisma.shopSettings.findUnique({
        where: { shop },
        select: { timezone: true, codGateways: true },
      });
      const timezone = settings?.timezone ?? "UTC";
      const placedAt = new Date(data.created_at);
      const dateKey = shopDateKey(placedAt, timezone);

      const byVariant = new Map<string, number>();
      for (const item of data.line_items) {
        if (!item.variant_id) continue;
        const gid = `gid://shopify/ProductVariant/${item.variant_id}`;
        byVariant.set(gid, (byVariant.get(gid) ?? 0) + item.quantity);
      }
      if (byVariant.size === 0) break;

      const products = await prisma.product.findMany({
        where: { shop, id: { in: [...byVariant.keys()] } },
        select: { id: true },
      });

      for (const product of products) {
        const qty = byVariant.get(product.id) ?? 0;
        if (qty <= 0) continue;

        // Back the cancelled units out of recorded demand: they were never shipped, so
        // counting them as demand overstates what needs replenishing.
        const existing = await prisma.salesRecord.findUnique({
          where: { productId_date: { productId: product.id, date: dateKey } },
          select: { quantity: true },
        });
        if (existing) {
          await prisma.salesRecord.update({
            where: { productId_date: { productId: product.id, date: dateKey } },
            data: { quantity: Math.max(0, existing.quantity - qty) },
          });
        }

        // Track the cancellation rate over the trailing 30 days of orders.
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const [orderedAgg, product30] = await Promise.all([
          prisma.salesRecord.aggregate({
            where: { productId: product.id, date: { gte: thirtyDaysAgo } },
            _sum: { quantity: true },
          }),
          prisma.product.findUnique({
            where: { id: product.id },
            select: { cancellationRate: true },
          }),
        ]);
        const denom = (orderedAgg._sum.quantity ?? 0) + qty;
        if (denom > 0) {
          const prior = product30?.cancellationRate ?? 0;
          // Exponential smoothing keeps this stable against single-order noise.
          const observed = qty / denom;
          await prisma.product.update({
            where: { id: product.id },
            data: { cancellationRate: Math.min(1, prior * 0.8 + observed * 0.2) },
          });
        }
      }
      break;
    }

    case "INVENTORY_LEVELS_UPDATE": {
      // Per-location update.
      //
      // The old handler wrote the single location's `available` straight into
      // Product.currentStock, so on a multi-location shop the whole product collapsed to
      // whichever location reported last. It also stored `available` in a field that
      // means on-hand everywhere else. Now the level is written to the location it
      // belongs to and currentStock is recomputed as the sum.
      const data = payload as {
        inventory_item_id: number;
        available: number;
        location_id: number;
      };
      const inventoryItemGid = `gid://shopify/InventoryItem/${data.inventory_item_id}`;
      const locationGid = `gid://shopify/Location/${data.location_id}`;

      const product = await prisma.product.findFirst({
        where: { shop, inventoryItemId: inventoryItemGid },
        select: { id: true },
      });
      if (!product) break;

      const location = await prisma.location.findUnique({
        where: { shop_shopifyLocationId: { shop, shopifyLocationId: locationGid } },
        select: { id: true },
      });

      if (!location) {
        // Unknown location (not yet synced): fall back to the aggregate so we do not
        // lose the signal entirely, but do not invent per-location rows.
        await prisma.product.update({
          where: { id: product.id },
          data: { currentStock: data.available },
        });
        break;
      }

      await prisma.$transaction(async (tx) => {
        await tx.productLocationStock.upsert({
          where: {
            productId_locationId: { productId: product.id, locationId: location.id },
          },
          create: {
            shop,
            productId: product.id,
            locationId: location.id,
            onHand: data.available,
            reserved: 0,
          },
          update: { onHand: data.available },
        });
        const agg = await tx.productLocationStock.aggregate({
          where: { productId: product.id },
          _sum: { onHand: true },
        });
        await tx.product.update({
          where: { id: product.id },
          data: { currentStock: agg._sum.onHand ?? 0 },
        });
      });
      break;
    }

    case "APP_UNINSTALLED": {
      if (session) await purgeShopData(shop);
      break;
    }

    case "SHOP_REDACT": {
      // Mandatory compliance topic: erase everything we hold for the shop. This was
      // previously a no-op, which left every row behind after uninstall + redaction.
      await purgeShopData(shop);
      break;
    }

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT": {
      // Inventorify stores no personal customer data: orders are reduced to per-variant
      // daily quantities before storage, and no customer identifiers are retained.
      break;
    }

    default: {
      console.warn(`[inventorify] Unhandled webhook topic: ${topic}`);
    }
  }

  return new Response(null, { status: 200 });
};
