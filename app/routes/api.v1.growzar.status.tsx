import { json, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { appVersion } from "../lib/growzar/config.server";
import { COST_WRITE_CAPABILITY, costWriteGranted } from "../lib/growzar/costs.server";
import { GROWZAR_CAPABILITIES } from "../lib/growzar/feed.server";
import { authenticatePlatformRequest, growzarError } from "../lib/growzar/platform-auth.server";

/**
 * GET /api/v1/growzar/status — API-CONTRACT §11, used by Growzar for auto-connect (D-03).
 *
 * `installed` means Inventorify holds an offline session for the shop: that is the row
 * the install creates and APP_UNINSTALLED / SHOP_REDACT delete (shop-purge.server), and
 * it is the same test the background jobs use (active-shops.server). Its `expires` is
 * deliberately not consulted, for the reason given in listSyncableShops.
 *
 * `capabilities` lists the read feeds this release serves (Phase 5, lib/growzar/feed.server).
 * Empty means Growzar shows a locked section with a preview. `costs:write` is added per
 * shop, only where Shopify confirms the shop granted the write scopes (costs.server).
 *
 * No CORS headers: this is server-to-server only.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = await authenticatePlatformRequest(request);
  if (!auth.ok) return auth.response;
  const { shop } = auth.value;

  try {
    const offlineSessions = await prisma.session.count({ where: { shop, isOnline: false } });
    const installed = offlineSessions > 0;
    const canWriteCosts = installed && (await costWriteGranted(shop));
    return json(
      {
        installed,
        appVersion: appVersion(),
        shop,
        capabilities: canWriteCosts ? [...GROWZAR_CAPABILITIES, COST_WRITE_CAPABILITY] : GROWZAR_CAPABILITIES,
        planRelevantFeatures: [] as string[],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("[growzar] status lookup failed:", err instanceof Error ? err.message : err);
    return growzarError(500, "internal_error", "Could not read install state.");
  }
};

export const action = async () =>
  growzarError(405, "bad_request", "Status is read with GET.");
