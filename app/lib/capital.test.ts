import { describe, expect, it } from "vitest";
import { computeCodFloat, computeStockAtRetail, estimateUnitPrice } from "./capital.server";

describe("estimateUnitPrice", () => {
  it("uses the synced Shopify price when there is one", () => {
    expect(estimateUnitPrice({ unitCost: 100, avgMargin: 0, price: 250 })).toBe(250);
  });

  it("falls back to the cost-and-margin estimate without a price", () => {
    expect(estimateUnitPrice({ unitCost: 100, avgMargin: 0.5, price: null })).toBe(200);
    expect(estimateUnitPrice({ unitCost: 100, avgMargin: 0, price: 0 })).toBe(100);
  });
});

describe("computeCodFloat", () => {
  it("values units with the courier at selling price", () => {
    const float = computeCodFloat([
      { currentStock: 0, unitCost: 100, avgMargin: 0, fulfilledInTransit: 3, price: 250 },
    ]);
    expect(float).toBe(750);
  });
});

describe("computeStockAtRetail", () => {
  it("skips unpriced SKUs and floors oversold stock", () => {
    expect(
      computeStockAtRetail([
        { currentStock: 4, price: 10 },
        { currentStock: 4, price: null },
        { currentStock: -2, price: 10 },
      ]),
    ).toBe(40);
  });
});
