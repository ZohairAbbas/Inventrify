import prisma from "../db.server";
import {
  describeError,
  isAuthFailure,
  isShopUninstalled,
} from "./shopify-graphql.server";

/**
 * How long an offline token may sit un-refreshed before an auth failure against it is
 * read as an uninstall.
 *
 * Any successful Admin API call refreshes the stored expiry, so a shop that is alive and
 * syncing is never more than an hour or so past it. Requiring weeks of staleness means a
 * Shopify-side outage cannot masquerade as an uninstall: an outage would have to have
 * lasted the whole window to produce the same evidence.
 */
const DEAD_TOKEN_DAYS = 14;

/**
 * Shops a background job may work on.
 *
 * Only offline sessions qualify. The cron jobs used to enumerate `Session` outright, which
 * also picked up online (per-user) sessions — those cannot drive a background job, and a
 * shop with several staff logged in was processed once per user, doing the same full
 * catalogue sync two or three times over.
 *
 * Note this deliberately does NOT filter on `expires`. With `expiringOfflineAccessTokens`
 * the stored expiry runs ahead of the token the library actually refreshes on use, so
 * filtering by it would skip shops that are installed and syncing perfectly well. The
 * authoritative "this shop is gone" signal is Shopify rejecting the token — see
 * `standDownIfUninstalled`.
 */
export async function listSyncableShops(): Promise<string[]> {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    distinct: ["shop"],
    select: { shop: true },
  });
  return sessions.map((s) => s.shop);
}

/**
 * Stop working a shop whose token Shopify has rejected.
 *
 * `app/uninstalled` can be missed — a deploy, an endpoint blip, a delivery Shopify gave
 * up retrying — and when it is, the offline session survives and every cron run keeps
 * calling the Admin API for a shop that uninstalled weeks ago, failing every time. Deleting
 * the session removes it from `listSyncableShops` and ends the loop.
 *
 * This deletes the session only, never the shop's data. A 401 is strong evidence of an
 * uninstall but not proof of intent to erase, and purging on it would make a revoked or
 * mistakenly-reissued token destroy a live merchant's suppliers, POs and bin locations
 * irreversibly. Erasure stays with `APP_UNINSTALLED` / `SHOP_REDACT`, which are explicit.
 * If the app is in fact still installed, the next embedded load re-authorises and the
 * session comes back.
 *
 * Returns true when the shop was stood down, so callers can report it as skipped rather
 * than as a failure.
 */
export async function standDownIfUninstalled(
  shop: string,
  err: unknown,
): Promise<boolean> {
  if (!isAuthFailure(err)) return false;

  // A rejected token (401) or a session that has vanished is unambiguous. Any other
  // authentication failure — notably the 500 Shopify returns when refreshing an offline
  // token that has been dead for weeks — is only acted on once the stored expiry proves
  // the token has not worked in a long time. Without that corroboration a transient
  // Shopify outage would stand every shop down at once.
  if (!isShopUninstalled(err)) {
    const cutoff = new Date(Date.now() - DEAD_TOKEN_DAYS * 86400000);
    const usable = await prisma.session.count({
      where: {
        shop,
        isOnline: false,
        OR: [{ expires: null }, { expires: { gt: cutoff } }],
      },
    });
    if (usable > 0) return false;
  }

  await prisma.session.deleteMany({ where: { shop } });
  console.warn(
    `[inventorify] ${shop} rejected our token (${describeError(err)}); removing its ` +
      `session so background jobs stop running for it. Data is retained — if the app was ` +
      `uninstalled, APP_UNINSTALLED/SHOP_REDACT erases it.`,
  );
  return true;
}
