/**
 * Rate limit on the Growzar platform key (API-CONTRACT §2.1): 600 requests a minute, in
 * a bucket of its own, never failing open.
 *
 * In-process, sliding window. Inventorify runs as a single pm2 fork (ecosystem.config.cjs),
 * so one process sees every request and the count is exact; there is no external store
 * whose outage could let requests through. A restart empties the window, which at worst
 * admits one extra minute's allowance.
 *
 * If the app is ever scaled past one instance this must move to a shared store, or each
 * instance would grant the full allowance.
 */
export const PLATFORM_LIMIT = 600;
export const PLATFORM_WINDOW_MS = 60_000;

export type RateLimiter = {
  /** Records a request when allowed; otherwise says how long until one would be. */
  take(now?: number): { ok: true } | { ok: false; retryAfterSeconds: number };
};

export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  // Timestamps of admitted requests, oldest first. Bounded by `limit`.
  const admitted: number[] = [];
  return {
    take(now = Date.now()) {
      while (admitted.length > 0 && admitted[0] <= now - windowMs) admitted.shift();
      if (admitted.length >= limit) {
        const retryAfterMs = admitted[0] + windowMs - now;
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      admitted.push(now);
      return { ok: true };
    },
  };
}

export const platformLimiter = createRateLimiter(PLATFORM_LIMIT, PLATFORM_WINDOW_MS);
