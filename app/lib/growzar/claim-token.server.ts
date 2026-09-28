import { createHmac, randomUUID } from "node:crypto";
import { APP_ISSUER, getGrowzarConfig, normaliseShopDomain } from "./config.server";

/**
 * The "Open in Growzar" claim token (API-CONTRACT §10, D-10).
 *
 * HS256 over GROWZAR_SIGNING_SECRET, `aud: "growzar"`, five-minute lifetime, a fresh
 * `jti` every time. Growzar enforces single use of the `jti`; we never reuse one.
 *
 * Minted only from a Shopify-verified identity (see claimIdentityFromSession in
 * app/routes/api.growzar.claim-token.tsx). The token is a bearer proof of shop
 * ownership: it is returned in a response body, carried to Growzar in a URL fragment,
 * and never logged or put in a query string.
 */
export const CLAIM_TOKEN_TTL_SECONDS = 300;

export type ClaimIdentity = {
  shop: string;
  /** Shopify user id, numeric. Emitted as a StaffMember GID. */
  userId: string;
  email: string;
  isStoreOwner: boolean;
  locale: string | null;
};

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function mintClaimToken(
  identity: ClaimIdentity,
  { secret, now = Date.now(), jti = randomUUID() }: { secret: string; now?: number; jti?: string },
): string {
  const shop = normaliseShopDomain(identity.shop);
  const email = identity.email.trim().toLowerCase();
  if (!shop) throw new Error("claim token: shop is not a *.myshopify.com domain");
  if (!email) throw new Error("claim token: email is required");
  if (!/^\d+$/.test(identity.userId)) throw new Error("claim token: userId must be numeric");

  const iat = Math.floor(now / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: APP_ISSUER,
    aud: "growzar",
    shop,
    shopifyUserId: `gid://shopify/StaffMember/${identity.userId}`,
    email,
    isStoreOwner: identity.isStoreOwner === true,
    ...(identity.locale ? { locale: identity.locale } : {}),
    jti,
    iat,
    exp: iat + CLAIM_TOKEN_TTL_SECONDS,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Where the browser goes: Growzar's /claim page with the token in the fragment, which
 * never reaches a server log. Growzar's page moves it into a POST.
 */
export function claimUrl(growzarUrl: string, token: string): string {
  return `${growzarUrl.replace(/\/+$/, "")}/claim#token=${encodeURIComponent(token)}`;
}

export function mintClaimTokenFromEnv(identity: ClaimIdentity): { token: string; url: string } | null {
  const config = getGrowzarConfig();
  if (!config) return null;
  const token = mintClaimToken(identity, { secret: config.signingSecret });
  return { token, url: claimUrl(config.url, token) };
}
