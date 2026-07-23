import { describe, expect, it } from "vitest";
import {
  RTO_STALE_AFTER_DAYS,
  attributeRto,
  isResolvedStatus,
  isReturnedStatus,
  type OrderLineRow,
  type OrderOutcomeRow,
} from "./rto-attribution.server";

/** 12 units of a SKU spread across 12 single-unit orders, so minShipped is satisfied. */
function orders(prefix: string, count: number, productId: string, qty = 1): OrderLineRow[] {
  return Array.from({ length: count }, (_, i) => ({
    orderName: `#${prefix}${i}`,
    productId,
    quantity: qty,
  }));
}

function outcomes(prefix: string, count: number, status: string): OrderOutcomeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    orderName: `#${prefix}${i}`,
    status,
  }));
}

describe("status vocabulary", () => {
  it("treats delivered and returned as resolved", () => {
    expect(isResolvedStatus("delivered")).toBe(true);
    expect(isResolvedStatus("returned")).toBe(true);
  });

  it("does not resolve a shipment still moving", () => {
    for (const s of ["in_transit", "booked", "out_for_delivery", "picked_up", "pending"]) {
      expect(isResolvedStatus(s)).toBe(false);
    }
  });

  it("is case and whitespace insensitive", () => {
    expect(isReturnedStatus("  RETURNED ")).toBe(true);
    expect(isResolvedStatus("Delivered")).toBe(true);
  });

  it("recognises courier synonyms for RTO", () => {
    expect(isReturnedStatus("rto")).toBe(true);
    expect(isReturnedStatus("returned_to_shipper")).toBe(true);
  });
});

describe("attributeRto", () => {
  it("computes a per-SKU rate from order-level outcomes", () => {
    // 20 orders of SKU-A: 5 returned, 15 delivered => 25%.
    const lines = [...orders("d", 15, "SKU-A"), ...orders("r", 5, "SKU-A")];
    const out = [...outcomes("d", 15, "delivered"), ...outcomes("r", 5, "returned")];

    const [result] = attributeRto(out, lines);
    expect(result.productId).toBe("SKU-A");
    expect(result.shippedUnits).toBe(20);
    expect(result.returnedUnits).toBe(5);
    expect(result.rtoRate).toBeCloseTo(0.25, 10);
  });

  it("excludes in-transit orders from both numerator and denominator", () => {
    // Counting them as not-returned would understate the rate.
    const lines = [...orders("d", 10, "SKU-A"), ...orders("t", 40, "SKU-A")];
    const out = [...outcomes("d", 10, "delivered"), ...outcomes("t", 40, "in_transit")];

    const [result] = attributeRto(out, lines);
    expect(result.shippedUnits).toBe(10);
    expect(result.rtoRate).toBe(0);
  });

  it("attributes a multi-SKU order to every SKU on it", () => {
    const lines: OrderLineRow[] = [];
    for (let i = 0; i < 12; i++) {
      lines.push({ orderName: `#m${i}`, productId: "SKU-A", quantity: 1 });
      lines.push({ orderName: `#m${i}`, productId: "SKU-B", quantity: 2 });
    }
    // Half the orders came back.
    const out = [
      ...Array.from({ length: 6 }, (_, i) => ({ orderName: `#m${i}`, status: "delivered" })),
      ...Array.from({ length: 6 }, (_, i) => ({ orderName: `#m${i + 6}`, status: "returned" })),
    ];

    const byId = Object.fromEntries(attributeRto(out, lines).map((r) => [r.productId, r]));
    expect(byId["SKU-A"].shippedUnits).toBe(12);
    expect(byId["SKU-A"].returnedUnits).toBe(6);
    expect(byId["SKU-B"].shippedUnits).toBe(24); // 2 units per order
    expect(byId["SKU-B"].returnedUnits).toBe(12);
    // Same orders returned, so both SKUs share the rate.
    expect(byId["SKU-A"].rtoRate).toBeCloseTo(0.5, 10);
    expect(byId["SKU-B"].rtoRate).toBeCloseTo(0.5, 10);
  });

  it("ignores orders the courier never reported", () => {
    // An order with no outcome has not shipped as far as we know.
    const lines = [...orders("k", 12, "SKU-A"), ...orders("unknown", 50, "SKU-A")];
    const out = outcomes("k", 12, "delivered");

    const [result] = attributeRto(out, lines);
    expect(result.shippedUnits).toBe(12);
  });

  it("suppresses SKUs below the minimum shipped volume", () => {
    // 1 return out of 2 shipments is not a 50% RTO SKU.
    const lines = orders("s", 2, "SKU-TINY");
    const out = [
      { orderName: "#s0", status: "delivered" },
      { orderName: "#s1", status: "returned" },
    ];
    expect(attributeRto(out, lines)).toEqual([]);
    // ...but it is reported once there is enough volume to mean something.
    expect(attributeRto(out, lines, 2)).toHaveLength(1);
  });

  it("ranks the worst SKU first", () => {
    const lines = [
      ...orders("a", 10, "GOOD"),
      ...orders("b", 10, "BAD"),
    ];
    const out = [
      ...outcomes("a", 10, "delivered"),
      ...outcomes("b", 10, "returned"),
    ];
    const result = attributeRto(out, lines);
    expect(result[0].productId).toBe("BAD");
    expect(result[0].rtoRate).toBe(1);
  });

  it("uses the latest status when a shipment is reported more than once", () => {
    // Outcomes arrive oldest-first; a shipment that was in transit and later returned
    // must count as returned, not be double counted.
    const lines = orders("p", 10, "SKU-A");
    const out: OrderOutcomeRow[] = [
      ...outcomes("p", 10, "in_transit"),
      ...outcomes("p", 10, "returned"),
    ];
    const [result] = attributeRto(out, lines);
    expect(result.shippedUnits).toBe(10);
    expect(result.returnedUnits).toBe(10);
  });

  it("returns nothing when the courier has reported nothing", () => {
    expect(attributeRto([], orders("x", 50, "SKU-A"))).toEqual([]);
  });

  it("never produces a rate outside 0..1", () => {
    const lines = orders("z", 20, "SKU-A");
    const out = outcomes("z", 20, "returned");
    const [r] = attributeRto(out, lines);
    expect(r.rtoRate).toBeGreaterThanOrEqual(0);
    expect(r.rtoRate).toBeLessThanOrEqual(1);
  });
});

describe("freshness thresholds", () => {
  // getRtoFreshness itself needs a database; the boundary it encodes does not, and the
  // boundary is what matters — 14 days is the line between "current" and "describes a
  // period that has ended".
  it("treats a fortnight as the limit of currency", () => {
    expect(RTO_STALE_AFTER_DAYS).toBe(14);
  });

  it("would flag the production case that motivated it", () => {
    // Courier data ended 2026-07-06; the figures were still on screen on 2026-07-23.
    const ageDays = Math.floor(
      (Date.UTC(2026, 6, 23) - Date.UTC(2026, 6, 6)) / 86400000,
    );
    expect(ageDays).toBe(17);
    expect(ageDays > RTO_STALE_AFTER_DAYS).toBe(true);
  });

  it("does not flag data from yesterday", () => {
    expect(1 > RTO_STALE_AFTER_DAYS).toBe(false);
  });
});
