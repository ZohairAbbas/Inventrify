import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { mintClaimTokenFromEnv } from "../lib/growzar/claim-token.server";
import { resolveClaimIdentity, type IdentityFailure } from "../lib/growzar/shopify-user.server";

/**
 * POST /api/growzar/claim-token — mints the "Open in Growzar" token (API-CONTRACT §10).
 *
 * Called by the button in Settings through App Bridge's fetch, which attaches the
 * session token as `Authorization: Bearer`. `authenticate.admin` verifies it; only then
 * is it exchanged with Shopify for the current user's identity, and only then is a token
 * minted. The merchant types and pastes nothing.
 *
 * The token goes back in the JSON body and is never logged.
 */
const FAILURE_MESSAGES: Record<IdentityFailure, string> = {
  exchange_failed: "Shopify did not confirm who you are. Reload the app and try again.",
  missing_user: "Shopify did not return your staff account. Reload the app and try again.",
  user_mismatch: "Your Shopify session changed. Reload the app and try again.",
  email_unverified: "Verify the email address on your Shopify account, then try again.",
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST." }, { status: 405 });
  }

  const { session, sessionToken } = await authenticate.admin(request);

  // authenticate.admin read and verified exactly this value (header first, then the
  // `id_token` param), so what we exchange is the verified token.
  const rawToken =
    request.headers.get("authorization")?.replace("Bearer ", "") ||
    new URL(request.url).searchParams.get("id_token");
  if (!sessionToken || !rawToken) {
    return Response.json(
      { error: "Open Inventorify from your Shopify admin to use this." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const identity = await resolveClaimIdentity({
    shop: session.shop,
    sessionToken: rawToken,
    expectedUserId: sessionToken.sub,
    apiKey: process.env.SHOPIFY_API_KEY || "",
    apiSecret: process.env.SHOPIFY_API_SECRET || "",
  });
  if (!identity.ok) {
    console.warn(`[growzar] claim token not minted for ${session.shop}: ${identity.reason}`);
    return Response.json(
      { error: FAILURE_MESSAGES[identity.reason] },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const minted = mintClaimTokenFromEnv(identity.identity);
  if (!minted) {
    console.error("[growzar] claim token requested but the Growzar integration is not configured");
    return Response.json(
      { error: "Growzar is not available yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json({ url: minted.url }, { headers: { "Cache-Control": "no-store" } });
};

export const loader = () => Response.json({ error: "Use POST." }, { status: 405 });
