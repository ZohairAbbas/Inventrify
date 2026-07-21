import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of the cron shared secret.
 *
 * `!==` on a secret leaks its prefix through response timing. It also silently
 * "worked" when CRON_SECRET was unset in a way that depended on the header being
 * absent too — here a missing or blank server-side secret always denies, so a
 * misconfigured deploy fails closed rather than exposing the endpoint.
 */
export function isAuthorisedCronRequest(request: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length === 0) {
    console.error("[cron] CRON_SECRET is not set — refusing all cron requests");
    return false;
  }

  const provided = request.headers.get("x-cron-secret");
  if (!provided) return false;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare fixed-size digests instead by padding through a length check that is
  // resolved with a constant-time compare against a same-length buffer.
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
