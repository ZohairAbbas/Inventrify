/**
 * Server-side pagination for the list pages.
 *
 * Every list in the app used to load its whole table and filter in JavaScript — the
 * inventory page fetched every variant with its location stock and supplier joined, then
 * discarded most of it. That is survivable at a few hundred SKUs and falls over at a few
 * thousand, which is exactly the size of merchant the rest of the app is built for.
 *
 * Offset pagination rather than cursors, deliberately: these lists are sorted by fields a
 * merchant chooses (title, date, status), they need to report "page 3 of 40", and they
 * need to jump. Cursors buy consistency under concurrent writes at the cost of all three.
 * The depth that makes offset slow is far past the depth anyone scrolls to.
 *
 * Pure and framework-free so the clamping rules are unit-testable.
 */

export const PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_PAGE_SIZE = 50;

export interface PageRequest {
  /** The page the caller asked for; not yet checked against how many exist. */
  page: number;
  pageSize: number;
}

export interface Page {
  /** Clamped to a page that exists. 1 when there are no rows at all. */
  page: number;
  pageSize: number;
  totalItems: number;
  /** At least 1, so "page 1 of 1" reads sensibly on an empty list. */
  totalPages: number;
  /** Feed straight to Prisma. */
  skip: number;
  take: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** 1-based inclusive index of the first row shown; 0 when there are none. */
  firstItem: number;
  /** 1-based inclusive index of the last row shown; 0 when there are none. */
  lastItem: number;
}

/**
 * Read `?page=` and `?pageSize=` without touching the database.
 *
 * Anything unparseable falls back to the default rather than erroring: a hand-edited or
 * stale URL should show the first page, not a stack trace. `pageSize` is restricted to a
 * fixed set so a crafted `?pageSize=1000000` cannot ask the database for the whole table
 * — which would reintroduce precisely the problem this module exists to solve.
 */
export function parsePageRequest(params: URLSearchParams): PageRequest {
  const rawPage = Number.parseInt(params.get("page") ?? "", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;

  const rawSize = Number.parseInt(params.get("pageSize") ?? "", 10);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(rawSize)
    ? rawSize
    : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

/**
 * Resolve a request against the real row count.
 *
 * Call this *before* the page query, so `skip` is derived from the clamped page. Clamping
 * only the number shown to the user leaves `?page=999` querying past the end and
 * rendering an empty table under the heading "Page 999 of 4".
 */
export function resolvePage(request: PageRequest, totalItems: number): Page {
  const total = Math.max(0, Math.floor(totalItems));
  const pageSize = request.pageSize;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, request.page), totalPages);
  const skip = (page - 1) * pageSize;

  return {
    page,
    pageSize,
    totalItems: total,
    totalPages,
    skip,
    take: pageSize,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    firstItem: total === 0 ? 0 : skip + 1,
    lastItem: total === 0 ? 0 : Math.min(skip + pageSize, total),
  };
}

/**
 * Normalise a free-text search box into something safe to hand Prisma.
 *
 * Trimmed, length-capped, and empty-means-no-filter. The cap is not about safety —
 * Prisma parameterises — but about not building a pathological `ILIKE %…%` from a
 * pasted wall of text.
 */
export function parseSearch(params: URLSearchParams, key = "search"): string {
  return (params.get(key) ?? "").trim().slice(0, 100);
}

/**
 * The page numbers to render, with `null` standing in for an elided run.
 *
 * Always shows the first and last page plus a window around the current one, so the
 * control stays a fixed width whether there are 3 pages or 300.
 */
export function pageNumbers(current: number, totalPages: number, window = 1): (number | null)[] {
  if (totalPages <= 1) return [1];

  const wanted = new Set<number>([1, totalPages]);
  for (let p = current - window; p <= current + window; p++) {
    if (p >= 1 && p <= totalPages) wanted.add(p);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const p of sorted) {
    // A gap of exactly one page is rendered as that page rather than an ellipsis —
    // "1 … 3" is the same width as "1 2 3" and tells the reader less.
    if (previous && p - previous === 2) out.push(previous + 1);
    else if (previous && p - previous > 2) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}
