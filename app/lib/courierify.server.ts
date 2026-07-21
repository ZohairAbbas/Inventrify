import prisma from "../db.server";

// Base URL of Courierify's deployment. Set COURIERIFY_BASE_URL per environment
// (prod: https://courierify.growzar.com). Fallback is the same prod host so a missing
// env var degrades to prod rather than an unresolvable placeholder.
const COURIERIFY_BASE = (process.env.COURIERIFY_BASE_URL || "https://courierify.growzar.com").replace(/\/$/, "");
// Courierify's external API is served under /api/external with flat-file routing
// (see COURIERIFY_EXTERNAL_API.md). All responses go through a shared wrapper that
// envelopes the payload as { timestamp, rows: [...] } and errors as { error, errorType }.
const COURIERIFY_EXTERNAL = `${COURIERIFY_BASE}/api/external`;

/**
 * Fetch a Courierify external-API endpoint and unwrap its response envelope.
 * Every /api/external route returns { timestamp, ...payload }; our two endpoints
 * put the array under `rows`. Errors come back as { error, errorType }.
 * Returns { rows } on success or { error } on any failure — never throws.
 */
async function fetchExternal<T>(
  path: string,
  apiKey: string,
  params: Record<string, string>,
): Promise<{ rows: T[]; error?: undefined } | { rows?: undefined; error: string }> {
  try {
    const qs = new URLSearchParams(params).toString();
    const response = await fetch(`${COURIERIFY_EXTERNAL}${path}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const body = (await response.json().catch(() => null)) as
      | { rows?: T[]; error?: string; errorType?: string }
      | null;

    if (!response.ok) {
      return { error: body?.error ?? `Courierify API error: ${response.status}` };
    }
    return { rows: Array.isArray(body?.rows) ? body!.rows : [] };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Unknown error" };
  }
}

interface ReturnRateEntry {
  sku: string;
  returnRate: number;
}

interface StatusSummaryEntry {
  sku: string;
  delivered: number;
  inTransit: number;
  returned: number;
}

interface ReturnEventEntry {
  shipmentId: string;
  lineItemId: string; // Courierify ShipmentLineItem.id — always present, our dedup key
  shopifyOrderName?: string | null;
  sku?: string | null; // nullable — SKU-less products
  shopifyVariantId?: string | null; // fallback match key (= Product.id, the variant GID)
  title?: string | null;
  variantTitle?: string | null;
  quantity: number;
  returnReceivedAt?: string | null;
  updatedAt?: string | null; // the field Courierify filters on — drives the cursor
  isShopifyReturnClosed?: boolean;
  reasonCategory?: string | null;
}

/**
 * Sync per-SKU COD return rates into Product.codReturnRate — the input to the
 * per-variant Net (COD-adjusted) demand forecast. Courierify's shop-level
 * /api/external/delivery RTS analysis has no SKU dimension and is Growzar-gated, so
 * this uses a dedicated per-SKU, ungated endpoint under the inventrify/* namespace
 * (see Plans/courierify-inventrify-contract.md §3). Best-effort; never throws.
 */
export async function syncCourierifyReturnRates(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; error?: string }> {
  try {
    const result = await fetchExternal<ReturnRateEntry>(
      "/inventrify/return-rates",
      apiKey,
      { shop },
    );
    if (result.error) return { synced: 0, error: result.error };

    let synced = 0;
    for (const entry of result.rows ?? []) {
      if (!entry.sku) continue;
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: { codReturnRate: Math.min(1, Math.max(0, entry.returnRate)) },
      });
      synced += updated.count;
    }

    return { synced };
  } catch (err) {
    return {
      synced: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Pull the per-SKU live fulfilment-status snapshot from Courierify and cache the
 * counts onto Product (fulfilledDelivered/InTransit/Returned). Damaged is never
 * synced here — it is derived from StockAdjustment(reason="damage"). Best-effort:
 * returns { synced, error? } and never throws. See Plans/courierify-inventrify-contract.md.
 */
export async function syncCourierifyFulfilmentStatus(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; error?: string }> {
  try {
    const result = await fetchExternal<StatusSummaryEntry>(
      "/inventrify/status-summary",
      apiKey,
      { shop },
    );
    if (result.error) return { synced: 0, error: result.error };

    const data = result.rows ?? [];
    const now = new Date();
    let synced = 0;

    for (const entry of data) {
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: {
          fulfilledDelivered: Math.max(0, entry.delivered ?? 0),
          fulfilledInTransit: Math.max(0, entry.inTransit ?? 0),
          fulfilledReturned: Math.max(0, entry.returned ?? 0),
          fulfilmentSyncedAt: now,
        },
      });
      synced += updated.count;
    }

    return { synced };
  } catch (err) {
    return {
      synced: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Pull return-received events from Courierify since the shop's stored cursor and
 * upsert them into the ReturnItem queue (keyed on shipmentId+lineItemId). Matches each
 * line to a local Product by sku, then by Shopify variant GID; unmatched lines are still
 * queued (surfaced for manual assignment) rather than dropped. Already-resolved rows are
 * never reopened. Advances courierifyReturnsCursor to max(updatedAt) seen − buffer (never
 * to wall-clock now). Best-effort: returns { queued, error? } and never throws.
 */
export async function syncCourierifyReturns(
  shop: string,
  apiKey: string,
): Promise<{ queued: number; error?: string }> {
  try {
    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    const cursor = settings?.courierifyReturnsCursor;

    const params: Record<string, string> = { shop };
    if (cursor) params.updatedSince = cursor.toISOString();

    const result = await fetchExternal<ReturnEventEntry>("/inventrify/returns", apiKey, params);
    if (result.error) return { queued: 0, error: result.error };

    const data = result.rows ?? [];
    let queued = 0;
    let maxUpdatedAt: Date | null = null;

    for (const evt of data) {
      if (!evt.lineItemId) continue; // dedup key must be present

      // Track the newest updatedAt seen — this drives the cursor (the field Courierify
      // filters on), not returnReceivedAt (a different, earlier field) or wall-clock now.
      const updatedAt = evt.updatedAt ? new Date(evt.updatedAt) : null;
      if (updatedAt && (!maxUpdatedAt || updatedAt > maxUpdatedAt)) maxUpdatedAt = updatedAt;

      // Match to a local Product: prefer sku, fall back to the Shopify variant GID
      // (Product.id IS the variant GID). null = unmatched → surfaced for manual assignment.
      let productId: string | null = null;
      if (evt.sku) {
        productId = (await prisma.product.findFirst({ where: { shop, sku: evt.sku }, select: { id: true } }))?.id ?? null;
      }
      if (!productId && evt.shopifyVariantId) {
        productId = (await prisma.product.findFirst({ where: { shop, id: evt.shopifyVariantId }, select: { id: true } }))?.id ?? null;
      }

      const receivedAt = evt.returnReceivedAt ? new Date(evt.returnReceivedAt) : null;

      // Idempotent upsert keyed on (shipmentId, lineItemId). Never resets a resolved row.
      const existing = await prisma.returnItem.findUnique({
        where: { shipmentId_lineItemId: { shipmentId: evt.shipmentId, lineItemId: evt.lineItemId } },
      });

      if (existing) {
        // Refresh descriptive/match fields; leave status/resolution alone.
        await prisma.returnItem.update({
          where: { id: existing.id },
          data: {
            shopifyOrderName: evt.shopifyOrderName ?? existing.shopifyOrderName,
            sku: evt.sku ?? existing.sku,
            shopifyVariantId: evt.shopifyVariantId ?? existing.shopifyVariantId,
            title: evt.title ?? existing.title,
            variantTitle: evt.variantTitle ?? existing.variantTitle,
            reasonCategory: evt.reasonCategory ?? existing.reasonCategory,
            productId: existing.productId ?? productId,
            returnReceivedAt: receivedAt ?? existing.returnReceivedAt,
          },
        });
      } else {
        await prisma.returnItem.create({
          data: {
            shop,
            shipmentId: evt.shipmentId,
            lineItemId: evt.lineItemId,
            shopifyOrderName: evt.shopifyOrderName ?? null,
            sku: evt.sku ?? null,
            shopifyVariantId: evt.shopifyVariantId ?? null,
            title: evt.title ?? null,
            variantTitle: evt.variantTitle ?? null,
            productId,
            quantity: Math.max(1, evt.quantity ?? 1),
            returnReceivedAt: receivedAt,
            reasonCategory: evt.reasonCategory ?? null,
          },
        });
        queued += 1;
      }
    }

    // Advance the cursor to the newest updatedAt actually seen, minus a small overlap
    // buffer so a boundary/skew case is re-fetched (the upsert makes re-pulls idempotent).
    // Only advance when we saw timestamped rows — an empty pull must not move the cursor
    // forward (that's what silently skipped returns before).
    if (maxUpdatedAt) {
      const OVERLAP_MS = 60_000;
      const next = new Date(maxUpdatedAt.getTime() - OVERLAP_MS);
      // Never move the cursor backwards past where it already was.
      const advanced = cursor && next < cursor ? cursor : next;
      await prisma.shopSettings.update({
        where: { shop },
        data: { courierifyReturnsCursor: advanced },
      });
    }

    return { queued };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
