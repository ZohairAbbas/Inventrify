import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "@remix-run/react";

/**
 * URL state for a paginated, searchable list.
 *
 * The list pages keep their state in the query string rather than in component state, so
 * a filtered view can be linked, bookmarked and reloaded — and so the loader can do the
 * filtering in SQL instead of shipping the whole table to the browser.
 *
 * Two rules are easy to get wrong and are handled here once:
 *
 *   - Changing any filter resets to page 1. Staying on page 7 while narrowing a search
 *     down to four results shows an empty table.
 *   - Search input is debounced and kept in local state, so typing stays responsive
 *     rather than firing a loader request per keystroke.
 */
export function useListParams(options: { searchKey?: string; debounceMs?: number } = {}) {
  const { searchKey = "search", debounceMs = 300 } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  const urlSearch = searchParams.get(searchKey) ?? "";
  const [searchInput, setSearchInput] = useState(urlSearch);

  // Track what we last pushed so an external navigation (back button, a link from another
  // page) can adopt the URL's value without clobbering what the user is mid-way through
  // typing.
  const lastPushed = useRef(urlSearch);
  useEffect(() => {
    if (urlSearch !== lastPushed.current) {
      lastPushed.current = urlSearch;
      setSearchInput(urlSearch);
    }
  }, [urlSearch]);

  const setParams = useCallback(
    (mutate: (next: URLSearchParams) => void, opts: { resetPage?: boolean } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          if (opts.resetPage !== false) next.delete("page");
          return next;
        },
        { preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  // Debounced push of the search box into the URL.
  useEffect(() => {
    if (searchInput === lastPushed.current) return;
    const timer = setTimeout(() => {
      lastPushed.current = searchInput;
      setParams((next) => {
        if (searchInput) next.set(searchKey, searchInput);
        else next.delete(searchKey);
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [searchInput, searchKey, debounceMs, setParams]);

  /** Set or clear one filter, returning to page 1. */
  const setFilter = useCallback(
    (key: string, value: string | null) => {
      setParams((next) => {
        if (value === null || value === "" || value === "all") next.delete(key);
        else next.set(key, value);
      });
    },
    [setParams],
  );

  /** Page changes are the one navigation that must NOT reset the page. */
  const setPage = useCallback(
    (page: number) => {
      setParams(
        (next) => {
          if (page <= 1) next.delete("page");
          else next.set("page", String(page));
        },
        { resetPage: false },
      );
    },
    [setParams],
  );

  const setPageSize = useCallback(
    (pageSize: number) => {
      // Row count changes which rows land on page 1, so the page index is meaningless
      // afterwards — go back to the start rather than to an arbitrary offset.
      setParams((next) => next.set("pageSize", String(pageSize)));
    },
    [setParams],
  );

  return { searchInput, setSearchInput, setFilter, setPage, setPageSize, setParams };
}
