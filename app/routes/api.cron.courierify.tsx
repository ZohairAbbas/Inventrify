import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  syncCourierifyFulfilmentStatus,
  syncCourierifyReturns,
} from "../lib/courierify.server";

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
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const connected = await prisma.shopSettings.findMany({
    where: { courierifyApiKey: { not: null } },
    select: { shop: true, courierifyApiKey: true },
  });

  const results: {
    shop: string;
    fulfilment: number;
    fulfilmentError?: string;
    returns: number;
    returnsError?: string;
  }[] = [];

  for (const { shop, courierifyApiKey } of connected) {
    if (!courierifyApiKey) continue;
    const status = await syncCourierifyFulfilmentStatus(shop, courierifyApiKey);
    const returns = await syncCourierifyReturns(shop, courierifyApiKey);
    results.push({
      shop,
      fulfilment: status.synced,
      fulfilmentError: status.error,
      returns: returns.queued,
      returnsError: returns.error,
    });
  }

  return json({ shops: connected.length, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async ({ request: _request }: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
