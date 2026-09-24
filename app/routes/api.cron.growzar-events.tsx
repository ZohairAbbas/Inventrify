import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { isAuthorisedCronRequest } from "../lib/cron-auth.server";
import { deliverDueEvents } from "../lib/growzar/events.server";

/**
 * Retries events to Growzar that are due (API-CONTRACT §7). The cron worker calls this
 * every minute; with an empty outbox it reads one directory and returns.
 *
 * POST /api/cron/growzar-events
 * Header: x-cron-secret: <CRON_SECRET env var>
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthorisedCronRequest(request)) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  return json(await deliverDueEvents());
};
