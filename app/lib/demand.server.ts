/**
 * Demand estimation.
 *
 * The previous model was a single weighted moving average: (30d avg × 2 + 60d avg) / 3,
 * implemented twice in two files that were free to drift apart. It had no trend term, no
 * outlier handling, and — most damagingly for this catalogue shape — it was applied to
 * intermittent SKUs, where a moving average over mostly-zero days is badly biased.
 *
 * This module is the single source of truth for "how much does this SKU sell per day".
 * Everything is pure and synchronous so it can be unit-tested without a database.
 */

export interface DailyPoint {
  date: Date;
  quantity: number;
}

export type DemandMethod = "croston" | "sba" | "damped_trend" | "moving_average";

export interface DemandEstimate {
  /** Expected units per day going forward. */
  dailyRate: number;
  method: DemandMethod;
  /** Std deviation of daily demand, used for safety stock. */
  demandStdDev: number;
  /**
   * Std deviation of one-step-ahead forecast error from a walk-forward backtest.
   * This — not raw demand variance — is what a prediction interval is built from.
   * Null when there is too little history to backtest.
   */
  residualStdDev: number | null;
  /** Days of actual history the estimate is based on. */
  observedDays: number;
  /** Share of days with no sales. */
  zeroShare: number;
}

const DAY_MS = 86400000;

/** UTC midnight of `d`. */
function dayStart(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

/**
 * Expand sparse sales rows into a dense day-by-day series.
 *
 * `start` matters: padding a SKU back to a fixed 90 days invents zero-demand days for a
 * period it did not exist, which deflates its average and inflates its variance (and so
 * its safety stock). Callers pass the later of "window start" and "first ever sold".
 */
export function densify(records: DailyPoint[], start: Date, end: Date): number[] {
  const from = dayStart(start).getTime();
  const to = dayStart(end).getTime();
  if (to < from) return [];

  const len = Math.floor((to - from) / DAY_MS) + 1;
  const series = new Array<number>(len).fill(0);

  for (const r of records) {
    const idx = Math.floor((dayStart(r.date).getTime() - from) / DAY_MS);
    if (idx >= 0 && idx < len) series[idx] += r.quantity;
  }
  return series;
}

/** Median of a numeric array (does not mutate the input). */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/**
 * Clamp extreme days to a robust upper bound (median + k × MAD-based sigma).
 *
 * One viral day or a single wholesale order otherwise permanently lifts both the mean
 * and the standard deviation, so the SKU is over-bought for months afterwards. MAD is
 * used rather than the standard deviation because the standard deviation is itself
 * corrupted by the very outlier being detected. Only the upper tail is clamped: real
 * zero-demand days are information, not noise.
 */
export function winsorize(series: number[], k = 4): number[] {
  if (series.length < 8) return [...series];
  const med = median(series);
  const mad = median(series.map((v) => Math.abs(v - med)));
  // 1.4826 rescales MAD to a sigma estimate for normal data.
  const sigma = mad * 1.4826;
  if (sigma <= 0) return [...series];
  const cap = med + k * sigma;
  return series.map((v) => (v > cap ? cap : v));
}

/** Mean of a numeric array. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Population standard deviation. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/**
 * Average demand interval — mean gap between non-zero demand days. The standard
 * Syntetos-Boylan cutoff of 1.32 separates intermittent demand (where Croston-type
 * methods win) from continuous demand.
 */
export function averageDemandInterval(series: number[]): number {
  const nonZeroIdx = series.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  if (nonZeroIdx.length <= 1) return series.length || 1;
  const gaps: number[] = [];
  for (let i = 1; i < nonZeroIdx.length; i++) gaps.push(nonZeroIdx[i] - nonZeroIdx[i - 1]);
  return mean(gaps);
}

/**
 * Croston's method with the Syntetos-Boylan bias correction (SBA).
 *
 * Croston tracks demand size and the interval between demands separately, so the
 * estimate does not decay towards zero on the long runs of empty days that dominate a
 * long-tail catalogue. Plain Croston is known to be biased high; SBA multiplies by
 * (1 - alpha/2) to correct it, which is why `sba` is the default.
 */
export function crostonRate(
  series: number[],
  alpha = 0.1,
  biasCorrected = true,
): number {
  const firstIdx = series.findIndex((v) => v > 0);
  if (firstIdx === -1) return 0;

  // Initialise from the whole series rather than from the first observation.
  //
  // Textbook Croston seeds interval = 1 and lets smoothing find the true gap, but with
  // alpha = 0.1 that takes ~40 demand events to converge. Our series are 90 days long,
  // so a slow-moving SKU never gets there and its rate comes out badly overstated
  // (a 5-day cycle was estimating ~2.6/day against a true 2.0/day). Seeding with the
  // observed mean size and mean interval starts the recursion at the right place.
  const nonZero = series.filter((v) => v > 0);
  let size = mean(nonZero);
  let interval = Math.max(1, averageDemandInterval(series));
  let sinceLast = 0;

  for (let t = firstIdx + 1; t < series.length; t++) {
    sinceLast++;
    if (series[t] > 0) {
      size += alpha * (series[t] - size);
      interval += alpha * (sinceLast - interval);
      sinceLast = 0;
    }
  }

  if (interval <= 0) return 0;
  const rate = size / interval;
  return biasCorrected ? rate * (1 - alpha / 2) : rate;
}

/**
 * Holt's linear trend with damping.
 *
 * Damping (phi < 1) stops a short-run trend being extrapolated indefinitely, which is
 * what makes plain Holt dangerous for purchasing decisions: three good weeks should not
 * imply three good months.
 */
export function dampedTrendRate(
  series: number[],
  alpha = 0.3,
  beta = 0.1,
  phi = 0.85,
): number {
  if (series.length === 0) return 0;
  if (series.length < 3) return mean(series);

  let level = series[0];
  let trend = series[1] - series[0];

  for (let t = 1; t < series.length; t++) {
    const prevLevel = level;
    level = alpha * series[t] + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - prevLevel) + (1 - beta) * phi * trend;
  }

  // One-step-ahead expectation, floored at zero — demand cannot be negative.
  return Math.max(0, level + phi * trend);
}

/** The legacy 2:1 recency-weighted average, kept as the small-sample fallback. */
export function weightedAvgDailySales(records: DailyPoint[]): number {
  const now = Date.now();
  const cutoff30 = now - 30 * DAY_MS;
  const cutoff90 = now - 90 * DAY_MS;

  let recent = 0;
  let older = 0;
  for (const r of records) {
    const t = r.date.getTime();
    if (t >= cutoff30) recent += r.quantity;
    else if (t >= cutoff90) older += r.quantity;
  }
  return (recent / 30) * (2 / 3) + (older / 60) * (1 / 3);
}

/**
 * Walk-forward backtest: refit on everything before each point and score the one-step
 * error. Gives an honest residual spread for prediction intervals, instead of the old
 * "confidence" number that was just a function of how many rows existed.
 */
function backtestResidualStdDev(
  series: number[],
  estimator: (window: number[]) => number,
  minTrain = 14,
): number | null {
  if (series.length < minTrain + 7) return null;
  const residuals: number[] = [];
  for (let t = minTrain; t < series.length; t++) {
    const predicted = estimator(series.slice(0, t));
    residuals.push(series[t] - predicted);
  }
  if (residuals.length < 5) return null;
  return stdDev(residuals);
}

/**
 * Pick a method from the shape of the series and estimate the forward daily rate.
 *
 * Selection is deliberately rule-based rather than "try everything and keep the best
 * in-sample fit", which overfits badly on short, noisy retail series.
 */
export function estimateDemand(
  records: DailyPoint[],
  opts: { windowStart: Date; windowEnd?: Date; firstSoldAt?: Date | null } = {
    windowStart: new Date(Date.now() - 90 * DAY_MS),
  },
): DemandEstimate {
  const end = opts.windowEnd ?? new Date();
  // Never pad back further than the SKU has actually existed.
  const start =
    opts.firstSoldAt && opts.firstSoldAt > opts.windowStart
      ? opts.firstSoldAt
      : opts.windowStart;

  const raw = densify(records, start, end);
  const observedDays = raw.length;

  if (observedDays === 0 || raw.every((v) => v === 0)) {
    return {
      dailyRate: 0,
      method: "moving_average",
      demandStdDev: 0,
      residualStdDev: null,
      observedDays,
      zeroShare: 1,
    };
  }

  const series = winsorize(raw);
  const zeroShare = series.filter((v) => v === 0).length / series.length;
  const adi = averageDemandInterval(series);

  // Too little history to do anything clever with.
  if (observedDays < 14) {
    const rate = mean(series);
    return {
      dailyRate: rate,
      method: "moving_average",
      demandStdDev: stdDev(series),
      residualStdDev: null,
      observedDays,
      zeroShare,
    };
  }

  const intermittent = adi > 1.32 || zeroShare > 0.5;

  let method: DemandMethod;
  let estimator: (w: number[]) => number;
  if (intermittent) {
    method = "sba";
    estimator = (w) => crostonRate(w);
  } else {
    method = "damped_trend";
    estimator = (w) => dampedTrendRate(w);
  }

  const dailyRate = Math.max(0, estimator(series));

  return {
    dailyRate,
    method,
    demandStdDev: stdDev(series),
    residualStdDev: backtestResidualStdDev(series, estimator),
    observedDays,
    zeroShare,
  };
}
