import { describe, expect, it } from "vitest";
import { planRepair, reconstructDailySales } from "./sales-history-repair.server";

const V1 = "gid://shopify/ProductVariant/1";
const V2 = "gid://shopify/ProductVariant/2";
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`).getTime();

describe("reconstructDailySales", () => {
  it("sums live orders per variant per shop-local day", () => {
    const out = reconstructDailySales(
      [
        { orderName: "#1", productId: V1, quantity: 2, orderedAt: new Date("2026-07-01T10:00:00Z") },
        { orderName: "#2", productId: V1, quantity: 3, orderedAt: new Date("2026-07-01T12:00:00Z") },
        // 20:00 UTC is 01:00 the next day in Karachi.
        { orderName: "#3", productId: V1, quantity: 1, orderedAt: new Date("2026-07-01T20:00:00Z") },
        { orderName: "#4", productId: V2, quantity: 4, orderedAt: new Date("2026-07-01T10:00:00Z") },
      ],
      new Set(["#1", "#2", "#3", "#4"]),
      "Asia/Karachi",
    );
    expect(out.get(V1)?.get(day("2026-07-01"))).toBe(5);
    expect(out.get(V1)?.get(day("2026-07-02"))).toBe(1);
    expect(out.get(V2)?.get(day("2026-07-01"))).toBe(4);
  });

  it("skips cancelled orders and orders with no region row", () => {
    const out = reconstructDailySales(
      [
        { orderName: "#1", productId: V1, quantity: 2, orderedAt: new Date("2026-07-01T10:00:00Z") },
        { orderName: "#cancelled", productId: V1, quantity: 9, orderedAt: new Date("2026-07-01T10:00:00Z") },
      ],
      new Set(["#1"]),
      "UTC",
    );
    expect(out.get(V1)?.get(day("2026-07-01"))).toBe(2);
  });
});

describe("planRepair", () => {
  const reconstructed = new Map([
    [
      V1,
      new Map([
        [day("2026-06-10"), 2],
        [day("2026-06-11"), 3],
        [day("2026-06-12"), 4],
        [day("2026-08-01"), 5],
      ]),
    ],
  ]);

  it("restores only missing days older than the cutoff, and never overwrites", () => {
    const stored = new Map([[V1, new Map([[day("2026-06-11"), 3], [day("2026-06-12"), 7]])]]);
    const plan = planRepair(reconstructed, stored, new Date("2026-07-20T00:00:00Z"));

    expect(plan.restore).toEqual([{ productId: V1, date: new Date(day("2026-06-10")), quantity: 2 }]);
    expect(plan.presentDays).toBe(2);
    // 06-12 holds 7 against a reconstructed 4: reported, not changed.
    expect(plan.mismatchedDays).toBe(1);
  });

  it("restores nothing when nothing is missing", () => {
    const plan = planRepair(new Map(), new Map(), new Date());
    expect(plan.restore).toHaveLength(0);
  });
});
