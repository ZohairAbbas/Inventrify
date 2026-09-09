import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  syncCourierifyFulfilmentStatus,
  syncCourierifyOrderOutcomes,
  syncCourierifyReturnRates,
  syncCourierifyReturns,
} from "../lib/courierify.server";
import { recomputeDerivedRto } from "../lib/rto-attribution.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { listSyncableShops } from "../lib/active-shops.server";
import { decryptSecret } from "../lib/crypto.server";

/**
 * Cron endpoint — protected by CRON_SECRET header.
 * Refreshes Courierify-sourced data for every connected shop:
 *   - fulfilment-status snapshot (Product.fulfilled* counts)
 *   - returns-to-restock queue (new ReturnItem rows since each shop's cursor)
 *
 * Recommended cadence: daily for the snapshot is fine; returns benefit from hourly.
 * Both pulls run together here — schedule this as often as the returns queue needs.
 *
 * POST /api/cron/courierify
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // Scoped to installed shops: settings can outlive an uninstall whose webhook was missed,
  // and polling a departed merchant's courier account on their stored key is not something
  // we should keep doing.
  const installed = await listSyncableShops();
  const connected = await prisma.shopSettings.findMany({
    where: { courierifyApiKey: { not: null }, shop: { in: installed } },
    select: { shop: true, courierifyApiKey: true },
  });

  const results: {
    shop: string;
    rates: number;
    ratesError?: string;
    fulfilment: number;
    fulfilmentError?: string;
    returns: number;
    returnsError?: string;
    outcomes: number;
    outcomesAvailable: boolean;
    outcomesError?: string;
    derivedRtoSkus: number;
  }[] = [];

  for (const { shop, courierifyApiKey } of connected) {
    const apiKey = decryptSecret(courierifyApiKey);
    if (!apiKey) continue;
    // The per-SKU RTO rate belongs on the same hourly cadence as everything else it is
    // read alongside. It was previously only refreshed when a merchant saved settings,
    // so a connected shop's rate could sit untouched for weeks — and now that precedence
    // requires the courier feed to be *current*, a rate that never refreshes would
    // eventually and silently hand priority to Shopify tracking.
    const rates = await syncCourierifyReturnRates(shop, apiKey);
    const status = await syncCourierifyFulfilmentStatus(shop, apiKey);
    const returns = await syncCourierifyReturns(shop, apiKey);

    // Order-level outcomes are the fallback path for per-SKU RTO, used where the
    // courier's own per-SKU endpoints come back empty because shipment line items carry
    // no SKU. Inert until that endpoint exists: `available` is false and nothing is
    // written or recomputed.
    const outcomes = await syncCourierifyOrderOutcomes(shop, apiKey);
    const derived = outcomes.available && outcomes.stored > 0
      ? await recomputeDerivedRto(shop)
      : { attributed: 0 };
    results.push({
      shop,
      rates: rates.synced,
      ratesError: rates.error,
      fulfilment: status.synced,
      fulfilmentError: status.error,
      returns: returns.queued,
      returnsError: returns.error,
      outcomes: outcomes.stored,
      outcomesAvailable: outcomes.available,
      outcomesError: outcomes.error,
      derivedRtoSkus: derived.attributed,
    });
  }

  return json({ shops: connected.length, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async ({ request: _request }: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
