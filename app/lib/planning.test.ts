import { describe, expect, it } from "vitest";
import {
  classifyAbc,
  classifyXyz,
  computeProcurementPlan,
  resolveReturnRate,
  serviceLevelZFor,
  type ProcurementInput,
} from "./planning.server";
import { updateLeadTimeStats } from "./lead-time.server";
import { calculateReorderPoint, forecastDemand, getStockStatus } from "./forecast.server";
import { calculateSafetyStock } from "./safety-stock.server";

const base: ProcurementInput = {
  shipUnits: 300,
  returnRate: 0,
  restockRate: 0.75,
  position: 0,
  safetyStock: 0,
  moq: 1,
  casePackSize: 1,
};

describe("computeProcurementPlan", () => {
  it("buys the gross shipping requirement when nothing comes back", () => {
    expect(computeProcurementPlan(base).orderQty).toBe(300);
  });

  it("credits sellable RTO units as supply rather than cutting demand", () => {
    // 300 ship, 30% RTO, 75% of those resellable => 67 units come back.
    const plan = computeProcurementPlan({ ...base, returnRate: 0.3 });
    expect(plan.expectedReturnsSellable).toBe(67);
    expect(plan.orderQty).toBe(233);
  });

  it("never plans on net demand — a 35% RTO rate must not cut the buy by 35%", () => {
    // The old model computed 300 * (1 - 0.35) = 195 and called that the plan.
    const plan = computeProcurementPlan({ ...base, returnRate: 0.35, restockRate: 0 });
    // With nothing resellable, the full gross requirement still has to be bought.
    expect(plan.orderQty).toBe(300);
    expect(plan.orderQty).toBeGreaterThan(195);
  });

  it("subtracts stock already on order", () => {
    expect(computeProcurementPlan({ ...base, position: 120 }).orderQty).toBe(180);
  });

  it("orders nothing when inbound stock already covers demand", () => {
    const plan = computeProcurementPlan({ ...base, position: 400 });
    expect(plan.rawNeed).toBe(0);
    expect(plan.orderQty).toBe(0);
  });

  it("adds safety stock to the requirement", () => {
    expect(computeProcurementPlan({ ...base, safetyStock: 50 }).orderQty).toBe(350);
  });

  it("raises a small order to the supplier MOQ", () => {
    const plan = computeProcurementPlan({ ...base, shipUnits: 5, moq: 50 });
    expect(plan.rawNeed).toBe(5);
    expect(plan.orderQty).toBe(50);
    expect(plan.roundedUpTo).toBe("moq");
  });

  it("rounds up to whole case packs", () => {
    const plan = computeProcurementPlan({ ...base, shipUnits: 101, casePackSize: 12 });
    expect(plan.orderQty).toBe(108); // 9 cases
    expect(plan.orderQty % 12).toBe(0);
  });

  it("does not round a zero requirement up to the MOQ", () => {
    const plan = computeProcurementPlan({ ...base, position: 999, moq: 50 });
    expect(plan.orderQty).toBe(0);
  });
});

describe("resolveReturnRate", () => {
  it("prefers the courier's measured rate", () => {
    expect(
      resolveReturnRate({ courierRtoRate: 0.4, estimatedRtoRate: 0.1 }),
    ).toEqual({ rate: 0.4, source: "courierify" });
  });

  it("falls back to the local estimate", () => {
    expect(
      resolveReturnRate({ courierRtoRate: null, estimatedRtoRate: 0.22 }),
    ).toEqual({ rate: 0.22, source: "estimated" });
  });

  it("reports absence rather than guessing", () => {
    expect(
      resolveReturnRate({ courierRtoRate: null, estimatedRtoRate: null }),
    ).toEqual({ rate: 0, source: "none" });
  });

  it("clamps out-of-range values", () => {
    expect(resolveReturnRate({ courierRtoRate: 1.4, estimatedRtoRate: null }).rate).toBe(1);
    expect(resolveReturnRate({ courierRtoRate: -1, estimatedRtoRate: null }).rate).toBe(0);
  });
});

describe("calculateReorderPoint", () => {
  it("covers demand across the lead time plus safety stock", () => {
    expect(calculateReorderPoint(10, 7, 25)).toBe(95);
  });

  it("lifts the reorder point during a demand peak", () => {
    const normal = calculateReorderPoint(10, 7, 0);
    const eid = calculateReorderPoint(10, 7, 0, 2.0);
    expect(eid).toBe(normal * 2);
  });

  it("lifts it again when the peak also stretches lead times", () => {
    const normal = calculateReorderPoint(10, 7, 0);
    const stretched = calculateReorderPoint(10, 7, 0, 1.0, 1.5);
    expect(stretched).toBeGreaterThan(normal);
  });

  it("is just safety stock for a SKU with no demand", () => {
    expect(calculateReorderPoint(0, 7, 12)).toBe(12);
  });
});

describe("getStockStatus", () => {
  it("uses the position it is given, so on-order stock clears the flag", () => {
    // 5 on hand against a reorder point of 100 is critical...
    expect(getStockStatus(5, 100)).toBe("critical");
    // ...but not once a 300-unit PO is in flight.
    expect(getStockStatus(305, 100)).toBe("healthy");
  });

  it("reports stockout only at or below zero", () => {
    expect(getStockStatus(0, 50)).toBe("stockout");
    expect(getStockStatus(-3, 50)).toBe("stockout");
  });

  it("does not call a SKU low when it has no reorder point", () => {
    expect(getStockStatus(4, 0)).toBe("healthy");
  });
});

describe("forecastDemand", () => {
  it("keeps ship, delivered and procurement units distinct", () => {
    const f = forecastDemand(10, 30, 0.3, 0, 1, { restockRate: 0.5 });
    expect(f.grossDemand).toBe(300); // what must ship
    expect(f.netDemand).toBe(210); // what customers keep
    expect(f.expectedReturnsSellable).toBe(45);
    expect(f.procurementUnits).toBe(255); // what to buy
  });

  it("applies the seasonal multiplier to the shipping requirement", () => {
    expect(forecastDemand(10, 30, 0, 0, 1.5).grossDemand).toBe(450);
  });

  it("widens the interval with the horizon", () => {
    const short = forecastDemand(10, 30, 0, 0, 1, { residualStdDev: 3 });
    const long = forecastDemand(10, 90, 0, 0, 1, { residualStdDev: 3 });
    expect(long.pi80High - long.pi80Low).toBeGreaterThan(short.pi80High - short.pi80Low);
  });

  it("does not report high confidence from thin history", () => {
    const thin = forecastDemand(10, 30, 0, 0, 1, { observedDays: 5, residualStdDev: 2 });
    const rich = forecastDemand(10, 30, 0, 0, 1, { observedDays: 90, residualStdDev: 2 });
    expect(thin.confidence).toBeLessThan(rich.confidence);
  });

  it("never returns a negative interval bound", () => {
    const f = forecastDemand(1, 30, 0, 0, 1, { residualStdDev: 50 });
    expect(f.pi80Low).toBeGreaterThanOrEqual(0);
  });
});

describe("calculateSafetyStock", () => {
  it("grows with the service level", () => {
    const p90 = calculateSafetyStock(1.28, 5, 7, 10);
    const p98 = calculateSafetyStock(2.05, 5, 7, 10);
    expect(p98).toBeGreaterThan(p90);
  });

  it("charges for supplier unreliability", () => {
    const reliable = calculateSafetyStock(1.65, 5, 7, 10, 0);
    const erratic = calculateSafetyStock(1.65, 5, 7, 10, 3);
    expect(erratic).toBeGreaterThan(reliable);
  });

  it("is zero when demand is perfectly predictable and supply is reliable", () => {
    expect(calculateSafetyStock(1.65, 0, 7, 10, 0)).toBe(0);
  });
});

describe("updateLeadTimeStats", () => {
  it("converges to the true mean and sample standard deviation", () => {
    // Observations 4, 6, 8: mean 6, sample sd = 2.
    let stats = updateLeadTimeStats({ count: 0, mean: null, m2: 0 }, 4);
    stats = updateLeadTimeStats({ count: stats.count, mean: stats.mean, m2: stats.m2 }, 6);
    stats = updateLeadTimeStats({ count: stats.count, mean: stats.mean, m2: stats.m2 }, 8);

    expect(stats.count).toBe(3);
    expect(stats.mean).toBeCloseTo(6, 10);
    expect(stats.stdDev).toBeCloseTo(2, 10);
  });

  it("reports zero spread from a single observation rather than a fake one", () => {
    const stats = updateLeadTimeStats({ count: 0, mean: null, m2: 0 }, 9);
    expect(stats.mean).toBe(9);
    expect(stats.stdDev).toBe(0);
  });

  it("matches a batch computation over many observations", () => {
    const obs = [3, 9, 4, 12, 7, 5, 6, 20, 8, 4];
    let s = { count: 0, mean: null as number | null, m2: 0 };
    for (const o of obs) {
      const next = updateLeadTimeStats(s, o);
      s = { count: next.count, mean: next.mean, m2: next.m2 };
    }
    const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
    const sampleSd = Math.sqrt(
      obs.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (obs.length - 1),
    );
    expect(s.mean!).toBeCloseTo(mean, 10);
    expect(Math.sqrt(s.m2 / (obs.length - 1))).toBeCloseTo(sampleSd, 10);
  });
});

describe("ABC / XYZ classification", () => {
  it("puts the revenue leaders in A and the tail in C", () => {
    const classes = classifyAbc([
      { productId: "top", revenue: 800 },
      { productId: "mid", revenue: 150 },
      { productId: "tail", revenue: 50 },
    ]);
    expect(classes.get("top")).toBe("A");
    expect(classes.get("mid")).toBe("B");
    expect(classes.get("tail")).toBe("C");
  });

  it("classifies a dominant SKU as A, not C", () => {
    // Regression: classifying on the cumulative share *after* adding each item put any
    // product that alone exceeded 80% straight into C. The earlier test only used
    // revenues that landed exactly on the thresholds, so it passed either way.
    const classes = classifyAbc([
      { productId: "dominant", revenue: 99_000 },
      { productId: "small-1", revenue: 500 },
      { productId: "small-2", revenue: 500 },
    ]);
    expect(classes.get("dominant")).toBe("A");
    expect(classes.get("small-1")).toBe("C");
  });

  it("puts the single product in a one-product catalogue in A", () => {
    expect(classifyAbc([{ productId: "only", revenue: 1000 }]).get("only")).toBe("A");
  });

  it("treats a shop with no revenue data as all-C rather than all-A", () => {
    const classes = classifyAbc([
      { productId: "a", revenue: 0 },
      { productId: "b", revenue: 0 },
    ]);
    expect(classes.get("a")).toBe("C");
  });

  it("classifies variability by coefficient of variation", () => {
    expect(classifyXyz(0.2)).toBe("X");
    expect(classifyXyz(0.8)).toBe("Y");
    expect(classifyXyz(2.5)).toBe("Z");
  });

  it("holds a higher service level for A items than for the tail", () => {
    expect(serviceLevelZFor("A", 1.65)).toBeGreaterThan(serviceLevelZFor("C", 1.65));
    expect(serviceLevelZFor("B", 1.65)).toBe(1.65);
  });
});
