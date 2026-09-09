import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { listSyncableShops } from "../lib/active-shops.server";
import {
  generateAlerts,
  getDispatchableAlerts,
  markAlertsNotified,
} from "../lib/alerts.server";
import { dispatchAlerts } from "../lib/alert-dispatch.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { describeError } from "../lib/shopify-graphql.server";

/**
 * Cron endpoint — protected by CRON_SECRET header.
 * Call this daily from your scheduler.
 *
 * POST /api/cron/alerts
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // Installed shops only — an uninstalled one has had its session removed, which also
  // stops us emailing a merchant who has left.
  const shops = await listSyncableShops();

  let totalAlerts = 0;
  let totalSent = 0;
  const results: {
    shop: string;
    total: number;
    opened: number;
    resolved: number;
    sent: number;
    failed: number;
    error?: string;
  }[] = [];

  for (const shop of shops) {
    try {
      const { total, opened, resolved } = await generateAlerts(shop);
      totalAlerts += total;

      // Only push what is actually worth pushing: unresolved, unsnoozed, and outside
      // the notification cooldown. Previously every unread alert was re-sent on every
      // run, so a standing condition mailed the merchant daily until they muted us.
      const dispatchable = await getDispatchableAlerts(shop);
      const { sent, failed, deliveredIds } = await dispatchAlerts(shop, dispatchable);

      // Only alerts a channel actually accepted start the cooldown. Marking on a failed
      // send would silence a condition the merchant was never told about.
      await markAlertsNotified(deliveredIds);
      totalSent += sent;

      results.push({ shop, total, opened, resolved, sent, failed });
    } catch (err) {
      // One bad shop must not abort the whole run.
      const message = describeError(err);
      console.error(`[cron/alerts] ${shop} failed:`, message);
      results.push({ shop, total: 0, opened: 0, resolved: 0, sent: 0, failed: 0, error: message });
    }
  }

  return json({ shops: shops.length, totalAlerts, totalSent, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
