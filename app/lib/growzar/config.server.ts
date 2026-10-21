/**
 * Growzar platform credentials (API-CONTRACT §2.3, D-31).
 *
 *   GROWZAR_URL             Growzar's base URL, e.g. https://growzar.com
 *   GROWZAR_PLATFORM_KEY    the bearer key Growzar presents to us
 *   GROWZAR_SIGNING_SECRET  HMAC secret for both directions, and the claim-token key
 *
 * One set per environment, read from the environment at call time. Anything missing
 * means the integration is off, and every caller refuses rather than falling open.
 *
 * start.sh sources .env, but pm2 also keeps its own saved environment: after changing
 * any of these run `pm2 delete inventorify && pm2 start ecosystem.config.cjs --only
 * inventorify && pm2 save`, not `pm2 restart`.
 */
export const APP_ISSUER = "inventorify";

export type GrowzarConfig = {
  url: string;
  platformKey: string;
  signingSecret: string;
};

export function getGrowzarConfig(env: NodeJS.ProcessEnv = process.env): GrowzarConfig | null {
  const url = env.GROWZAR_URL?.trim();
  const platformKey = env.GROWZAR_PLATFORM_KEY?.trim();
  const signingSecret = env.GROWZAR_SIGNING_SECRET?.trim();
  if (!url || !platformKey || !signingSecret) return null;
  return { url: url.replace(/\/+$/, ""), platformKey, signingSecret };
}

/**
 * The version reported by /api/v1/growzar/status. package.json carries none, so this is
 * set per deploy (e.g. the deployed commit) through APP_VERSION.
 */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.APP_VERSION?.trim() || "unversioned";
}

/** §3: a shop is its *.myshopify.com domain, lowercase. */
export function normaliseShopDomain(value: string | null | undefined): string | null {
  const shop = (value ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}

/**
 * Credentials a read-feed partner presents to us: the bearer key and the HMAC secret
 * its requests are signed with. `headerPrefix` names its headers — `X-<Prefix>-Shop`,
 * `-Timestamp` and `-Signature` — so one partner's signed request can never be replayed
 * as another's.
 */
export type PlatformPartner = "growzar" | "financify";

export type PartnerCredentials = {
  partner: PlatformPartner;
  platformKey: string;
  signingSecret: string;
  headerPrefix: string;
};

/**
 * Financify Books' credentials for its read feeds (/api/v1/financify/*):
 *
 *   FINANCIFY_PLATFORM_KEY    the bearer key Financify presents to us
 *   FINANCIFY_SIGNING_SECRET  HMAC secret its requests are signed with
 *
 * Separate from Growzar's on purpose: the Growzar key reads every Growzar feed for every
 * shop, and Financify is limited to the feeds served under its own prefix. The same pm2
 * caveat as above applies after changing them. Either missing turns the feeds off.
 */
export function getPartnerCredentials(
  partner: PlatformPartner,
  env: NodeJS.ProcessEnv = process.env,
): PartnerCredentials | null {
  if (partner === "growzar") {
    const config = getGrowzarConfig(env);
    return config
      ? { partner, platformKey: config.platformKey, signingSecret: config.signingSecret, headerPrefix: "Growzar" }
      : null;
  }
  const platformKey = env.FINANCIFY_PLATFORM_KEY?.trim();
  const signingSecret = env.FINANCIFY_SIGNING_SECRET?.trim();
  if (!platformKey || !signingSecret) return null;
  return { partner, platformKey, signingSecret, headerPrefix: "Financify" };
}
