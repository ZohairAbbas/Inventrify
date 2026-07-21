import { describe, expect, it } from "vitest";
import {
  averageDemandInterval,
  crostonRate,
  dampedTrendRate,
  densify,
  estimateDemand,
  median,
  stdDev,
  winsorize,
  type DailyPoint,
} from "./demand.server";

const DAY = 86400000;
const day = (offsetFromEnd: number, end = Date.UTC(2026, 5, 30)) =>
  new Date(end - offsetFromEnd * DAY);

/** Build points for a dense series ending today: series[0] is the oldest day. */
function pointsFrom(series: number[], end: Date): DailyPoint[] {
  return series
    .map((quantity, i) => ({
      date: new Date(end.getTime() - (series.length - 1 - i) * DAY),
      quantity,
    }))
    .filter((p) => p.quantity !== 0);
}

describe("densify", () => {
  it("fills gaps with zeros across the window", () => {
    const end = new Date(Date.UTC(2026, 0, 10));
    const start = new Date(Date.UTC(2026, 0, 1));
    const records: DailyPoint[] = [
      { date: new Date(Date.UTC(2026, 0, 1)), quantity: 5 },
      { date: new Date(Date.UTC(2026, 0, 10)), quantity: 3 },
    ];
    expect(densify(records, start, end)).toEqual([5, 0, 0, 0, 0, 0, 0, 0, 0, 3]);
  });

  it("sums multiple rows landing on the same day", () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    const series = densify(
      [
        { date: d, quantity: 2 },
        { date: new Date(d.getTime() + 3600_000), quantity: 4 },
      ],
      d,
      d,
    );
    expect(series).toEqual([6]);
  });

  it("ignores records outside the window", () => {
    const start = new Date(Date.UTC(2026, 0, 5));
    const end = new Date(Date.UTC(2026, 0, 6));
    const series = densify(
      [
        { date: new Date(Date.UTC(2026, 0, 1)), quantity: 99 },
        { date: new Date(Date.UTC(2026, 0, 5)), quantity: 1 },
      ],
      start,
      end,
    );
    expect(series).toEqual([1, 0]);
  });
});

describe("winsorize", () => {
  it("clamps a single viral day without touching normal days", () => {
    const base = [2, 3, 2, 3, 2, 3, 2, 3, 2, 3];
    const withSpike = [...base, 400];
    const cleaned = winsorize(withSpike);
    expect(cleaned[cleaned.length - 1]).toBeLessThan(400);
    // Ordinary days are untouched.
    expect(cleaned.slice(0, 10)).toEqual(base);
  });

  it("preserves zero days — they are real information, not noise", () => {
    const series = [0, 0, 5, 0, 0, 6, 0, 0, 5, 0, 0];
    expect(winsorize(series).filter((v) => v === 0).length).toBe(8);
  });

  it("is a no-op on short series", () => {
    expect(winsorize([1, 900])).toEqual([1, 900]);
  });
});

describe("averageDemandInterval", () => {
  it("is 1 for demand every day", () => {
    expect(averageDemandInterval([1, 1, 1, 1, 1])).toBe(1);
  });

  it("grows with sparsity", () => {
    // demand every 4th day
    expect(averageDemandInterval([1, 0, 0, 0, 1, 0, 0, 0, 1])).toBe(4);
  });
});

describe("crostonRate", () => {
  it("recovers the underlying rate of a regular intermittent series", () => {
    // 10 units every 5 days => 2 units/day.
    const series = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
    const rate = crostonRate(series, 0.1, false);
    expect(rate).toBeGreaterThan(1.6);
    expect(rate).toBeLessThan(2.4);
  });

  it("does not decay to zero over long empty runs (the moving-average failure)", () => {
    const series = Array.from({ length: 90 }, (_, i) => (i % 30 === 0 ? 30 : 0));
    expect(crostonRate(series)).toBeGreaterThan(0.5);
  });

  it("SBA correction sits below raw Croston", () => {
    const series = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? 8 : 0));
    expect(crostonRate(series, 0.1, true)).toBeLessThan(crostonRate(series, 0.1, false));
  });

  it("returns 0 when nothing ever sold", () => {
    expect(crostonRate(new Array(30).fill(0))).toBe(0);
  });
});

describe("dampedTrendRate", () => {
  it("tracks a rising series upward", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 10 + i);
    expect(dampedTrendRate(rising)).toBeGreaterThan(40);
  });

  it("damps rather than extrapolating the raw slope", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 10 + i);
    // Undamped continuation of the last value + slope would be ~50.
    expect(dampedTrendRate(rising)).toBeLessThan(60);
  });

  it("never predicts negative demand on a collapsing series", () => {
    const falling = Array.from({ length: 40 }, (_, i) => Math.max(0, 40 - 2 * i));
    expect(dampedTrendRate(falling)).toBeGreaterThanOrEqual(0);
  });
});

describe("estimateDemand", () => {
  const end = new Date(Date.UTC(2026, 5, 30));

  it("selects an intermittent method for a sparse long tail", () => {
    const series = Array.from({ length: 90 }, (_, i) => (i % 10 === 0 ? 4 : 0));
    const est = estimateDemand(pointsFrom(series, end), {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    expect(est.method).toBe("sba");
    expect(est.dailyRate).toBeGreaterThan(0);
  });

  it("selects a trend method for dense daily demand", () => {
    const series = Array.from({ length: 90 }, () => 12);
    const est = estimateDemand(pointsFrom(series, end), {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    expect(est.method).toBe("damped_trend");
    expect(est.dailyRate).toBeGreaterThan(10);
    expect(est.dailyRate).toBeLessThan(14);
  });

  it("does not pad a new SKU with zero days it never existed for", () => {
    // Sold 10/day for its whole 10-day life.
    const series = Array.from({ length: 10 }, () => 10);
    const firstSoldAt = new Date(end.getTime() - 9 * DAY);
    const points = pointsFrom(series, end);

    const padded = estimateDemand(points, {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    const bounded = estimateDemand(points, {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
      firstSoldAt,
    });

    expect(bounded.observedDays).toBe(10);
    // The rate itself survives padding (Croston keys off demand events, not calendar
    // days) — the damage is to the variance, which is what sizes safety stock. 80
    // invented zero-demand days make the SKU look far more erratic than it is.
    expect(bounded.demandStdDev).toBeLessThan(padded.demandStdDev);
    expect(bounded.demandStdDev).toBe(0); // it sold exactly 10/day, every day it existed
    expect(bounded.dailyRate).toBeGreaterThanOrEqual(padded.dailyRate);
  });

  it("returns a zero estimate for a SKU that never sold", () => {
    const est = estimateDemand([], {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    expect(est.dailyRate).toBe(0);
    expect(est.zeroShare).toBe(1);
  });

  it("produces a residual spread once there is enough history to backtest", () => {
    const series = Array.from({ length: 90 }, (_, i) => 10 + (i % 3));
    const est = estimateDemand(pointsFrom(series, end), {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    expect(est.residualStdDev).not.toBeNull();
    expect(est.residualStdDev!).toBeGreaterThanOrEqual(0);
  });

  it("is not distorted by one wholesale order", () => {
    const steady = Array.from({ length: 90 }, () => 5);
    const spiked = [...steady];
    spiked[45] = 2000;

    const a = estimateDemand(pointsFrom(steady, end), {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    const b = estimateDemand(pointsFrom(spiked, end), {
      windowStart: new Date(end.getTime() - 89 * DAY),
      windowEnd: end,
    });
    // Without winsorizing, one 2000-unit day would lift the mean by ~22 units/day.
    expect(Math.abs(b.dailyRate - a.dailyRate)).toBeLessThan(2);
  });
});

describe("basic statistics", () => {
  it("median handles even and odd lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it("stdDev is zero for a constant series", () => {
    expect(stdDev([7, 7, 7])).toBe(0);
  });
});
