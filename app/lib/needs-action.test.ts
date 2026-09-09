import { describe, expect, it } from "vitest";
import {
  countByStatus,
  isActionFilter,
  selectActionRows,
  type ActionFilter,
} from "./needs-action";

const sku = (id: string, status: string, daysRemaining: number | null = 5) => ({
  id,
  status,
  daysRemaining,
});

const CATALOGUE = [
  sku("out1", "stockout", 0),
  sku("out2", "stockout", 0),
  sku("crit1", "critical", 3),
  sku("low1", "low", 9),
  sku("low2", "low", 12),
  sku("fine1", "healthy", 200),
  sku("fine2", "healthy", 180),
];

describe("isActionFilter", () => {
  it("accepts the four real filters", () => {
    for (const f of ["all", "stockout", "critical", "low"]) {
      expect(isActionFilter(f)).toBe(true);
    }
  });

  it("rejects anything else, so a hand-edited URL cannot select an empty view", () => {
    expect(isActionFilter("healthy")).toBe(false);
    expect(isActionFilter("")).toBe(false);
    expect(isActionFilter(null)).toBe(false);
    expect(isActionFilter("DROP TABLE")).toBe(false);
  });
});

describe("countByStatus", () => {
  it("counts each severity", () => {
    expect(countByStatus(CATALOGUE)).toEqual({ all: 5, stockout: 2, critical: 1, low: 2 });
  });

  it("excludes healthy SKUs from the total", () => {
    // "All" means all that need action, not all products.
    expect(countByStatus(CATALOGUE).all).toBe(5);
  });

  it("has a total equal to the sum of its parts", () => {
    const c = countByStatus(CATALOGUE);
    expect(c.stockout + c.critical + c.low).toBe(c.all);
  });

  it("returns zeroes for an empty or entirely healthy catalogue", () => {
    const zero = { all: 0, stockout: 0, critical: 0, low: 0 };
    expect(countByStatus([])).toEqual(zero);
    expect(countByStatus([sku("a", "healthy")])).toEqual(zero);
  });
});

describe("selectActionRows", () => {
  it("orders by severity, then by soonest to run out", () => {
    const ids = selectActionRows(CATALOGUE, "all", 99).map((r) => r.id);
    expect(ids).toEqual(["out1", "out2", "crit1", "low1", "low2"]);
  });

  it("never includes a healthy SKU", () => {
    const ids = selectActionRows(CATALOGUE, "all", 99).map((r) => r.id);
    expect(ids).not.toContain("fine1");
  });

  it("sorts no-demand SKUs last within their severity", () => {
    // A SKU with no sales has no runway; treating null as 0 would put it above one that
    // genuinely runs out in two days.
    const rows = selectActionRows(
      [sku("nodemand", "low", null), sku("urgent", "low", 2)],
      "all",
      99,
    );
    expect(rows.map((r) => r.id)).toEqual(["urgent", "nodemand"]);
  });

  it.each([
    ["stockout", ["out1", "out2"]],
    ["critical", ["crit1"]],
    ["low", ["low1", "low2"]],
  ] as [ActionFilter, string[]][])("filter %s selects only that severity", (filter, expected) => {
    expect(selectActionRows(CATALOGUE, filter, 99).map((r) => r.id)).toEqual(expected);
  });

  it("pages without changing the order", () => {
    expect(selectActionRows(CATALOGUE, "all", 3).map((r) => r.id)).toEqual([
      "out1",
      "out2",
      "crit1",
    ]);
  });

  it("agrees with the chip counts for every filter", () => {
    // The invariant this module exists to protect: what a chip claims and what selecting
    // it produces must be the same number, at any catalogue size.
    const counts = countByStatus(CATALOGUE);
    for (const filter of ["all", "stockout", "critical", "low"] as const) {
      expect(selectActionRows(CATALOGUE, filter, Infinity)).toHaveLength(counts[filter]);
    }
  });

  it("still agrees when the page is smaller than the result set", () => {
    // Paging must not change what the counts mean — only how many rows are shown.
    const counts = countByStatus(CATALOGUE);
    const rows = selectActionRows(CATALOGUE, "stockout", 1);
    expect(rows).toHaveLength(1);
    expect(counts.stockout).toBe(2);
  });

  it("returns nothing for a filter with no matches", () => {
    expect(selectActionRows([sku("a", "low")], "stockout", 99)).toEqual([]);
  });
});
