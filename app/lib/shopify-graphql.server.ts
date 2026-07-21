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
        if (response.status < 500) throw new Error(lastError);
        continue;
      }
      json = await response.json();
    } catch (err) {
      lastError = err instanceof Error ? err.message : "request failed";
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
