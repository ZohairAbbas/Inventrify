import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Growzar request signing, API-CONTRACT §2.1 and §2.2.
 *
 *   X-Growzar-Signature: sha256=HMAC(secret, "<timestamp>.<METHOD> <path+query>.<raw body>")
 *   X-Growzar-Timestamp: ms epoch, 5-minute skew limit in both directions
 *
 * One construction for both directions: Growzar's calls to us (status now, the R2 read
 * API later) are verified with it, and our events to Growzar are signed with it. It
 * mirrors Growzar's own `app/lib/apps/signing.server.ts` byte for byte — any difference
 * in the payload string is a failed request, so keep the two in step.
 *
 * The secret is Inventorify's own Growzar secret (GROWZAR_SIGNING_SECRET). It is never
 * shared with Courierify or any other peer.
 */
export const SIGNATURE_SKEW_MS = 5 * 60 * 1000;

export function signingPayload(options: {
  timestamp: number;
  method: string;
  pathWithQuery: string;
  body: string;
}): string {
  const { timestamp, method, pathWithQuery, body } = options;
  return `${timestamp}.${method.toUpperCase()} ${pathWithQuery}.${body}`;
}

export function sign(secret: string, payload: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/** Headers for a signed request from Inventorify to Growzar (§2.2). */
export function signedHeaders(options: {
  secret: string;
  method: string;
  pathWithQuery: string;
  body: string;
  now?: number;
}): Record<string, string> {
  const timestamp = options.now ?? Date.now();
  return {
    "Content-Type": "application/json",
    "X-Growzar-Timestamp": String(timestamp),
    "X-Growzar-Signature": sign(
      options.secret,
      signingPayload({
        timestamp,
        method: options.method,
        pathWithQuery: options.pathWithQuery,
        body: options.body,
      }),
    ),
  };
}

/**
 * Constant-time string equality. Both sides are hashed first so the comparison is over
 * equal-length buffers and a length mismatch cannot be told apart by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

export type SignatureFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "timestamp_out_of_range"
  | "bad_signature";

export function verifySignature(options: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  method: string;
  pathWithQuery: string;
  body: string;
  now?: number;
}): { ok: true } | { ok: false; reason: SignatureFailure } {
  const { secret, signature, timestamp } = options;

  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!timestamp) return { ok: false, reason: "missing_timestamp" };

  // Digits only: Number() would accept "1e12" or " 123 ", and a timestamp that is not
  // the exact string that was signed can never verify anyway.
  if (!/^\d{1,16}$/.test(timestamp)) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }
  const sentAt = Number(timestamp);
  const now = options.now ?? Date.now();
  // Checked before the HMAC, and in both directions: a far-future timestamp is as wrong
  // as a stale one, and a replayed genuine request is the cheaper attack.
  if (Math.abs(now - sentAt) > SIGNATURE_SKEW_MS) {
    return { ok: false, reason: "timestamp_out_of_range" };
  }

  const expected = sign(
    secret,
    signingPayload({
      timestamp: sentAt,
      method: options.method,
      pathWithQuery: options.pathWithQuery,
      body: options.body,
    }),
  );

  if (!safeEqual(expected, signature)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
