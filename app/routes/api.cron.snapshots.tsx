import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { listSyncableShops } from "../lib/active-shops.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { describeError } from "../lib/shopify-graphql.server";
import { writeDailySnapshots } from "../lib/stock-snapshot.server";

/**
 * Hourly daily-stock-snapshot sweep — no Shopify calls, so it needs no admin session.
 * See writeDailySnapshots: only the first run of each shop-local day writes anything.
 *
 * POST /api/cron/snapshots
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await listSyncableShops();
  const results: { shop: string; date?: string; written: number; variants: number; error?: string }[] = [];

  for (const shop of shops) {
    try {
      results.push({ shop, ...(await writeDailySnapshots(shop)) });
    } catch (err) {
      // One failing shop must not abort the sweep.
      const message = describeError(err);
      console.error(`[cron/snapshots] ${shop} failed:`, message);
      results.push({ shop, written: 0, variants: 0, error: message });
    }
  }

  return json({ shops: shops.length, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
