import { describe, expect, it } from "vitest";
import {
  overviewStatus,
  selectOverviewRows,
  summarise,
  toOverviewRow,
  type OverviewInput,
} from "./inventory-overview";

const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  id: "p1",
  onHand: 100,
  unbooked: 0,
  damaged: 0,
  incoming: 0,
  incomingCost: 0,
  unitCost: 10,
  price: 25,
  avgDailySales: 2,
  planningStatus: "healthy",
  deadStock: false,
  ...over,
});

describe("overviewStatus", () => {
  it("calls a SKU out of stock when nothing is available, even with a PO on its way", () => {
    // Planning counts the PO as supply and would say healthy; the merchant cannot sell it today.
    expect(overviewStatus(0, { planningStatus: "healthy", deadStock: false })).toBe("out");
  });

  it("folds the planning rule's low and critical into Low", () => {
    expect(overviewStatus(5, { planningStatus: "low", deadStock: false })).toBe("low");
    expect(overviewStatus(5, { planningStatus: "critical", deadStock: false })).toBe("low");
  });

  it("ranks low above slow, and slow above healthy", () => {
    expect(overviewStatus(5, { planningStatus: "low", deadStock: true })).toBe("low");
    expect(overviewStatus(50, { planningStatus: "healthy", deadStock: true })).toBe("slow");
    expect(overviewStatus(50, { planningStatus: "healthy", deadStock: false })).toBe("healthy");
  });
});

describe("toOverviewRow", () => {
  it("derives available, value, margin and runway", () => {
    const r = toOverviewRow(input({ unbooked: 10 }));
    expect(r.available).toBe(90);
    expect(r.atCost).toBe(1000);
    expect(r.atRetail).toBe(2500);
    expect(r.marginPct).toBeCloseTo(0.6);
    expect(r.daysLeft).toBe(45);
  });

  it("leaves retail and margin unknown for an unpriced SKU rather than zero", () => {
    const r = toOverviewRow(input({ price: null }));
    expect(r.atRetail).toBeNull();
    expect(r.marginPct).toBeNull();
  });

  it("has no runway figure for a SKU that is not selling", () => {
    expect(toOverviewRow(input({ avgDailySales: 0 })).daysLeft).toBeNull();
  });

  it("does not value oversold (negative) stock", () => {
    const r = toOverviewRow(input({ onHand: -4 }));
    expect(r.atCost).toBe(0);
    expect(r.status).toBe("out");
  });
});

describe("summarise", () => {
  it("compares retail with cost over the same priced SKUs only", () => {
    const t = summarise([
      toOverviewRow(input({ id: "a", onHand: 10, unitCost: 10, price: 20 })),
      toOverviewRow(input({ id: "b", onHand: 10, unitCost: 50, price: null })),
    ]);
    expect(t.atCost).toBe(600);
    expect(t.atRetail).toBe(200);
    expect(t.pricedAtCost).toBe(100);
    expect(t.pricedSkus).toBe(1);
  });

  it("does not let one SKU's oversell cancel another's available units", () => {
    const t = summarise([
      toOverviewRow(input({ id: "a", onHand: 2, unbooked: 5 })),
      toOverviewRow(input({ id: "b", onHand: 10, unbooked: 0 })),
    ]);
    expect(t.available).toBe(10);
    expect(t.unbooked).toBe(5);
    expect(t.counts.out).toBe(1);
  });

  it("values unbooked units at selling price for the order value", () => {
    const t = summarise([toOverviewRow(input({ unbooked: 3, price: 25 }))]);
    expect(t.unbookedRetail).toBe(75);
    expect(t.unbookedCost).toBe(30);
  });
});

describe("selectOverviewRows", () => {
  const rows = [
    toOverviewRow(input({ id: "a", onHand: 10, unitCost: 10, avgDailySales: 1 })),
    toOverviewRow(input({ id: "b", onHand: 50, unitCost: 10, avgDailySales: 0 })),
    toOverviewRow(input({ id: "c", onHand: 0 })),
    toOverviewRow(input({ id: "d", onHand: 30, unitCost: 10, avgDailySales: 10, planningStatus: "low" })),
  ];

  it("filters by status and reports the full match count", () => {
    const res = selectOverviewRows(rows, "out", "value", 25);
    expect(res.rows.map((r) => r.id)).toEqual(["c"]);
    expect(res.matched).toBe(1);
  });

  it("sorts by stock value by default and truncates after counting", () => {
    const res = selectOverviewRows(rows, "all", "value", 2);
    expect(res.rows.map((r) => r.id)).toEqual(["b", "d"]);
    expect(res.matched).toBe(4);
  });

  it("puts SKUs with no runway last when sorting by days left", () => {
    const res = selectOverviewRows(rows, "all", "days", 25);
    expect(res.rows.map((r) => r.id)).toEqual(["c", "d", "a", "b"]);
  });
});
