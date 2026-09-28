import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sign, signingPayload, verifySignature } from "./signing.server";
import { authenticatePlatformRequest } from "./platform-auth.server";
import { CLAIM_TOKEN_TTL_SECONDS, claimUrl, mintClaimToken } from "./claim-token.server";
import { resolveClaimIdentity } from "./shopify-user.server";
import {
  RETRY_DELAYS_MS,
  deliverDueEvents,
  enqueueEvent,
  nextRetryAt,
  uninstallEnvelope,
} from "./events.server";

const KEY = "pk_test_platform_key";
const SECRET = "test-signing-secret";
const ENV = {
  GROWZAR_URL: "https://growzar.test",
  GROWZAR_PLATFORM_KEY: KEY,
  GROWZAR_SIGNING_SECRET: SECRET,
} as unknown as NodeJS.ProcessEnv;
const NOW = 1_790_000_000_000;
const SHOP = "acme.myshopify.com";
const STATUS = `/api/v1/growzar/status?shop=${SHOP}`;

/** Build a request exactly as Growzar's outboundHeaders() does. */
function growzarRequest({
  pathWithQuery = STATUS,
  bearer = KEY,
  secret = SECRET,
  timestamp = NOW,
  signed = true,
  shopHeader = SHOP as string | null,
}: Partial<{
  pathWithQuery: string;
  bearer: string;
  secret: string;
  timestamp: number;
  signed: boolean;
  shopHeader: string | null;
}> = {}) {
  const headers = new Headers({ Authorization: `Bearer ${bearer}`, Accept: "application/json" });
  if (shopHeader !== null) headers.set("X-Growzar-Shop", shopHeader);
  if (signed) {
    headers.set("X-Growzar-Timestamp", String(timestamp));
    headers.set(
      "X-Growzar-Signature",
      sign(secret, signingPayload({ timestamp, method: "GET", pathWithQuery, body: "" })),
    );
  }
  return new Request(`https://inventorify.growzar.com${pathWithQuery}`, { headers });
}

async function auth(request: Request, env = ENV) {
  return authenticatePlatformRequest(request, { env, now: NOW });
}

describe("signing", () => {
  it("builds the same payload string as Growzar", () => {
    expect(signingPayload({ timestamp: 1, method: "post", pathWithQuery: "/a?b=c", body: "{}" })).toBe(
      "1.POST /a?b=c.{}",
    );
  });

  it("rejects a far-future timestamp as well as a stale one", () => {
    const base = { secret: SECRET, method: "GET", pathWithQuery: "/x", body: "" };
    for (const ts of [NOW - 5 * 60_000 - 1, NOW + 5 * 60_000 + 1]) {
      const signature = sign(SECRET, signingPayload({ ...base, timestamp: ts }));
      expect(
        verifySignature({ ...base, signature, timestamp: String(ts), now: NOW }),
      ).toEqual({ ok: false, reason: "timestamp_out_of_range" });
    }
  });
});

describe("authenticatePlatformRequest", () => {
  it("accepts a correctly signed platform request", async () => {
    const result = await auth(growzarRequest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.shop).toBe(SHOP);
  });

  it("returns 401 for a valid bearer key with no signature", async () => {
    const result = await auth(growzarRequest({ signed: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      expect(await result.response.json()).toEqual({
        error: "Invalid request signature.",
        errorType: "unauthorized",
      });
    }
  });

  it("returns 401 for a stale timestamp", async () => {
    const result = await auth(growzarRequest({ timestamp: NOW - 6 * 60_000 }));
    expect(result.ok ? 200 : result.response.status).toBe(401);
  });

  it("returns 401 for a wrong bearer key even when signed", async () => {
    const result = await auth(growzarRequest({ bearer: "pk_wrong" }));
    expect(result.ok ? 200 : result.response.status).toBe(401);
  });

  it("returns 401 when the signature was made with another secret", async () => {
    const result = await auth(growzarRequest({ secret: "courierify-secret" }));
    expect(result.ok ? 200 : result.response.status).toBe(401);
  });

  it("returns 401 when the query was changed after signing", async () => {
    const request = growzarRequest();
    const tampered = new Request(request.url.replace(SHOP, "other.myshopify.com"), {
      headers: request.headers,
    });
    const result = await auth(tampered);
    expect(result.ok ? 200 : result.response.status).toBe(401);
  });

  it("returns 400 when the shop header and query disagree", async () => {
    const result = await auth(growzarRequest({ shopHeader: "other.myshopify.com" }));
    expect(result.ok ? 200 : result.response.status).toBe(400);
  });

  it("refuses everything when unconfigured", async () => {
    const result = await auth(growzarRequest(), {} as NodeJS.ProcessEnv);
    expect(result.ok ? 200 : result.response.status).toBe(503);
  });
});

function decode(token: string) {
  const [h, p, s] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    signatureValid: createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") === s,
  };
}

describe("claim token", () => {
  const identity = {
    shop: "Acme.myshopify.com",
    userId: "123",
    email: "Owner@Acme.pk",
    isStoreOwner: true,
    locale: "en",
  };

  it("carries the §10 claims with a 5-minute expiry", () => {
    const { header, payload, signatureValid } = decode(
      mintClaimToken(identity, { secret: SECRET, now: NOW, jti: "j-1" }),
    );
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(signatureValid).toBe(true);
    expect(payload).toEqual({
      iss: "inventorify",
      aud: "growzar",
      shop: "acme.myshopify.com",
      shopifyUserId: "gid://shopify/StaffMember/123",
      email: "owner@acme.pk",
      isStoreOwner: true,
      locale: "en",
      jti: "j-1",
      iat: NOW / 1000,
      exp: NOW / 1000 + CLAIM_TOKEN_TTL_SECONDS,
    });
    expect(CLAIM_TOKEN_TTL_SECONDS).toBe(300);
  });

  it("uses a fresh jti every time", () => {
    const a = decode(mintClaimToken(identity, { secret: SECRET })).payload.jti;
    const b = decode(mintClaimToken(identity, { secret: SECRET })).payload.jti;
    expect(a).not.toBe(b);
  });

  it("puts the token in the fragment, never the query", () => {
    const url = claimUrl("https://growzar.test/", "a.b.c");
    expect(url).toBe("https://growzar.test/claim#token=a.b.c");
    expect(new URL(url).search).toBe("");
  });
});

describe("resolveClaimIdentity", () => {
  const exchange = (user: Record<string, unknown>, status = 200) =>
    vi.fn(async () => Response.json({ access_token: "shpua_x", associated_user: user }, { status }));
  const base = { shop: SHOP, sessionToken: "id.token.jwt", apiKey: "k", apiSecret: "s" };
  const owner = { id: 123, email: "owner@acme.pk", email_verified: true, account_owner: true, locale: "en" };

  it("reads identity from Shopify's online-token exchange", async () => {
    const fetchImpl = exchange(owner);
    const result = await resolveClaimIdentity({ ...base, expectedUserId: "123", fetchImpl });
    expect(result).toEqual({
      ok: true,
      identity: { shop: SHOP, userId: "123", email: "owner@acme.pk", isStoreOwner: true, locale: "en" },
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(JSON.parse(String(init.body)).requested_token_type).toBe(
      "urn:shopify:params:oauth:token-type:online-access-token",
    );
  });

  it("refuses when the exchanged user is not the session token's user", async () => {
    const result = await resolveClaimIdentity({ ...base, expectedUserId: "999", fetchImpl: exchange(owner) });
    expect(result).toEqual({ ok: false, reason: "user_mismatch" });
  });

  it("refuses an unverified email", async () => {
    const result = await resolveClaimIdentity({
      ...base,
      expectedUserId: "123",
      fetchImpl: exchange({ ...owner, email_verified: false }),
    });
    expect(result).toEqual({ ok: false, reason: "email_unverified" });
  });

  it("refuses when Shopify rejects the exchange", async () => {
    const result = await resolveClaimIdentity({ ...base, expectedUserId: "123", fetchImpl: exchange({}, 400) });
    expect(result).toEqual({ ok: false, reason: "exchange_failed" });
  });
});

describe("app.uninstalled outbox", () => {
  let dir: string;
  let clock: number;
  const now = () => clock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "growzar-outbox-"));
    clock = NOW;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  const envelope = () =>
    uninstallEnvelope({ shop: SHOP, webhookId: "wh-1", triggeredAt: "2026-09-24T10:00:00.123Z" });

  it("builds the §7 envelope, deterministic per webhook delivery", () => {
    expect(envelope()).toEqual({
      eventId: "inventorify-uninstall-wh-1",
      topic: "app.uninstalled",
      occurredAt: "2026-09-24T10:00:00Z",
      shop: SHOP,
      actor: { type: "shopify" },
      data: {},
    });
  });

  it("the retry schedule is 1m, 5m, 30m, 2h, 6h, 12h, then stops", () => {
    expect(RETRY_DELAYS_MS.map((ms) => ms / 60_000)).toEqual([1, 5, 30, 120, 360, 720]);
    expect(nextRetryAt(1, 0)).toBe(60_000);
    expect(nextRetryAt(6, 0)).toBe(720 * 60_000);
    expect(nextRetryAt(7, 0)).toBeNull();
  });

  it("dedupes a redelivered webhook", async () => {
    expect(await enqueueEvent(envelope(), { dir, now: new Date(clock) })).toEqual({ queued: true });
    expect(await enqueueEvent(envelope(), { dir, now: new Date(clock) })).toEqual({ queued: false });
    expect((await readdir(dir)).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("posts a signed envelope Growzar can verify, and removes it on 202", async () => {
    await enqueueEvent(envelope(), { dir, now: new Date(clock) });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const report = await deliverDueEvents({ dir, now, fetchImpl, env: ENV });
    expect(report).toMatchObject({ due: 1, delivered: 1 });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://growzar.test/api/v1/events");
    const headers = init.headers as Record<string, string>;
    expect(
      verifySignature({
        secret: SECRET,
        signature: headers["X-Growzar-Signature"],
        timestamp: headers["X-Growzar-Timestamp"],
        method: "POST",
        pathWithQuery: "/api/v1/events",
        body: String(init.body),
        now: NOW,
      }),
    ).toEqual({ ok: true });
    expect(await readdir(dir)).toEqual([]);
  });

  it("retries a 500 on the backoff schedule, re-signing each attempt, then gives up", async () => {
    await enqueueEvent(envelope(), { dir, now: new Date(clock) });
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));

    for (const delay of RETRY_DELAYS_MS) {
      expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).retrying).toBe(1);
      // Not due yet a moment before the delay elapses.
      clock += delay - 1;
      expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).due).toBe(0);
      clock += 1;
    }
    const last = await deliverDueEvents({ dir, now, fetchImpl, env: ENV });
    expect(last.failed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);

    const timestamps = fetchImpl.mock.calls.map(
      (call) => ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["X-Growzar-Timestamp"],
    );
    expect(new Set(timestamps).size).toBe(timestamps.length);

    const dead = JSON.parse(await readFile(path.join(dir, "dead", "inventorify-uninstall-wh-1.json"), "utf8"));
    expect(dead).toMatchObject({ attempts: 7, lastError: "HTTP 500" });
  });

  it("retries a network error, then delivers", async () => {
    await enqueueEvent(envelope(), { dir, now: new Date(clock) });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).retrying).toBe(1);
    clock += RETRY_DELAYS_MS[0];
    expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).delivered).toBe(1);
  });

  it("does not retry a 401 — the same bytes cannot succeed", async () => {
    await enqueueEvent(envelope(), { dir, now: new Date(clock) });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 401 }));
    expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).failed).toBe(1);
  });

  it("keeps events without spending attempts while Growzar is unconfigured", async () => {
    await enqueueEvent(envelope(), { dir, now: new Date(clock) });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const report = await deliverDueEvents({ dir, now, fetchImpl, env: {} as NodeJS.ProcessEnv });
    expect(report.configured).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await deliverDueEvents({ dir, now, fetchImpl, env: ENV })).delivered).toBe(1);
  });
});
