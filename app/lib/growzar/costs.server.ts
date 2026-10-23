import { json } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../../db.server";
import {
  describeError,
  graphqlWithRetry,
  isAuthFailure,
  isMissingScope,
  mapPool,
} from "../shopify-graphql.server";
import { minorUnits, numericId } from "./feed.server";
import { authenticatePlatformRequest, growzarError } from "./platform-auth.server";
import { platformLimiter, type RateLimiter } from "./rate-limit.server";

/**
 * Growzar's Books setting Shopify's "Cost per item" (D-77, pack G-INV-C1).
 *
 * Growzar holds no Shopify write access, so its Books offers each variant's average cost
 * through Inventorify, always in two steps:
 *
 *   POST /api/v1/growzar/costs/preview  — reads Shopify, changes nothing, stores what the
 *                                         user saw and returns a previewId;
 *   POST /api/v1/growzar/costs/confirm  — carries that previewId and an Idempotency-Key,
 *                                         writes the "set" items and Product.unitCost.
 *
 * A preview can be confirmed once, by the user who made it (X-Growzar-User), within
 * COST_PREVIEW_TTL_MS. Before writing, the confirm reads Shopify again and refuses an
 * item whose cost changed since the preview: the user agreed to replace that old value,
 * not whatever is there now.
 *
 * Shopify applies a cost to orders from now on, so nothing past is rewritten.
 */

export const COST_PREVIEW_TTL_MS = 15 * 60_000;
export const MAX_COST_ITEMS = 250;
/** The scopes a write needs; /growzar/status lists `costs:write` only where both are granted. */
export const COST_WRITE_SCOPES = ["write_products", "write_inventory"];
export const COST_WRITE_CAPABILITY = "costs:write";

const SCOPE_CACHE_MS = 60 * 60_000;
/** A shop Shopify could not be asked about is retried sooner than a known answer. */
const SCOPE_FAILURE_CACHE_MS = 5 * 60_000;
/** inventoryItemUpdate takes one item, so a confirm is one mutation per item. */
const WRITE_CONCURRENCY = 4;
/** Variants per `nodes` lookup, well inside Shopify's 1000-point query cost. */
const LOOKUP_CHUNK = 50;
const MAX_HEADER_LENGTH = 200;

export type Money = { amount: string; currency: string };
type Admin = AdminApiContext;
export type AdminFor = (shop: string) => Promise<Admin>;

/** Per-item reasons, as codes Growzar can map to its own wording. */
export type CostReason =
  | "not_found" // the variant isn't the shop's (or no longer exists)
  | "currency_mismatch" // the cost isn't in the shop's currency
  | "negative_amount"
  | "too_many_decimals" // more than the currency's minor units
  | "invalid_amount" // not a decimal string
  | "archived" // the product is archived in Shopify, or the variant is gone from it
  | "changed_since_preview" // confirm only: Shopify's cost is no longer the previewed one
  | "shopify_rejected" // confirm only: Shopify returned a userError (see `message`)
  | "throttled" // confirm only: still throttled after retrying with backoff
  | "shop_not_connected" // confirm only: the shop's token stopped working mid-run
  | "shopify_error"; // confirm only: any other Shopify failure

export type PreviewItem = {
  variantId: string;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  current: Money | null;
  proposed: Money | null;
  change: "set" | "same" | "refused";
  reason?: CostReason;
};

/** What the preview row stores per item: the response plus what the confirm needs. */
type StoredItem = PreviewItem & { inventoryItemId: string | null };

export type ConfirmItem = {
  variantId: string;
  result: "set" | "failed";
  reason?: CostReason;
  message?: string;
};

// ---------------------------------------------------------------------------------------
// Admin client and scopes

const defaultAdminFor: AdminFor = async (shop) => {
  // Imported here so the modules that only validate can be loaded without the Shopify app.
  const { unauthenticated } = await import("../../shopify.server");
  return (await unauthenticated.admin(shop)).admin;
};

const SCOPES_QUERY = `#graphql
  query CostWriteScopes { currentAppInstallation { accessScopes { handle } } }
`;

const scopeCache = new Map<string, { granted: boolean; until: number }>();

/**
 * Whether the shop has granted the scopes a cost write needs, asked of Shopify itself.
 * Session.scope is not used: the auth library never refreshes it, so it goes stale when a
 * merchant approves new scopes. Cached for an hour, as /growzar/status is polled.
 */
export async function costWriteGranted(
  shop: string,
  { adminFor = defaultAdminFor, now = Date.now() }: { adminFor?: AdminFor; now?: number } = {},
): Promise<boolean> {
  const cached = scopeCache.get(shop);
  if (cached && cached.until > now) return cached.granted;
  try {
    const admin = await adminFor(shop);
    const data = await graphqlWithRetry<{
      currentAppInstallation: { accessScopes: { handle: string }[] };
    }>(admin, SCOPES_QUERY, {}, 2);
    const handles = new Set(data.currentAppInstallation.accessScopes.map((s) => s.handle));
    const granted = COST_WRITE_SCOPES.every((h) => handles.has(h));
    scopeCache.set(shop, { granted, until: now + SCOPE_CACHE_MS });
    return granted;
  } catch (err) {
    console.warn(`[growzar] cost scope check failed for ${shop}:`, describeError(err));
    scopeCache.set(shop, { granted: false, until: now + SCOPE_FAILURE_CACHE_MS });
    return false;
  }
}

export function forgetCostWriteScopes(shop?: string) {
  if (shop) scopeCache.delete(shop);
  else scopeCache.clear();
}

// ---------------------------------------------------------------------------------------
// Amounts

/** Amount as an integer count of minor units, for comparing two decimal strings. */
function minorAmount(amount: string, currency: string): number {
  return Math.round(Number.parseFloat(amount) * 10 ** minorUnits(currency));
}

/** Shopify's Decimal (e.g. "1250.0") as a §4 amount with the currency's minor units. */
function shopifyMoney(amount: string | null | undefined, currency: string): Money | null {
  if (amount == null) return null;
  const parsed = Number.parseFloat(amount);
  if (!Number.isFinite(parsed)) return null;
  return { amount: parsed.toFixed(minorUnits(currency)), currency };
}

/**
 * Check a proposed cost against the shop's currency. Returns the amount written with the
 * currency's minor units ("1250" → "1250.00"), or the reason it is refused. Trailing
 * zeros don't count as decimals: "12.500" is 12.50.
 */
export function checkCost(
  cost: { amount: string; currency: string },
  shopCurrency: string,
): { ok: true; money: Money } | { ok: false; reason: CostReason } {
  if (cost.currency !== shopCurrency) return { ok: false, reason: "currency_mismatch" };
  const match = /^(-)?(\d{1,13})(?:\.(\d+))?$/.exec(cost.amount.trim());
  if (!match) return { ok: false, reason: "invalid_amount" };
  const [, minus, whole, fraction = ""] = match;
  if (minus) return { ok: false, reason: "negative_amount" };
  const digits = minorUnits(shopCurrency);
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > digits) return { ok: false, reason: "too_many_decimals" };
  const amount = digits > 0
    ? `${BigInt(whole).toString()}.${significant.padEnd(digits, "0")}`
    : BigInt(whole).toString();
  return { ok: true, money: { amount, currency: shopCurrency } };
}

// ---------------------------------------------------------------------------------------
// Request handling

type RequestedItem = { variantId: string; cost: { amount: string; currency: string } };

/** The preview body's shape. Shape errors are 400s; a bad amount is a per-item refusal. */
export function parsePreviewBody(raw: string): { ok: true; items: RequestedItem[] } | { ok: false; error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "The body must be JSON." };
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, error: "items must be a non-empty array." };
  }
  if (items.length > MAX_COST_ITEMS) {
    return { ok: false, error: `At most ${MAX_COST_ITEMS} items per preview.` };
  }
  const seen = new Set<string>();
  const parsed: RequestedItem[] = [];
  for (const [i, item] of items.entries()) {
    const variantId = typeof item?.variantId === "string" ? numericId(item.variantId) : null;
    if (!variantId) return { ok: false, error: `items[${i}].variantId must be a Shopify variant id as a string.` };
    const cost = item.cost;
    if (typeof cost?.amount !== "string" || typeof cost?.currency !== "string") {
      return { ok: false, error: `items[${i}].cost must be { amount, currency } with string values.` };
    }
    if (seen.has(variantId)) return { ok: false, error: `Variant ${variantId} is listed more than once.` };
    seen.add(variantId);
    parsed.push({ variantId, cost: { amount: cost.amount, currency: cost.currency } });
  }
  return { ok: true, items: parsed };
}

export type WriteRequest = { shop: string; actor: string; body: string };

/**
 * The gate for both cost endpoints: Growzar's signed platform request (the same check as
 * the feeds), the platform rate limit, the acting user, and the install check. Growzar
 * only — Financify's key never opens a write.
 */
export async function openCostWrite(
  request: Request,
  { limiter = platformLimiter, env, now }: { limiter?: RateLimiter; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<{ ok: true; value: WriteRequest } | { ok: false; response: Response }> {
  if (request.method !== "POST") {
    return { ok: false, response: growzarError(405, "bad_request", "Use POST.") };
  }
  // The signature check reads the body, so keep a copy for the handler.
  const body = await request.clone().text();
  const auth = await authenticatePlatformRequest(request, { partner: "growzar", env, now });
  if (!auth.ok) return auth;
  const { shop } = auth.value;

  let admitted: ReturnType<RateLimiter["take"]>;
  try {
    admitted = limiter.take(now);
  } catch (err) {
    console.error("[growzar] rate limiter failed:", err instanceof Error ? err.message : err);
    return { ok: false, response: growzarError(503, "not_configured", "Rate limiter unavailable; retry shortly.") };
  }
  if (!admitted.ok) {
    const response = growzarError(429, "rate_limited", "Too many requests on the platform key.");
    response.headers.set("Retry-After", String(admitted.retryAfterSeconds));
    return { ok: false, response };
  }

  const actor = request.headers.get("x-growzar-user")?.trim() ?? "";
  if (!actor || actor.length > MAX_HEADER_LENGTH) {
    return { ok: false, response: growzarError(400, "bad_request", "X-Growzar-User is required.") };
  }

  try {
    const sessions = await prisma.session.count({ where: { shop, isOnline: false } });
    if (sessions === 0) {
      return { ok: false, response: growzarError(410, "shop_not_connected", "Inventorify is not installed on this shop.") };
    }
  } catch (err) {
    console.error("[growzar] cost write setup failed:", err instanceof Error ? err.message : err);
    return { ok: false, response: growzarError(500, "internal_error", "Could not read the shop.") };
  }
  return { ok: true, value: { shop, actor, body } };
}

/** A Shopify failure before anything was written, as the error response for it. */
function shopifyFailure(shop: string, err: unknown): Response {
  console.error(`[growzar] Shopify unreachable for ${shop}:`, describeError(err));
  if (isAuthFailure(err)) {
    return growzarError(410, "shop_not_connected", "Inventorify can no longer reach this shop; it must reopen the app.");
  }
  return growzarError(502, "shopify_error", "Shopify could not be reached; nothing was changed. Retry shortly.");
}

// ---------------------------------------------------------------------------------------
// Shopify reads and writes

type LiveVariant = {
  id: string;
  title: string | null;
  sku: string | null;
  product: { title: string; status: string } | null;
  inventoryItem: { id: string; unitCost: { amount: string } | null } | null;
};

const VARIANTS_QUERY = `#graphql
  query CostVariants($ids: [ID!]!) {
    shop { currencyCode }
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        sku
        product { title status }
        inventoryItem { id unitCost { amount } }
      }
    }
  }
`;

const variantGid = (id: string) => `gid://shopify/ProductVariant/${id}`;

/** Live variants by numeric id; null where Shopify has none for this shop. */
async function lookupVariants(admin: Admin, ids: string[]): Promise<{ currency: string; byId: Map<string, LiveVariant | null> }> {
  const byId = new Map<string, LiveVariant | null>();
  let currency = "";
  for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
    const chunk = ids.slice(i, i + LOOKUP_CHUNK);
    const data = await graphqlWithRetry<{ shop: { currencyCode: string }; nodes: (LiveVariant | null)[] }>(
      admin,
      VARIANTS_QUERY,
      { ids: chunk.map(variantGid) },
    );
    currency = data.shop.currencyCode;
    chunk.forEach((id, n) => {
      const node = data.nodes[n];
      // A node of another type, or of another shop, comes back null or without an id.
      byId.set(id, node && node.id === variantGid(id) ? node : null);
    });
  }
  return { currency, byId };
}

const SET_COST_MUTATION = `#graphql
  mutation CostSet($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id }
      userErrors { field message }
    }
  }
`;

// ---------------------------------------------------------------------------------------
// Preview

const publicItem = ({ inventoryItemId: _drop, ...item }: StoredItem): PreviewItem => item;

export async function previewCosts(
  { shop, actor, items }: { shop: string; actor: string; items: RequestedItem[] },
  { adminFor = defaultAdminFor, now = Date.now() }: { adminFor?: AdminFor; now?: number } = {},
): Promise<Response> {
  if (!(await costWriteGranted(shop, { adminFor, now }))) {
    return growzarError(
      403,
      "forbidden",
      "This shop has not granted Inventorify the scopes to write costs, or Shopify could not confirm them.",
    );
  }

  let live: Awaited<ReturnType<typeof lookupVariants>>;
  try {
    live = await lookupVariants(await adminFor(shop), items.map((i) => i.variantId));
  } catch (err) {
    return shopifyFailure(shop, err);
  }
  const { currency } = live;

  const archivedLocally = new Set(
    (
      await prisma.product.findMany({
        where: { shop, id: { in: items.map((i) => variantGid(i.variantId)) }, isArchived: true },
        select: { id: true },
      })
    ).map((p) => p.id),
  );

  const stored: StoredItem[] = items.map(({ variantId, cost }) => {
    const variant = live.byId.get(variantId) ?? null;
    const current = shopifyMoney(variant?.inventoryItem?.unitCost?.amount, currency);
    const checked = checkCost(cost, currency);
    const base = {
      variantId,
      title: variant?.product?.title ?? null,
      variantTitle: variant?.title ?? null,
      sku: variant?.sku || null,
      current,
      proposed: checked.ok ? checked.money : { amount: cost.amount, currency: cost.currency },
      inventoryItemId: variant?.inventoryItem?.id ?? null,
    };
    const refuse = (reason: CostReason): StoredItem => ({ ...base, change: "refused", reason });

    if (!variant || !variant.inventoryItem) return refuse("not_found");
    if (!checked.ok) return refuse(checked.reason);
    if (variant.product?.status === "ARCHIVED" || archivedLocally.has(variant.id)) return refuse("archived");
    const same = current !== null && minorAmount(current.amount, currency) === minorAmount(checked.money.amount, currency);
    return { ...base, change: same ? "same" : "set" };
  });

  const expiresAt = new Date(now + COST_PREVIEW_TTL_MS);
  const preview = await prisma.growzarCostPreview.create({
    data: { shop, actor, currency, items: stored as unknown as Prisma.InputJsonValue, expiresAt },
    select: { id: true },
  });

  return json(
    {
      shop,
      previewId: preview.id,
      expiresAt: expiresAt.toISOString(),
      currency,
      items: stored.map(publicItem),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

// ---------------------------------------------------------------------------------------
// Confirm

function storedJson(status: number, body: unknown, replayed: boolean): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (replayed) headers["Idempotency-Replayed"] = "true";
  return json(body, { status, headers });
}

/** Why a confirm cannot claim its preview, or null when it can. */
async function claimPreview(
  { shop, actor, previewId, idempotencyKey, now }: { shop: string; actor: string; previewId: string; idempotencyKey: string; now: number },
): Promise<Response | null> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.growzarCostConfirm.create({ data: { shop, idempotencyKey, previewId, actor } });
      const claimed = await tx.growzarCostPreview.updateMany({
        where: { id: previewId, shop, confirmedAt: null, expiresAt: { gt: new Date(now) } },
        data: { confirmedAt: new Date(now) },
      });
      if (claimed.count !== 1) throw new PreviewTaken();
    });
    return null;
  } catch (err) {
    if (err instanceof PreviewTaken) {
      return growzarError(409, "preview_already_confirmed", "This preview has already been confirmed. Preview again.");
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return growzarError(409, "idempotency_key_conflict", "A confirm with this Idempotency-Key is still running.");
    }
    throw err;
  }
}

class PreviewTaken extends Error {}

/** Undo a claim when Shopify failed before anything was written, so the user can retry. */
async function releaseClaim(shop: string, previewId: string, idempotencyKey: string) {
  await prisma.$transaction([
    prisma.growzarCostConfirm.deleteMany({ where: { shop, idempotencyKey } }),
    prisma.growzarCostPreview.updateMany({ where: { id: previewId, shop }, data: { confirmedAt: null } }),
  ]);
}

export async function confirmCosts(
  { shop, actor, previewId, idempotencyKey }: { shop: string; actor: string; previewId: string; idempotencyKey: string },
  { adminFor = defaultAdminFor, now = Date.now() }: { adminFor?: AdminFor; now?: number } = {},
): Promise<Response> {
  // §8: a replay returns the stored reply; the same key for another preview is a conflict.
  const prior = await prisma.growzarCostConfirm.findUnique({
    where: { shop_idempotencyKey: { shop, idempotencyKey } },
  });
  if (prior) {
    if (prior.previewId !== previewId) {
      return growzarError(409, "idempotency_key_conflict", "This Idempotency-Key was used for another preview.");
    }
    if (prior.responseStatus === null) {
      return growzarError(409, "idempotency_key_conflict", "A confirm with this Idempotency-Key is still running.");
    }
    return storedJson(prior.responseStatus, prior.response, true);
  }

  const preview = await prisma.growzarCostPreview.findFirst({ where: { id: previewId, shop } });
  if (!preview) return growzarError(404, "not_found", "No such preview for this shop. Preview first.");
  if (preview.actor !== actor) {
    return growzarError(403, "forbidden", "Only the user who made the preview can confirm it.");
  }
  if (preview.confirmedAt) {
    return growzarError(409, "preview_already_confirmed", "This preview has already been confirmed. Preview again.");
  }
  if (preview.expiresAt.getTime() <= now) {
    return growzarError(422, "preview_expired", "This preview has expired. Preview again.");
  }

  let admin: Admin;
  try {
    admin = await adminFor(shop);
  } catch (err) {
    return shopifyFailure(shop, err);
  }

  const taken = await claimPreview({ shop, actor, previewId, idempotencyKey, now });
  if (taken) return taken;

  try {
    return await writeCosts({ shop, actor, previewId, idempotencyKey, admin, preview });
  } catch (err) {
    // Something past the claim failed outright. Store it, so a replay answers the same
    // and never writes again; the write log holds whatever was set before it.
    console.error(`[growzar] cost confirm failed for ${shop}:`, describeError(err));
    const body = { error: "The confirm failed part-way; see Inventorify's log before retrying.", errorType: "internal_error" };
    await prisma.growzarCostConfirm.update({
      where: { shop_idempotencyKey: { shop, idempotencyKey } },
      data: { responseStatus: 500, response: body, completedAt: new Date() },
    });
    return storedJson(500, body, false);
  }
}

async function writeCosts({
  shop,
  actor,
  previewId,
  idempotencyKey,
  admin,
  preview,
}: {
  shop: string;
  actor: string;
  previewId: string;
  idempotencyKey: string;
  admin: Admin;
  preview: { items: Prisma.JsonValue; currency: string };
}): Promise<Response> {
  const toSet = (preview.items as unknown as StoredItem[]).filter((i) => i.change === "set");
  const currency = preview.currency;

  // Read Shopify again: the user agreed to replace the cost they saw, nothing else.
  let live: Awaited<ReturnType<typeof lookupVariants>>;
  try {
    live = await lookupVariants(admin, toSet.map((i) => i.variantId));
  } catch (err) {
    await releaseClaim(shop, previewId, idempotencyKey);
    return shopifyFailure(shop, err);
  }

  const log = { shop, previewId, idempotencyKey, actor, currency };
  const results = await mapPool(toSet, WRITE_CONCURRENCY, async (item): Promise<ConfirmItem> => {
    const proposed = item.proposed as Money;
    const fail = async (reason: CostReason, message?: string): Promise<ConfirmItem> => {
      await prisma.growzarCostWrite.create({
        data: {
          ...log,
          variantId: variantGid(item.variantId),
          inventoryItemId: item.inventoryItemId ?? "",
          oldAmount: item.current?.amount ?? null,
          newAmount: proposed.amount,
          result: "failed",
          reason: message ? `${reason}: ${message}` : reason,
        },
      });
      return { variantId: item.variantId, result: "failed", reason, ...(message ? { message } : {}) };
    };

    const variant = live.byId.get(item.variantId) ?? null;
    if (!variant?.inventoryItem) return fail("not_found");
    if (live.currency !== currency) return fail("currency_mismatch");
    if (variant.product?.status === "ARCHIVED") return fail("archived");
    const nowCost = shopifyMoney(variant.inventoryItem.unitCost?.amount, currency);
    const unchanged =
      (nowCost === null && item.current === null) ||
      (nowCost !== null && item.current !== null &&
        minorAmount(nowCost.amount, currency) === minorAmount(item.current.amount, currency));
    if (!unchanged) return fail("changed_since_preview");

    // graphqlWithRetry waits out throttling with backoff. A retry after a network error
    // that had in fact succeeded is harmless: it sets the same cost again.
    try {
      const data = await graphqlWithRetry<{
        inventoryItemUpdate: { userErrors: { field: string[] | null; message: string }[] } | null;
      }>(admin, SET_COST_MUTATION, { id: variant.inventoryItem.id, input: { cost: proposed.amount } });
      const errors = data.inventoryItemUpdate?.userErrors ?? [];
      if (errors.length > 0) return fail("shopify_rejected", errors.map((e) => e.message).join("; "));
    } catch (err) {
      const message = describeError(err);
      if (isMissingScope(err)) forgetCostWriteScopes(shop);
      if (isAuthFailure(err)) return fail("shop_not_connected");
      return fail(/throttl/i.test(message) ? "throttled" : "shopify_error", message);
    }

    // Shopify now holds the cost; keep Inventorify's own in step (same as the sync does).
    await prisma.$transaction([
      prisma.product.updateMany({
        where: { shop, id: variantGid(item.variantId) },
        data: { unitCost: Number(proposed.amount) },
      }),
      prisma.growzarCostWrite.create({
        data: {
          ...log,
          variantId: variantGid(item.variantId),
          inventoryItemId: variant.inventoryItem.id,
          oldAmount: item.current?.amount ?? null,
          newAmount: proposed.amount,
          result: "set",
        },
      }),
    ]);
    return { variantId: item.variantId, result: "set" };
  });

  const set = results.filter((r) => r.result === "set").length;
  console.info(
    `[growzar] costs confirmed for ${shop} by ${actor}: preview ${previewId}, ${set} set, ${results.length - set} failed`,
  );
  const body = { shop, previewId, currency, items: results, summary: { set, failed: results.length - set } };
  await prisma.growzarCostConfirm.update({
    where: { shop_idempotencyKey: { shop, idempotencyKey } },
    data: { responseStatus: 200, response: body as unknown as Prisma.InputJsonValue, completedAt: new Date() },
  });
  return storedJson(200, body, false);
}
