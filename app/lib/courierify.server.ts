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
  // Optional by design — the contract does not guarantee a carrier, so this is read
  // opportunistically and stays null when absent rather than being required.
  courier?: string | null;
}

/**
 * Sync per-SKU COD return rates from real delivery outcomes.
 *
 * Writes `courierRtoRate`, not `codReturnRate`. Two sources used to write the latter
 * directly — this sync, and the orders/cancelled webhook — so whichever ran last won,
 * non-deterministically, and cancellations (which are not RTOs) could overwrite measured
 * delivery outcomes. `codReturnRate` is now a resolved value with Courierify taking
 * precedence; see resolveReturnRate() in planning.server.ts.
 *
 * Courierify's shop-level /api/external/delivery RTS analysis has no SKU dimension and
 * is Growzar-gated, so this uses a dedicated per-SKU, ungated endpoint under the
 * inventrify/* namespace (see docs/courierify-integration.md §3).
 * Best-effort; never throws.
 */
export async function syncCourierifyReturnRates(
  shop: string,
  apiKey: string,
): Promise<{ synced: number; unmatched?: number; error?: string }> {
  try {
    const result = await fetchExternal<ReturnRateEntry>(
      "/inventrify/return-rates",
      apiKey,
      { shop },
    );
    if (result.error) return { synced: 0, error: result.error };

    let synced = 0;
    let unmatched = 0;
    for (const entry of result.rows ?? []) {
      if (!entry.sku) continue;
      const rate = Math.min(1, Math.max(0, entry.returnRate));
      const updated = await prisma.product.updateMany({
        where: { shop, sku: entry.sku },
        data: {
          courierRtoRate: rate,
          // Stamped so precedence can require the feed to be *current*, not merely to
          // have reported once. A courier that goes quiet stops outranking live data.
          courierRtoSyncedAt: new Date(),
          codReturnRate: rate,
          returnRateSource: "courierify",
        },
      });
      if (updated.count === 0) unmatched += 1;
      synced += updated.count;
    }

    // SKUs Courierify knows about that we cannot match locally are silent gaps in the
    // RTO data — surfaced so the merchant can see coverage rather than assuming 100%.
    return { synced, unmatched };
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
 * returns { synced, error? } and never throws. See docs/courierify-integration.md.
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
          fulfilmentSource: "courierify",
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
            // Attribute the return to a delivery region so RTO can be broken down by
            // city. A shop-wide average hides which routes are losing money.
            city: evt.shopifyOrderName
              ? (
                  await prisma.orderRegion.findUnique({
                    where: { shop_orderName: { shop, orderName: evt.shopifyOrderName } },
                    select: { city: true },
                  })
                )?.city ?? null
              : null,
            courier: evt.courier ?? null,
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

/**
 * One shipment's outcome, keyed to a Shopify order rather than to a SKU.
 *
 * Contract for `GET /api/external/inventrify/order-outcomes`. If the endpoint 404s (or is
 * plan-gated) syncCourierifyOrderOutcomes reports unavailable without touching any data.
 *
 * Shape, mirroring the sibling ungated endpoints:
 *   { timestamp, rows: [{ shipmentId, shopifyOrderName, status, updatedAt, courier? }] }
 *   Query: ?shop=<domain>[&updatedSince=<ISO>]
 *   Rows come oldest-first by updatedAt, at most 5,000 per response.
 *
 * Every field already exists on Courierify's Shipment table, and shopifyOrderName is
 * populated on 100% of rows sampled, so no backfill is required to serve this.
 */
/** Courierify's order-outcomes page size; a page this long may have more behind it. */
const OUTCOMES_PAGE_LIMIT = 5000;
/** Pages per run. A 60k-shipment backfill finishes in two runs rather than a day. */
const OUTCOMES_MAX_PAGES_PER_RUN = 10;
/** Cursor step-back, so a row committed with a slightly earlier timestamp is re-read. */
const OUTCOMES_OVERLAP_MS = 60_000;

export interface OrderOutcomeEntry {
  shipmentId: string;
  shopifyOrderName?: string | null;
  status: string;
  updatedAt?: string | null;
  courier?: string | null;
}

/**
 * Pull order-level delivery outcomes and store them for local per-SKU attribution.
 *
 * Why this exists: the per-SKU endpoints group on ShipmentLineItem.sku, which is unset on
 * the overwhelming majority of real shipments, so they return nothing for shops with
 * thousands of genuine returns. Order-level outcomes joined to OrderLineItem reconstruct
 * the same per-SKU figure locally. See rto-attribution.server.ts.
 *
 * Degrades quietly: an absent endpoint is an expected state, not an error to alarm on.
 */
export async function syncCourierifyOrderOutcomes(
  shop: string,
  apiKey: string,
): Promise<{ stored: number; available: boolean; missingTimestamp?: number; error?: string }> {
  let stored = 0;
  let missingTimestamp = 0;
  const summary = () => (missingTimestamp ? { missingTimestamp } : {});

  try {
    const settings = await prisma.shopSettings.findUnique({ where: { shop } });
    let cursor = settings?.courierifyOutcomesCursor ?? null;

    for (let page = 0; page < OUTCOMES_MAX_PAGES_PER_RUN; page++) {
      const params: Record<string, string> = { shop };
      if (cursor) params.updatedSince = cursor.toISOString();

      const result = await fetchExternal<OrderOutcomeEntry>(
        "/inventrify/order-outcomes",
        apiKey,
        params,
      );

      if (result.error) {
        // A later page failing leaves the cursor where the last good page put it; the
        // next run resumes from there.
        if (page > 0) return { stored, available: true, error: result.error, ...summary() };
        // The endpoint not existing yet, or being gated, is not a failure worth surfacing
        // to the merchant — it simply means this capability is not switched on.
        const unavailable = /404|not found|plan|scope|denied/i.test(result.error);
        return {
          stored: 0,
          available: !unavailable,
          error: unavailable ? undefined : result.error,
        };
      }

      const rows = result.rows ?? [];
      let maxUpdatedAt: Date | null = null;

      for (const row of rows) {
        if (!row.shipmentId || !row.shopifyOrderName || !row.status) continue;
        // No usable timestamp means no honest place for the row. Stamping it "now" used to
        // drag an old outcome into the last-7/30-day windows and push the cursor past
        // older rows not yet pulled, so it is skipped and counted instead.
        const updatedAt = row.updatedAt ? new Date(row.updatedAt) : null;
        if (!updatedAt || Number.isNaN(updatedAt.getTime())) {
          missingTimestamp += 1;
          continue;
        }
        if (!maxUpdatedAt || updatedAt > maxUpdatedAt) maxUpdatedAt = updatedAt;

        await prisma.orderOutcome.upsert({
          where: { shop_shipmentId: { shop, shipmentId: row.shipmentId } },
          create: {
            shop,
            shipmentId: row.shipmentId,
            orderName: row.shopifyOrderName,
            status: row.status,
            courier: row.courier ?? null,
            updatedAt,
          },
          // A shipment's status changes over its life; the latest wins.
          update: { status: row.status, courier: row.courier ?? null, updatedAt },
        });
        stored += 1;
      }

      // Same cursor rules as the returns pull: advance only to what was actually seen,
      // with an overlap buffer, never on an empty page, never backwards.
      if (!maxUpdatedAt) break;
      const full = rows.length >= OUTCOMES_PAGE_LIMIT;
      let next = new Date(maxUpdatedAt.getTime() - OUTCOMES_OVERLAP_MS);
      // Courierify pages oldest-first, so a full page ends where the next one starts.
      // If the whole page fell inside the overlap, stepping back would request the same
      // page forever; step to its last timestamp instead. Rows sharing that timestamp are
      // re-sent, which the upsert absorbs.
      if (full && cursor && next <= cursor) next = maxUpdatedAt;
      const advanced = cursor && next < cursor ? cursor : next;
      await prisma.shopSettings.update({
        where: { shop },
        data: { courierifyOutcomesCursor: advanced },
      });

      if (!full) break;
      if (cursor && advanced <= cursor) {
        // Over a page of rows share one timestamp: Courierify cannot page past them.
        console.warn(
          `[inventorify] ${shop}: Courierify outcomes stalled — ${rows.length} rows at ${maxUpdatedAt.toISOString()}`,
        );
        break;
      }
      console.warn(
        `[inventorify] ${shop}: Courierify returned a full page of ${rows.length} outcomes; requesting the next`,
      );
      cursor = advanced;
    }

    if (missingTimestamp > 0) {
      console.warn(
        `[inventorify] ${shop}: skipped ${missingTimestamp} Courierify outcome(s) with no updatedAt`,
      );
    }

    return { stored, available: true, ...summary() };
  } catch (err) {
    return {
      stored,
      available: true,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
