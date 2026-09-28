import { getGrowzarConfig, normaliseShopDomain, type GrowzarConfig } from "./config.server";
import { safeEqual, verifySignature } from "./signing.server";

/**
 * Authenticate a request from Growzar (API-CONTRACT §2.1).
 *
 * The bearer key alone is never enough: the request must also carry a valid
 * X-Growzar-Signature over its exact method, path+query and raw body. This is the single
 * gate for every Growzar → Inventorify endpoint — the status endpoint now, and the R2
 * read API later — so there is one key model and one signature scheme, not two.
 *
 * The tenant is X-Growzar-Shop (and/or `?shop=`, which Growzar also sends and which the
 * signature covers). When both are present they must agree.
 */
export type PlatformRequest = { shop: string; config: GrowzarConfig };

/** §9 error shape. */
export function growzarError(status: number, errorType: string, error: string): Response {
  return Response.json(
    { error, errorType },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function authenticatePlatformRequest(
  request: Request,
  { env = process.env, now }: { env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<{ ok: true; value: PlatformRequest } | { ok: false; response: Response }> {
  const config = getGrowzarConfig(env);
  if (!config) {
    console.error("[growzar] GROWZAR_URL / GROWZAR_PLATFORM_KEY / GROWZAR_SIGNING_SECRET not set — refusing platform request");
    return {
      ok: false,
      response: growzarError(503, "internal_error", "The Growzar integration is not configured."),
    };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!bearer || !safeEqual(bearer, config.platformKey)) {
    return { ok: false, response: growzarError(401, "unauthorized", "Invalid platform credential.") };
  }

  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const signature = verifySignature({
    secret: config.signingSecret,
    signature: request.headers.get("x-growzar-signature"),
    timestamp: request.headers.get("x-growzar-timestamp"),
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    body,
    now,
  });
  if (!signature.ok) {
    console.warn(`[growzar] platform request refused: ${signature.reason}`);
    return { ok: false, response: growzarError(401, "unauthorized", "Invalid request signature.") };
  }

  const headerShopRaw = request.headers.get("x-growzar-shop");
  const queryShopRaw = url.searchParams.get("shop");
  const headerShop = headerShopRaw === null ? null : normaliseShopDomain(headerShopRaw);
  const queryShop = queryShopRaw === null ? null : normaliseShopDomain(queryShopRaw);

  if ((headerShopRaw !== null && !headerShop) || (queryShopRaw !== null && !queryShop)) {
    return { ok: false, response: growzarError(400, "bad_request", "The shop must be a *.myshopify.com domain.") };
  }
  if (headerShop && queryShop && headerShop !== queryShop) {
    return { ok: false, response: growzarError(400, "bad_request", "X-Growzar-Shop and ?shop= disagree.") };
  }
  const shop = headerShop ?? queryShop;
  if (!shop) {
    return { ok: false, response: growzarError(400, "bad_request", "X-Growzar-Shop is required.") };
  }

  return { ok: true, value: { shop, config } };
}
