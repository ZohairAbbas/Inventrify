import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  pageNumbers,
  parsePageRequest,
  parseSearch,
  resolvePage,
} from "./pagination";

const req = (qs: string) => parsePageRequest(new URLSearchParams(qs));

describe("parsePageRequest", () => {
  it("defaults to the first page at the default size", () => {
    expect(req("")).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("reads a valid page and size", () => {
    expect(req("page=3&pageSize=25")).toEqual({ page: 3, pageSize: 25 });
  });

  it("falls back rather than erroring on nonsense", () => {
    expect(req("page=abc")).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(req("page=0")).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(req("page=-4")).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
    expect(req("page=1.9")).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it("refuses a page size outside the allowed set", () => {
    // The whole point of paginating is that no request can ask for the entire table.
    expect(req("pageSize=1000000").pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(req("pageSize=0").pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(req("pageSize=-50").pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(req("pageSize=51").pageSize).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("resolvePage", () => {
  it("describes a middle page", () => {
    const p = resolvePage({ page: 2, pageSize: 25 }, 130);
    expect(p).toMatchObject({
      page: 2, totalPages: 6, skip: 25, take: 25,
      hasPrevious: true, hasNext: true, firstItem: 26, lastItem: 50,
    });
  });

  it("clamps a page past the end, and clamps skip with it", () => {
    const p = resolvePage({ page: 999, pageSize: 50 }, 130);
    expect(p.page).toBe(3);
    // The bug this prevents: clamping only the displayed number leaves skip at 49_900,
    // so the table renders empty under the heading "Page 3 of 3".
    expect(p.skip).toBe(100);
    expect(p.lastItem).toBe(130);
    expect(p.hasNext).toBe(false);
  });

  it("handles an empty list without reading as broken", () => {
    const p = resolvePage({ page: 1, pageSize: 50 }, 0);
    expect(p).toMatchObject({
      page: 1, totalPages: 1, skip: 0, firstItem: 0, lastItem: 0,
      hasPrevious: false, hasNext: false,
    });
  });

  it("handles a single partial page", () => {
    const p = resolvePage({ page: 1, pageSize: 50 }, 7);
    expect(p).toMatchObject({ totalPages: 1, firstItem: 1, lastItem: 7, hasNext: false });
  });

  it("reports the exact last item on a boundary-sized list", () => {
    const p = resolvePage({ page: 2, pageSize: 50 }, 100);
    expect(p).toMatchObject({ totalPages: 2, firstItem: 51, lastItem: 100, hasNext: false });
  });

  it("never returns a negative skip", () => {
    expect(resolvePage({ page: 1, pageSize: 25 }, 10).skip).toBe(0);
  });

  it("tolerates a nonsense total", () => {
    expect(resolvePage({ page: 1, pageSize: 25 }, -5).totalItems).toBe(0);
    expect(resolvePage({ page: 1, pageSize: 25 }, 10.7).totalItems).toBe(10);
  });
});

describe("parseSearch", () => {
  it("trims and passes through", () => {
    expect(parseSearch(new URLSearchParams("search=  kurta "))).toBe("kurta");
  });

  it("treats missing and blank alike", () => {
    expect(parseSearch(new URLSearchParams(""))).toBe("");
    expect(parseSearch(new URLSearchParams("search=   "))).toBe("");
  });

  it("caps pathological input", () => {
    const long = "a".repeat(500);
    expect(parseSearch(new URLSearchParams(`search=${long}`))).toHaveLength(100);
  });

  it("reads an alternate key", () => {
    expect(parseSearch(new URLSearchParams("q=abc"), "q")).toBe("abc");
  });
});

describe("pageNumbers", () => {
  it("lists every page when they all fit", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 3)).toEqual([1, 2, 3]);
  });

  it("elides a long run", () => {
    expect(pageNumbers(10, 40)).toEqual([1, null, 9, 10, 11, null, 40]);
  });

  it("keeps the ends anchored", () => {
    expect(pageNumbers(1, 40)).toEqual([1, 2, null, 40]);
    expect(pageNumbers(40, 40)).toEqual([1, null, 39, 40]);
  });

  it("renders a one-page gap as the page itself, not an ellipsis", () => {
    // "1 … 3" is no narrower than "1 2 3" and says less.
    expect(pageNumbers(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("never repeats a page number", () => {
    for (let total = 1; total <= 30; total++) {
      for (let current = 1; current <= total; current++) {
        const nums = pageNumbers(current, total).filter((n): n is number => n !== null);
        expect(new Set(nums).size).toBe(nums.length);
        expect([...nums]).toEqual([...nums].sort((a, b) => a - b));
      }
    }
  });
});
