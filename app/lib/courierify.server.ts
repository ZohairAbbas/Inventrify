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
  shopifyOrderName?: string | null;
  sku: string;
  quantity: number;
  returnReceivedAt?: string | null;
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
 * upsert them into the ReturnItem queue (keyed on shipmentId+sku). Matches each SKU
 * to a local Product. Already-resolved rows (restocked/written_off) are never reopened;
 * an incoming isShopifyReturnClosed only reconciles. Advances courierifyReturnsCursor
 * on success. Best-effort: returns { queued, error? } and never throws.
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

    for (const evt of data) {
      if (!evt.sku) continue;
      const product = await prisma.product.findFirst({
        where: { shop, sku: evt.sku },
        select: { id: true },
      });

      const receivedAt = evt.returnReceivedAt ? new Date(evt.returnReceivedAt) : null;

      // Idempotent upsert. Never resets an already-resolved row back to pending.
      const existing = await prisma.returnItem.findUnique({
        where: { shipmentId_sku: { shipmentId: evt.shipmentId, sku: evt.sku } },
      });

      if (existing) {
        // Only refresh descriptive fields; leave status/resolution alone.
        await prisma.returnItem.update({
          where: { id: existing.id },
          data: {
            shopifyOrderName: evt.shopifyOrderName ?? existing.shopifyOrderName,
            reasonCategory: evt.reasonCategory ?? existing.reasonCategory,
            productId: existing.productId ?? product?.id ?? null,
            returnReceivedAt: receivedAt ?? existing.returnReceivedAt,
          },
        });
      } else {
        await prisma.returnItem.create({
          data: {
            shop,
            shipmentId: evt.shipmentId,
            shopifyOrderName: evt.shopifyOrderName ?? null,
            sku: evt.sku,
            productId: product?.id ?? null,
            quantity: Math.max(1, evt.quantity ?? 1),
            returnReceivedAt: receivedAt,
            reasonCategory: evt.reasonCategory ?? null,
          },
        });
        queued += 1;
      }
    }

    // Advance the cursor to now so the next pull is incremental.
    await prisma.shopSettings.update({
      where: { shop },
      data: { courierifyReturnsCursor: new Date() },
    });

    return { queued };
  } catch (err) {
    return {
      queued: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
