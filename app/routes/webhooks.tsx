import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { isCodOrder, parseCodGateways } from "../lib/cod.server";
import { shopDateKey, shopWeekStart } from "../lib/tz.server";
import { purgeShopData } from "../lib/shop-purge.server";
import { applyInventoryLevelUpdate } from "../lib/stock.server";

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

/**
 * Topics whose handler can safely run twice, and may therefore have a failed delivery
 * released back for Shopify to retry.
 *
 * The claim is taken *before* the handler runs, which is what makes it an atomic guard
 * against double-counting — but it was never released on failure, so a handler that threw
 * (a DB blip, a timeout on a long purge) burned the only attempt that would ever be
 * processed: Shopify retries, the retry sees the claim row and returns early, and the
 * delivery is lost for good. That is how an APP_UNINSTALLED disappears without ever
 * purging the shop.
 *
 * Releasing unconditionally would be worse than the bug it fixes. ORDERS_CREATE and
 * ORDERS_CANCELLED apply relative changes (`increment`, `quantity - qty`) product by
 * product outside a transaction, so a handler that dies halfway has already committed
 * part of its work; re-running it would count those units twice and permanently inflate
 * demand. For those, a lost delivery — which the hourly reconciliation sync repairs — is
 * the lesser harm, so the claim stands.
 *
 * The topics below are all absolute or idempotent: the purges delete by shop, and
 * INVENTORY_LEVELS_UPDATE writes an absolute quantity in a transaction.
 */
const RERUNNABLE_TOPICS = new Set([
  "APP_UNINSTALLED",
  "SHOP_REDACT",
  "INVENTORY_LEVELS_UPDATE",
  "CUSTOMERS_DATA_REQUEST",
  "CUSTOMERS_REDACT",
]);

/** Give a claimed delivery back so Shopify's retry can pick it up. */
async function releaseDelivery(webhookId: string | null, topic: string): Promise<void> {
  if (!webhookId || !RERUNNABLE_TOPICS.has(topic)) return;
  try {
    await prisma.webhookEvent.delete({ where: { id: webhookId } });
  } catch {
    // Already gone (e.g. purged along with the shop) — nothing to release.
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!(await claimDelivery(webhookId, shop, topic))) {
    return new Response(null, { status: 200 });
  }

  try {
    await handleTopic({ topic, shop, payload });
  } catch (err) {
    // Hand the claim back before failing, so Shopify's retry is actually processed
    // instead of being deduped away as "already handled" — for the topics where a
    // re-run is safe.
    await releaseDelivery(webhookId, topic);
    throw err;
  }

  return new Response(null, { status: 200 });
};

async function handleTopic({
  topic,
  shop,
  payload,
}: {
  topic: string;
  shop: string;
  payload: unknown;
}) {
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
      // fought with the authoritative Courierify rate. Cancellations are tracked
      // separately and deliberately do not widen safety stock.
      const data = payload as OrderPayload;

      const settings = await prisma.shopSettings.findUnique({
        where: { shop },
        select: { timezone: true, codGateways: true },
      });
      const timezone = settings?.timezone ?? "UTC";
      const placedAt = new Date(data.created_at);
      const dateKey = shopDateKey(placedAt, timezone);
      const weekStart = shopWeekStart(placedAt, timezone);
      // Only COD cancellations are counted, because orderCount — the denominator they
      // are measured against — is only populated for COD orders.
      const isCod = isCodOrder(data, parseCodGateways(settings?.codGateways));

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
        // counting them as demand overstates what needs replenishing. Done in SQL with
        // GREATEST so concurrent cancellations cannot lose an update or drive the
        // quantity negative.
        await prisma.$executeRaw`
          UPDATE "SalesRecord"
          SET "quantity" = GREATEST(0, "quantity" - ${qty})
          WHERE "productId" = ${product.id} AND "date" = ${dateKey}
        `;

        if (!isCod) continue;

        // Record the cancellation against the same weekly bucket that holds the COD
        // order count, so the rate is cancelled units over units actually ordered.
        await prisma.returnRateHistory.upsert({
          where: { productId_weekStart: { productId: product.id, weekStart } },
          create: {
            shop,
            productId: product.id,
            weekStart,
            returnRate: 0,
            orderCount: 0,
            cancelledUnits: qty,
          },
          update: { cancelledUnits: { increment: qty } },
        });

        await recomputeCancellationRate(product.id);
      }
      break;
    }

    case "INVENTORY_LEVELS_UPDATE": {
      // Per-location update. The logic lives in lib/stock.server so it can be tested
      // without standing up webhook authentication; see stock.db.test.ts.
      const data = payload as {
        inventory_item_id: number;
        available: number;
        location_id: number;
      };
      await applyInventoryLevelUpdate(
        shop,
        `gid://shopify/InventoryItem/${data.inventory_item_id}`,
        `gid://shopify/Location/${data.location_id}`,
        data.available,
      );
      break;
    }

    case "APP_UNINSTALLED": {
      // Deliberately NOT gated on `session`.
      //
      // It used to be, and that guard was the whole bug: offline tokens expire
      // (`expiringOfflineAccessTokens`), a redelivery arrives after the session row is
      // already gone, and in either case `session` is undefined — so the purge was
      // skipped and every row for that shop survived the uninstall. Nothing downstream
      // could then clear it: install, manual re-sync and cron are all upsert-only, so
      // the merchant reinstalled, re-synced, and saw their original bad data again.
      //
      // purgeShopData is idempotent and scoped to this shop, so running it without a
      // session is safe; SHOP_REDACT below has always done exactly that.
      await purgeShopData(shop);
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
}

/**
 * Cancellation rate = COD units cancelled before dispatch / COD units ordered, over the
 * trailing four weeks.
 *
 * An earlier version of this computed `qty / (30-day demand + qty)` per cancellation
 * event and exponentially smoothed it. That is not a rate: it measures what share of a
 * month's demand one cancellation represents, so it is inverted by volume — a SKU selling
 * 4 units a month showed a 33% "cancellation rate" from a single 2-unit cancellation,
 * while the same cancellation on a 400-unit SKU showed 0.5%.
 */
async function recomputeCancellationRate(productId: string) {
  const fourWeeksAgo = new Date(Date.now() - 28 * 86400000);
  const agg = await prisma.returnRateHistory.aggregate({
    where: { productId, weekStart: { gte: fourWeeksAgo } },
    _sum: { orderCount: true, cancelledUnits: true },
  });

  const ordered = agg._sum.orderCount ?? 0;
  const cancelled = agg._sum.cancelledUnits ?? 0;
  // No ordered volume yet means no rate can be computed; leave the previous value be
  // rather than writing a number derived from nothing.
  if (ordered <= 0) return;

  await prisma.product.update({
    where: { id: productId },
    data: { cancellationRate: Math.min(1, Math.max(0, cancelled / ordered)) },
  });
}
