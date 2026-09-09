import { describe, expect, it } from "vitest";
import {
  MIN_SPARKLINE_DAYS,
  dayKey,
  densify,
  toPolyline,
  toSeries,
  utcDayStart,
} from "./sparklines";

/** Fixed "now" so day arithmetic is deterministic regardless of when the suite runs. */
const NOW = new Date("2026-09-09T13:45:00.000Z");

/** Map of {daysAgo: value} to the {dayKey: value} shape densify expects. */
const byDaysAgo = (entries: Record<number, number>) =>
  new Map(
    Object.entries(entries).map(([daysAgo, v]) => [
      dayKey(utcDayStart(Number(daysAgo), NOW)),
      v,
    ]),
  );

describe("utcDayStart", () => {
  it("truncates to midnight UTC", () => {
    expect(utcDayStart(0, NOW).toISOString()).toBe("2026-09-09T00:00:00.000Z");
  });

  it("walks back whole days, crossing a month boundary", () => {
    expect(utcDayStart(10, NOW).toISOString()).toBe("2026-08-30T00:00:00.000Z");
  });

  it("is unaffected by the time of day", () => {
    const lateEvening = new Date("2026-09-09T23:59:59.999Z");
    expect(utcDayStart(0, lateEvening)).toEqual(utcDayStart(0, NOW));
  });
});

describe("densify", () => {
  it("returns one point per day, oldest first", () => {
    const points = densify(byDaysAgo({ 0: 5 }), 7, { carryForward: false }, NOW);
    expect(points).toHaveLength(7);
    expect(points.at(-1)).toBe(5);
  });

  it("treats a missing sales day as a real zero", () => {
    const points = densify(byDaysAgo({ 2: 4, 0: 6 }), 3, { carryForward: false }, NOW);
    expect(points).toEqual([4, 0, 6]);
  });

  it("carries a snapshot value across a gap rather than dropping to zero", () => {
    // The cron missing a run must not read as capital falling to nothing and recovering.
    const points = densify(byDaysAgo({ 2: 1000, 0: 1200 }), 3, { carryForward: true }, NOW);
    expect(points).toEqual([1000, 1000, 1200]);
  });

  it("carries forward zero before the first reading, since there is nothing to repeat", () => {
    const points = densify(byDaysAgo({ 0: 900 }), 3, { carryForward: true }, NOW);
    expect(points).toEqual([0, 0, 900]);
  });

  it("ignores rows outside the window", () => {
    const points = densify(byDaysAgo({ 99: 42, 0: 7 }), 3, { carryForward: false }, NOW);
    expect(points).toEqual([0, 0, 7]);
  });
});

describe("toSeries", () => {
  const full = (v: number) => Array.from({ length: 20 }, () => v);

  it("suppresses a series with too little observed history", () => {
    expect(toSeries(full(1), MIN_SPARKLINE_DAYS - 1)).toBeNull();
  });

  it("shows a series exactly at the threshold", () => {
    expect(toSeries(full(1), MIN_SPARKLINE_DAYS)).not.toBeNull();
  });

  it("judges history by observed days, not by the padded window length", () => {
    // densify always returns a full window; a shop with 3 real days must stay hidden.
    expect(toSeries(full(1), 3)).toBeNull();
  });

  it("computes half-over-half change", () => {
    const points = [...Array(5).fill(10), ...Array(5).fill(15)];
    expect(toSeries(points, 10)?.changePct).toBeCloseTo(50);
  });

  it("reports a decline as negative", () => {
    const points = [...Array(5).fill(20), ...Array(5).fill(10)];
    expect(toSeries(points, 10)?.changePct).toBeCloseTo(-50);
  });

  it("returns null change when the earlier half is zero", () => {
    // A shop's first sale is not a +100% trend.
    const points = [...Array(5).fill(0), ...Array(5).fill(9)];
    expect(toSeries(points, 10)?.changePct).toBeNull();
  });

  it("reports no change as zero, not null", () => {
    expect(toSeries(full(7), 10)?.changePct).toBeCloseTo(0);
  });
});

describe("toPolyline", () => {
  it("spans the full width and stays within the box", () => {
    const out = toPolyline([1, 5, 3], 60, 20);
    const coords = out.split(" ").map((p) => p.split(",").map(Number));
    expect(coords[0][0]).toBe(0);
    expect(coords.at(-1)![0]).toBe(60);
    for (const [, y] of coords) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(20);
    }
  });

  it("puts the maximum above the minimum on screen", () => {
    // SVG y grows downward, so a larger value must have a smaller y.
    const [first, second] = toPolyline([1, 9], 60, 20)
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    expect(second).toBeLessThan(first);
  });

  it("draws a flat series through the middle, not along the baseline", () => {
    // Pinning min === max to the bottom makes "unchanged" look like "collapsed to zero".
    const ys = toPolyline([4, 4, 4], 60, 20)
      .split(" ")
      .map((p) => Number(p.split(",")[1]));
    expect(ys.every((y) => y === 10)).toBe(true);
  });

  it("handles a single point without dividing by zero", () => {
    expect(toPolyline([3], 60, 20)).toBe("0,10.0 60,10.0");
  });

  it("returns an empty string for no points", () => {
    expect(toPolyline([], 60, 20)).toBe("");
  });
});
