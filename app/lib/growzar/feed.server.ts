import { json } from "@remix-run/node";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { authenticatePlatformRequest, growzarError } from "./platform-auth.server";
import { platformLimiter, type RateLimiter } from "./rate-limit.server";

/**
 * Shared plumbing for the Growzar read feeds (API-CONTRACT §6, Phase 5).
 *
 * Every feed is `GET /api/v1/growzar/<feed>` and goes through `openFeed`, which applies,
 * in order: the platform signature check (§2.1, the same gate as /growzar/status), the
 * platform-key rate limit, the query parameters, and the install check. A shop with no
 * offline session — uninstalled, or purged by SHOP_REDACT — is 410 shop_not_connected.
 *
 * Paging is keyset on (updatedAt, id) ascending, with `updatedSince` inclusive (§6.2).
 * The cursor carries the last row's (updatedAt, primary key); the primary key is always
 * the table's own id column, even where the id a feed shows is a natural key.
 */

/** Feeds this release serves, as /growzar/status `capabilities`. */
export const GROWZAR_CAPABILITIES: string[] = ["variants:read", "stock-levels:read", "daily-sales:read", "purchase-orders:read"];

export const MAX_LIMIT = 500;
export const DEFAULT_LIMIT = 200;
/** Most tombstones one response lists before it sets `<key>Truncated`. */
export const TOMBSTONE_CAP = 1000;

/** GrowzarTombstone.feed of the marker a keep-session purge leaves behind. */
export const PURGE_MARKER_FEED = "shop";
export const PURGE_MARKER_ID = "purge";

export type ShopFacts = {
  shop: string;
  shopTimezone: string | null;
  shopCurrency: string | null;
  shopCountry: string | null;
};

export type FeedCursor = { updatedAt: Date; id: string };

export type FeedParams = {
  updatedSince: Date | null;
  limit: number;
  cursor: FeedCursor | null;
};

export type FeedRequest = { facts: ShopFacts; params: FeedParams };

function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt.toISOString(), cursor.id])).toString("base64url");
}

function decodeCursor(raw: string): FeedCursor | null {
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(value) || value.length !== 2) return null;
    const [at, id] = value;
    if (typeof at !== "string" || typeof id !== "string" || !id) return null;
    const updatedAt = new Date(at);
    return Number.isNaN(updatedAt.getTime()) ? null : { updatedAt, id };
  } catch {
    return null;
  }
}

export function parseFeedParams(url: URL): { ok: true; value: FeedParams } | { ok: false; error: string } {
  const sinceRaw = url.searchParams.get("updatedSince");
  let updatedSince: Date | null = null;
  if (sinceRaw !== null) {
    updatedSince = new Date(sinceRaw);
    if (!sinceRaw.trim() || Number.isNaN(updatedSince.getTime())) {
      return { ok: false, error: "updatedSince must be an ISO 8601 timestamp." };
    }
  }

  const limitRaw = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { ok: false, error: `limit must be an integer from 1 to ${MAX_LIMIT}.` };
    }
  }

  const cursorRaw = url.searchParams.get("cursor");
  let cursor: FeedCursor | null = null;
  if (cursorRaw !== null) {
    cursor = decodeCursor(cursorRaw);
    if (!cursor) return { ok: false, error: "cursor is not one this API issued." };
  }

  return { ok: true, value: { updatedSince, limit, cursor } };
}

export async function openFeed(
  request: Request,
  { limiter = platformLimiter, env, now }: { limiter?: RateLimiter; env?: NodeJS.ProcessEnv; now?: number } = {},
): Promise<{ ok: true; value: FeedRequest } | { ok: false; response: Response }> {
  const auth = await authenticatePlatformRequest(request, { env, now });
  if (!auth.ok) return auth;
  const { shop } = auth.value;

  // Never fail open: anything going wrong inside the limiter refuses the request.
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

  const params = parseFeedParams(new URL(request.url));
  if (!params.ok) return { ok: false, response: growzarError(400, "bad_request", params.error) };

  try {
    const [sessions, settings] = await Promise.all([
      prisma.session.count({ where: { shop, isOnline: false } }),
      prisma.shopSettings.findUnique({
        where: { shop },
        select: { shopTimezone: true, shopCurrency: true, shopCountry: true },
      }),
    ]);
    if (sessions === 0) {
      return {
        ok: false,
        response: growzarError(410, "shop_not_connected", "Inventorify is not installed on this shop."),
      };
    }
    return {
      ok: true,
      value: {
        facts: {
          shop,
          shopTimezone: settings?.shopTimezone ?? null,
          shopCurrency: settings?.shopCurrency ?? null,
          shopCountry: settings?.shopCountry ?? null,
        },
        params: params.value,
      },
    };
  } catch (err) {
    console.error("[growzar] feed setup failed:", err instanceof Error ? err.message : err);
    return { ok: false, response: growzarError(500, "internal_error", "Could not read the shop.") };
  }
}

/**
 * Prisma `where` fragment for one page: rows at or after `updatedSince`, strictly after
 * the cursor in (updatedAt, id) order.
 */
export function keysetWhere(params: FeedParams) {
  const and: object[] = [];
  if (params.updatedSince) and.push({ updatedAt: { gte: params.updatedSince } });
  if (params.cursor) {
    and.push({
      OR: [
        { updatedAt: { gt: params.cursor.updatedAt } },
        { updatedAt: params.cursor.updatedAt, id: { gt: params.cursor.id } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

export const keysetOrder = [{ updatedAt: "asc" as const }, { id: "asc" as const }];

/** Fetch one more than the page size, so `hasMore` needs no second query. */
export const pageTake = (params: FeedParams) => params.limit + 1;

type TombstoneOption = { feed: string; key: string };

/**
 * Build the §6.1 envelope from rows fetched with `keysetWhere`/`keysetOrder`/`pageTake`.
 *
 * Tombstones are listed on the first page of a sync only (no cursor), since `updatedSince`
 * alone decides which ones are due; without `updatedSince` (a full resync) there is
 * nothing to report deleted. `shopPurged` is on every page: it says a keep-session purge
 * wiped the shop inside the window, so everything Growzar holds for it must be dropped.
 */
export async function feedResponse<Row extends { id: string; updatedAt: Date }>(
  { facts, params }: FeedRequest,
  fetched: Row[],
  toData: (row: Row) => unknown,
  tombstones?: TombstoneOption,
): Promise<Response> {
  const hasMore = fetched.length > params.limit;
  const rows = hasMore ? fetched.slice(0, params.limit) : fetched;
  const last = rows[rows.length - 1];

  const body: Record<string, unknown> = {
    shop: facts.shop,
    shopTimezone: facts.shopTimezone,
    shopCurrency: facts.shopCurrency,
    shopCountry: facts.shopCountry,
    data: rows.map(toData),
    pagination: {
      limit: params.limit,
      count: rows.length,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : null,
    },
  };

  let shopPurged = false;
  if (params.updatedSince) {
    const marker = await prisma.growzarTombstone.findFirst({
      where: {
        shop: facts.shop,
        feed: PURGE_MARKER_FEED,
        entityId: PURGE_MARKER_ID,
        deletedAt: { gte: params.updatedSince },
      },
      select: { id: true },
    });
    shopPurged = marker !== null;
  }
  body.shopPurged = shopPurged;

  if (tombstones) {
    let ids: string[] = [];
    let truncated = false;
    if (params.updatedSince && !params.cursor) {
      const deleted = await prisma.growzarTombstone.findMany({
        where: { shop: facts.shop, feed: tombstones.feed, deletedAt: { gte: params.updatedSince } },
        orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
        take: TOMBSTONE_CAP + 1,
        select: { entityId: true },
      });
      truncated = deleted.length > TOMBSTONE_CAP;
      ids = deleted.slice(0, TOMBSTONE_CAP).map((t) => t.entityId);
    }
    body[tombstones.key] = ids;
    body[`${tombstones.key}Truncated`] = truncated;
  }

  return json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Shopify GID or bare id → numeric string (§3). Anything else is null, never a guess. */
export function numericId(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(?:gid:\/\/shopify\/[A-Za-z]+\/)?(\d+)(?:\?.*)?$/.exec(value.trim());
  return match ? match[1] : null;
}

const minorUnitsCache = new Map<string, number>();

function minorUnits(currency: string): number {
  let digits = minorUnitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    } catch {
      digits = 2;
    }
    minorUnitsCache.set(currency, digits);
  }
  return digits;
}

/**
 * §4 money object. The stored Float is rounded to the currency's minor units here, at the
 * edge, and written as a decimal string. Unknown currency → null: never a default.
 */
export function money(
  amount: number | null | undefined,
  currency: string | null,
): { amount: string; currency: string } | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount) || !currency) return null;
  const digits = minorUnits(currency);
  const factor = 10 ** digits;
  const rounded = Math.round(amount * factor) / factor;
  return { amount: (Object.is(rounded, -0) ? 0 : rounded).toFixed(digits), currency };
}

/** UTC ISO timestamp with Z, or null (§5). */
export const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * A stored day — the shop-local calendar day written as UTC midnight (shopDateKey) — as
 * its `YYYY-MM-DD` label (§5).
 */
export const dayLabel = (value: Date): string => value.toISOString().slice(0, 10);

/** Record hard deletes for a feed. Pass the transaction client when inside one. */
export function tombstoneData(shop: string, feed: string, entityIds: string[]) {
  return entityIds.map((entityId) => ({ shop, feed, entityId }));
}

/**
 * Lift the no-op guard on updatedAt for one transaction.
 *
 * A database trigger (migration 20261007130000) keeps `updatedAt` unchanged when an
 * UPDATE changes no other column, so the hourly syncs' rewrites do not make every row
 * look new to Growzar. A write whose whole point is to move updatedAt — telling Growzar
 * a row changed when the change lives in another table — would be swallowed by that
 * guard, so it runs behind this: pass the result to `prisma.$transaction([...])`.
 */
export function touchingUpdatedAt(
  db: Pick<PrismaClient, "$executeRaw">,
  writes: Prisma.PrismaPromise<unknown>[],
): Prisma.PrismaPromise<unknown>[] {
  return [db.$executeRaw`SELECT set_config('growzar.touch', 'on', true)`, ...writes];
}
