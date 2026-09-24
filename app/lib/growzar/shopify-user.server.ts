import type { ClaimIdentity } from "./claim-token.server";

/**
 * Who is pressing "Open in Growzar", as Shopify says — never as the browser says.
 *
 * Inventorify runs on offline sessions only (no `useOnlineTokens`), so the verified
 * session carries no user, and the App Bridge session token carries only the user id
 * (`sub`), not email or ownership. The one Shopify-signed source of all three is an
 * online-token exchange of that same session token: Shopify answers with
 * `associated_user { id, email, email_verified, account_owner, locale }`.
 *
 * The session token is exchanged only after `authenticate.admin` has verified it
 * (signature, audience, expiry, shop). The online access token that comes back is not
 * stored, logged or used for anything; it is dropped as soon as the user is read.
 */
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const ONLINE_TOKEN_TYPE = "urn:shopify:params:oauth:token-type:online-access-token";

type AssociatedUser = {
  id?: number | string;
  email?: string;
  email_verified?: boolean;
  account_owner?: boolean;
  locale?: string;
};

export type IdentityFailure =
  | "exchange_failed"
  | "user_mismatch"
  | "email_unverified"
  | "missing_user";

export async function resolveClaimIdentity(options: {
  shop: string;
  /** The raw App Bridge session token, already verified by authenticate.admin. */
  sessionToken: string;
  /** `sub` from the verified session-token payload. */
  expectedUserId: string | undefined;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: true; identity: ClaimIdentity } | { ok: false; reason: IdentityFailure }> {
  const doFetch = options.fetchImpl ?? fetch;

  let user: AssociatedUser | undefined;
  try {
    const response = await doFetch(`https://${options.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: options.apiKey,
        client_secret: options.apiSecret,
        grant_type: TOKEN_EXCHANGE_GRANT,
        subject_token: options.sessionToken,
        subject_token_type: ID_TOKEN_TYPE,
        requested_token_type: ONLINE_TOKEN_TYPE,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.warn(`[growzar] online token exchange for ${options.shop} returned ${response.status}`);
      return { ok: false, reason: "exchange_failed" };
    }
    const body = (await response.json()) as { associated_user?: AssociatedUser };
    user = body.associated_user;
  } catch (err) {
    console.warn(
      `[growzar] online token exchange for ${options.shop} failed: ${err instanceof Error ? err.name : "unknown"}`,
    );
    return { ok: false, reason: "exchange_failed" };
  }

  const userId = user?.id === undefined || user?.id === null ? "" : String(user.id);
  if (!user || !/^\d+$/.test(userId) || !user.email) return { ok: false, reason: "missing_user" };

  // The exchanged user must be the one whose session token we verified.
  if (!options.expectedUserId || String(options.expectedUserId) !== userId) {
    return { ok: false, reason: "user_mismatch" };
  }

  // Growzar signs the person in by this email. An unverified address on a Shopify staff
  // account could belong to someone else entirely, so it is never passed on.
  if (user.email_verified !== true) return { ok: false, reason: "email_unverified" };

  return {
    ok: true,
    identity: {
      shop: options.shop,
      userId,
      email: user.email,
      isStoreOwner: user.account_owner === true,
      locale: user.locale ?? null,
    },
  };
}
