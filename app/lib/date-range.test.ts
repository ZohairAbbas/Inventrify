import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE_DAYS,
  HISTORY_WINDOW_DAYS,
  MAX_RANGE_DAYS,
  previousRange,
  resolveDateRange,
} from "./date-range";

const NOW = new Date("2026-07-23T09:30:00.000Z");
const resolve = (qs: string) => resolveDateRange(new URLSearchParams(qs), NOW);

describe("presets", () => {
  it("defaults to 30 days when nothing is given", () => {
    const r = resolve("");
    expect(r.days).toBe(DEFAULT_RANGE_DAYS);
    expect(r.preset).toBe("30");
  });

  it("covers today, so the current day's sales are included", () => {
    // `to` is exclusive, so it must be tomorrow midnight rather than today's.
    expect(resolve("range=7").to.toISOString()).toBe("2026-07-24T00:00:00.000Z");
    expect(resolve("range=7").from.toISOString()).toBe("2026-07-17T00:00:00.000Z");
  });

  it("falls back rather than erroring on a nonsense preset", () => {
    for (const qs of ["range=abc", "range=-5", "range=45", "range="]) {
      expect(resolve(qs).days).toBe(DEFAULT_RANGE_DAYS);
    }
  });
});

describe("custom range", () => {
  it("spans both endpoints inclusively", () => {
    const r = resolve("from=2026-07-01&to=2026-07-07");
    expect(r.preset).toBe("custom");
    expect(r.days).toBe(7);
    expect(r.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // Exclusive end is the day after the last day shown.
    expect(r.to.toISOString()).toBe("2026-07-08T00:00:00.000Z");
    expect(r.label).toBe("2026-07-01 → 2026-07-07");
  });

  it("handles a single day", () => {
    const r = resolve("from=2026-07-05&to=2026-07-05");
    expect(r.days).toBe(1);
  });

  it("orders a reversed pair instead of rejecting it", () => {
    const r = resolve("from=2026-07-07&to=2026-07-01");
    expect(r.fromInput).toBe("2026-07-01");
    expect(r.toInput).toBe("2026-07-07");
  });

  it("never reports on the future", () => {
    // A range ending next month would dilute every per-day average with empty days.
    const r = resolve("from=2026-07-20&to=2026-12-31");
    expect(r.to.toISOString()).toBe("2026-07-24T00:00:00.000Z");
    expect(r.toInput).toBe("2026-07-23");
  });

  it("caps an absurd span", () => {
    const r = resolve("from=2000-01-01&to=2026-07-23");
    expect(r.days).toBeLessThanOrEqual(MAX_RANGE_DAYS);
  });

  it("flags a window reaching past retained history", () => {
    // Demand history only goes back 90 days, so a longer window is partial. Saying so
    // beats showing a truncated period as if it were complete.
    expect(resolve("from=2026-01-01&to=2026-07-23").exceedsHistory).toBe(true);
    expect(resolve("from=2026-07-01&to=2026-07-23").exceedsHistory).toBe(false);
    expect(HISTORY_WINDOW_DAYS).toBe(90);
  });

  it("ignores a half-specified custom range", () => {
    expect(resolve("from=2026-07-01").preset).toBe("30");
    expect(resolve("to=2026-07-07").preset).toBe("30");
  });

  it("ignores malformed dates", () => {
    expect(resolve("from=07-01-2026&to=2026-07-07").preset).toBe("30");
    expect(resolve("from=2026-13-45&to=2026-07-07").preset).toBe("30");
  });
});

describe("previousRange", () => {
  it("is the equal-length window immediately before", () => {
    const r = resolve("from=2026-07-08&to=2026-07-14"); // 7 days
    const p = previousRange(r);
    expect(p.to.toISOString()).toBe(r.from.toISOString());
    expect(p.from.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("matches the preset length too", () => {
    const r = resolve("range=30");
    const p = previousRange(r);
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 86400000)).toBe(30);
  });
});
