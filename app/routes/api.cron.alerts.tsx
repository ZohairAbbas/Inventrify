import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { generateAlerts } from "../lib/alerts.server";

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
  const results: { shop: string; alerts: number }[] = [];

  for (const { shop } of shops) {
    const count = await generateAlerts(shop);
    totalAlerts += count;
    results.push({ shop, alerts: count });
  }

  return json({ shops: shops.length, totalAlerts, results });
};

// GET: healthcheck — returns 200 so uptime monitors can ping it
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return json({ ok: true, ts: new Date().toISOString() });
};
