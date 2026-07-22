import type { AdminApiContext } from "@shopify/shopify-app-remix/server";

/** Run `limit` promises at a time. Keeps sync fast without stampeding the DB pool. */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Shopify's GraphQL API is cost-throttled: over-budget queries come back as a 429, or
 * as a 200 carrying a THROTTLED error. Either way the previous code treated the page as
 * "no data" and silently stopped — which, combined with the orphan sweep below, used to
 * delete every product the aborted pagination had not reached yet.
 *
 * This retries with exponential backoff and *throws* when it finally gives up, so
 * callers must decide explicitly what a failed page means. Never returns partial data.
 */
/**
 * Signals a failure that retrying cannot fix (a 4xx other than 429). It has to be a
 * distinct type because the fetch is wrapped in its own try/catch: a plain `throw` inside
 * that block is caught by it and turned into another retry, which is exactly what used to
 * happen — a 400 was retried five times with backoff, burning ~15s per failed page while
 * the comment claimed it failed fast.
 */
class NonRetryableGraphqlError extends Error {}

/** Raised when the shop's token lacks a scope the query needs. */
export class MissingScopeError extends Error {}

/**
 * Classify a thrown value into a message and whether retrying could ever help.
 *
 * Getting this wrong is expensive in both directions. Observed in production:
 *  - `admin.graphql` throws GraphqlQueryError for permission and query errors. These are
 *    permanent, but they landed in the generic catch and were retried five times with
 *    backoff — ~15s burned per shop to reach a conclusion already known on attempt one.
 *  - shopify-app-remix throws a bare `Response` (not an Error) when a token is invalid
 *    and the shop needs to re-authorise. It has no `.message`, so the operator-facing
 *    error read "Unknown error" and said nothing about what to do.
 */
function classifyError(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof NonRetryableGraphqlError) {
    return { message: err.message, retryable: false };
  }

  // A thrown Response means authentication failed; a background job cannot resolve it.
  if (typeof Response !== "undefined" && err instanceof Response) {
    return {
      message:
        `authentication failed (HTTP ${err.status}) — the shop's token is no longer ` +
        `valid; it must reinstall or re-authorise the app`,
      retryable: false,
    };
  }

  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : `${name || "unknown"} thrown: ${safeStringify(err)}`;

  // Throttling is the one library error worth waiting out.
  if (/throttl/i.test(name) || /throttl/i.test(message)) {
    return { message, retryable: true };
  }
  // Permission and malformed-query errors will never succeed on a retry.
  if (name === "GraphqlQueryError") {
    return { message, retryable: false };
  }
  // Anything else (network, timeouts) is worth another attempt.
  return { message, retryable: true };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Operator-facing description of any thrown value.
 *
 * shopify-app-remix throws a bare `Response` for auth failures, which is not an Error and
 * has no `.message`. Callers doing `err instanceof Error ? err.message : "Unknown error"`
 * therefore reported "Unknown error" for the single most actionable failure there is —
 * a shop whose token has stopped working and needs re-authorising.
 */
export function describeError(err: unknown): string {
  if (typeof Response !== "undefined" && err instanceof Response) {
    return (
      `authentication failed (HTTP ${err.status}) — the shop's token is no longer valid; ` +
      `it must reinstall or re-authorise the app`
    );
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  const name = (err as { constructor?: { name?: string } })?.constructor?.name;
  return `${name ?? "unknown"} thrown: ${safeStringify(err)}`;
}

/** True when a failure is a missing-scope problem, which callers may degrade around. */
export function isMissingScope(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /access denied|access scope/i.test(msg);
}

export async function graphqlWithRetry<T>(
  admin: AdminApiContext,
  query: string,
  variables: Record<string, unknown> = {},
  attempts = 5,
): Promise<T> {
  let lastError = "unknown error";

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));

    let json: {
      data?: T;
      errors?: { message?: string; extensions?: { code?: string } }[];
    };
    try {
      const response = await admin.graphql(query, { variables });
      if (response.status === 429) {
        lastError = "throttled (429)";
        continue;
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        // 5xx is worth retrying; other 4xx will not fix themselves.
        if (response.status < 500) throw new NonRetryableGraphqlError(lastError);
        continue;
      }
      json = await response.json();
    } catch (err) {
      const { message, retryable } = classifyError(err);
      lastError = message;
      // A permanent failure must escape this loop rather than being folded back into
      // it as another attempt.
      if (!retryable) {
        throw isMissingScope(err)
          ? new MissingScopeError(message)
          : new Error(message);
      }
      continue;
    }

    const throttled = json.errors?.some(
      (e) => e.extensions?.code === "THROTTLED" || /throttl/i.test(e.message ?? ""),
    );
    if (throttled) {
      lastError = "throttled";
      continue;
    }
    if (json.errors?.length) {
      throw new Error(json.errors.map((e) => e.message ?? "graphql error").join(", "));
    }
    if (!json.data) {
      lastError = "response contained no data";
      continue;
    }
    return json.data;
  }

  throw new Error(`Shopify GraphQL failed after ${attempts} attempts: ${lastError}`);
}

export interface Paged<N> {
  edges: { node: N }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
