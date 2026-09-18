import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { unauthenticated } from "../shopify.server";
import { listSyncableShops, standDownIfUninstalled } from "../lib/active-shops.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { describeError } from "../lib/shopify-graphql.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";
import { recomputeReorderPoints } from "../lib/planning-job.server";
import {
  recomputeDerivedRto,
  recomputeFulfilmentFromOutcomes,
} from "../lib/rto-attribution.server";

/**
 * Scheduled reconciliation against Shopify.
 *
 * Webhooks keep stock and demand current in real time, but they can be missed — a
 * deploy, a failing endpoint, a delivery Shopify gave up retrying. Without a scheduled
 * pass the only reconciliation was a merchant manually pressing Re-sync, so drift could
 * persist indefinitely and every forecast downstream inherited it.
 *
 * Uses the stored offline session per shop, so no admin request context is needed.
 *
 * POST /api/cron/sync
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await listSyncableShops();

  const results: {
    shop: string;
    synced: number;
    archived: number;
    records: number;
    /** SalesRecord rows removed while rebuilding the reconciled days. */
    deleted: number;
    completed: boolean;
    error?: string;
    skipped?: string;
  }[] = [];

  for (const shop of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);

      const inventory = await syncShopifyInventory(admin, shop);

      // Both sync halves report a mid-run failure by returning it rather than throwing —
      // deliberately, so a partial catalogue walk cannot trigger the archive sweep. That
      // means a rejected token never reaches the catch below, so it has to be inspected
      // here too, before we spend another full order backfill on a shop that is gone.
      if (await standDownIfUninstalled(shop, inventory.error)) {
        results.push({
          shop,
          synced: inventory.synced,
          archived: 0,
          records: 0,
          deleted: 0,
          completed: false,
          skipped: "uninstalled",
        });
        continue;
      }

      const orders = await syncOrderHistory(admin, shop);
      if (await standDownIfUninstalled(shop, orders.error)) {
        results.push({
          shop,
          synced: inventory.synced,
          archived: inventory.archived,
          records: orders.recordsSynced,
          deleted: orders.recordsDeleted,
          completed: false,
          skipped: "uninstalled",
        });
        continue;
      }

      // Shopify's own carrier tracking now feeds the fulfilment pipeline and per-SKU
      // RTO, so both work with no courier integration at all. A courier feed refines
      // these later; it is not required for them to exist.
      await recomputeFulfilmentFromOutcomes(shop);
      await recomputeDerivedRto(shop);

      // The sync rewrites avgDailySales, so the reorder points derived from it must be
      // refreshed in the same breath or the two disagree until the nightly job runs.
      await recomputeReorderPoints(shop);

      results.push({
        shop,
        synced: inventory.synced,
        archived: inventory.archived,
        records: orders.recordsSynced,
        deleted: orders.recordsDeleted,
        // Either half failing makes the run partial; the caller should be able to see
        // that rather than reading the counts as a complete picture.
        completed: inventory.completed && orders.completed,
        error: inventory.error ?? orders.error,
      });
    } catch (err) {
      const message = describeError(err);

      // An uninstalled shop is not a failure to investigate: drop its session so it stops
      // being enumerated at all, and report it as skipped.
      if (await standDownIfUninstalled(shop, err)) {
        results.push({
          shop,
          synced: 0,
          archived: 0,
          records: 0,
          deleted: 0,
          completed: false,
          skipped: "uninstalled",
        });
        continue;
      }

      console.error(`[cron/sync] ${shop} failed:`, message);
      results.push({
        shop,
        synced: 0,
        archived: 0,
        records: 0,
        deleted: 0,
        completed: false,
        error: message,
      });
    }
  }

  return json({ shops: shops.length, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async (_args: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
