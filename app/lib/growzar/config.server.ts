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
