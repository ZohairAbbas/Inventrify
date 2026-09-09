import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { listSyncableShops } from "../lib/active-shops.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { describeError } from "../lib/shopify-graphql.server";
import {
  recomputeClassifications,
  refreshForecasts,
  scoreForecastAccuracy,
} from "../lib/planning-job.server";

/**
 * Nightly planning refresh — no Shopify calls, so it needs no admin session.
 *
 * 1. Score forecasts whose horizon has elapsed (fills the accuracy/bias ledger).
 * 2. Recompute ABC/XYZ, which sets the per-class service level.
 * 3. Regenerate forecasts, reorder points and safety stock.
 *
 * Order matters: classification feeds the Z-score that step 3 uses.
 *
 * POST /api/cron/planning
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await listSyncableShops();

  const results: {
    shop: string;
    scored: number;
    classified: number;
    refreshed: number;
    errors: number;
    error?: string;
  }[] = [];

  for (const shop of shops) {
    try {
      const { scored } = await scoreForecastAccuracy(shop);
      const { classified } = await recomputeClassifications(shop);
      const { refreshed, errors } = await refreshForecasts(shop);
      results.push({ shop, scored, classified, refreshed, errors });
    } catch (err) {
      // One failing shop must not abort the sweep.
      const message = describeError(err);
      console.error(`[cron/planning] ${shop} failed:`, message);
      results.push({ shop, scored: 0, classified: 0, refreshed: 0, errors: 0, error: message });
    }
  }

  return json({ shops: shops.length, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
