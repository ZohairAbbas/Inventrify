import { json } from "@remix-run/node";
import { getPartnerCredentials, normaliseShopDomain, type PlatformPartner } from "./config.server";
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
 *
 * Financify Books uses the same scheme with its own key, secret and X-Financify-*
 * headers (`partner: "financify"`). Each route names the one partner it admits, so a
 * key only ever opens its own partner's endpoints.
 */
export type PlatformRequest = { shop: string; partner: PlatformPartner };

/** §9 error shape. */
export function growzarError(status: number, errorType: string, error: string): Response {
  return json(
    { error, errorType },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function authenticatePlatformRequest(
  request: Request,
  {
    partner = "growzar",
    env = process.env,
    now,
  }: { partner?: PlatformPartner; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<{ ok: true; value: PlatformRequest } | { ok: false; response: Response }> {
  const config = getPartnerCredentials(partner, env);
  if (!config) {
    console.error(`[${partner}] platform credentials not set — refusing platform request`);
    return {
      ok: false,
      response: growzarError(503, "internal_error", "This integration is not configured."),
    };
  }
  const header = (name: string) => request.headers.get(`x-${config.headerPrefix.toLowerCase()}-${name}`);

  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!bearer || !safeEqual(bearer, config.platformKey)) {
    return { ok: false, response: growzarError(401, "unauthorized", "Invalid platform credential.") };
  }

  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
  const signature = verifySignature({
    secret: config.signingSecret,
    signature: header("signature"),
    timestamp: header("timestamp"),
    method: request.method,
    pathWithQuery: `${url.pathname}${url.search}`,
    body,
    now,
  });
  if (!signature.ok) {
    console.warn(`[${partner}] platform request refused: ${signature.reason}`);
    return { ok: false, response: growzarError(401, "unauthorized", "Invalid request signature.") };
  }

  const headerShopRaw = header("shop");
  const queryShopRaw = url.searchParams.get("shop");
  const headerShop = headerShopRaw === null ? null : normaliseShopDomain(headerShopRaw);
  const queryShop = queryShopRaw === null ? null : normaliseShopDomain(queryShopRaw);

  if ((headerShopRaw !== null && !headerShop) || (queryShopRaw !== null && !queryShop)) {
    return { ok: false, response: growzarError(400, "bad_request", "The shop must be a *.myshopify.com domain.") };
  }
  if (headerShop && queryShop && headerShop !== queryShop) {
    return { ok: false, response: growzarError(400, "bad_request", `X-${config.headerPrefix}-Shop and ?shop= disagree.`) };
  }
  const shop = headerShop ?? queryShop;
  if (!shop) {
    return { ok: false, response: growzarError(400, "bad_request", `X-${config.headerPrefix}-Shop is required.`) };
  }

  return { ok: true, value: { shop, partner } };
}
