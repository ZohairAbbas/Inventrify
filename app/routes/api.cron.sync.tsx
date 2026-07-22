import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { syncShopifyInventory } from "../lib/shopify-sync.server";
import { syncOrderHistory } from "../lib/order-sync.server";

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

  const shops = await prisma.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });

  const results: {
    shop: string;
    synced: number;
    archived: number;
    records: number;
    completed: boolean;
    error?: string;
  }[] = [];

  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);

      const inventory = await syncShopifyInventory(admin, shop);
      const orders = await syncOrderHistory(admin, shop);

      results.push({
        shop,
        synced: inventory.synced,
        archived: inventory.archived,
        records: orders.recordsSynced,
        // Either half failing makes the run partial; the caller should be able to see
        // that rather than reading the counts as a complete picture.
        completed: inventory.completed && orders.completed,
        error: inventory.error ?? orders.error,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      console.error(`[cron/sync] ${shop} failed:`, message);
      results.push({
        shop,
        synced: 0,
        archived: 0,
        records: 0,
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
