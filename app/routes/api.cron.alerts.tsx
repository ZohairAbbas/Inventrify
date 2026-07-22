import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { generateAlerts, getAllUnreadAlerts } from "../lib/alerts.server";
import { dispatchAlerts } from "../lib/alert-dispatch.server";

/**
 * Cron endpoint — protected by CRON_SECRET header.
 * Call this daily from your scheduler (Railway, Heroku Scheduler, GitHub Actions cron, etc.)
 *
 * POST /api/cron/alerts
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const secret = request.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get all distinct shops with active sessions
  const shops = await prisma.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });

  let totalAlerts = 0;
  let totalSent = 0;
  const results: {
    shop: string;
    alerts: number;
    sent: number;
    suppressed: number;
    cleared: number;
  }[] = [];

  for (const { shop } of shops) {
    const count = await generateAlerts(shop);
    totalAlerts += count;

    // Dispatch runs even when there are no active alerts: it reconciles the notification
    // ledger, so conditions that have cleared will notify again if they recur.
    const active = await getAllUnreadAlerts(shop);
    const { sent, suppressed, cleared } = await dispatchAlerts(shop, active);
    totalSent += sent;

    results.push({ shop, alerts: count, sent, suppressed, cleared });
  }

  return json({ shops: shops.length, totalAlerts, totalSent, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
