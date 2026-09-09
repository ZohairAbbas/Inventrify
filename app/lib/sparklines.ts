/**
 * Pure shaping for the dashboard's KPI sparklines. The queries that feed these live in
 * ./sparklines.server.ts; everything here is testable without a database.
 */

/**
 * Days of history a series needs before it is shown at all.
 *
 * A sparkline drawn through two points is not a trend, it is a line between two points,
 * and it reads as one either way. Shops sync hourly, so ten distinct days is roughly a
 * week and a half of real use — long enough that the shape means something. Below the
 * threshold the series is null and the card renders without a chart rather than with a
 * misleading one.
 */
export const MIN_SPARKLINE_DAYS = 10;

export type Series = {
  /** One value per day, oldest first. */
  points: number[];
  /**
   * Change from the first half of the window to the second, as a percentage. Null when
   * the earlier half is zero — there is no meaningful percentage change from nothing, and
   * reporting +100% for a shop's first sale is noise.
   */
  changePct: number | null;
};

/** Midnight UTC, `daysAgo` days back. Matches how every daily table keys its rows. */
export function utcDayStart(daysAgo = 0, now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Turn sparse per-day totals into one value per day across the window, oldest first.
 *
 * Days with no row are a genuine zero for sales (nothing sold) but *not* for a snapshot
 * series, where a missing day means the cron did not run, not that capital fell to zero.
 * `carryForward` distinguishes the two: a gap in a snapshot series repeats the previous
 * reading rather than drawing a cliff to the axis and back.
 *
 * A leading gap — a shop whose snapshots start midway through the window — carries
 * forward zero, since there is no earlier reading to repeat. That renders as a flat run
 * into the first real value, which is honest: nothing was recorded then.
 */
export function densify(
  byDay: Map<string, number>,
  days: number,
  { carryForward }: { carryForward: boolean },
  now = new Date(),
): number[] {
  const points: number[] = [];
  let last = 0;
  for (let i = days - 1; i >= 0; i--) {
    const value = byDay.get(dayKey(utcDayStart(i, now)));
    if (value !== undefined) {
      last = value;
      points.push(value);
    } else {
      points.push(carryForward ? last : 0);
    }
  }
  return points;
}

/**
 * Wrap a densified series with its half-over-half change, or null if too little history.
 *
 * `observedDays` is the count of days genuinely present in the data, which is not
 * `points.length` — densify always returns a full window, padding the gaps.
 */
export function toSeries(points: number[], observedDays: number): Series | null {
  if (observedDays < MIN_SPARKLINE_DAYS) return null;
  const mid = Math.floor(points.length / 2);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const earlier = sum(points.slice(0, mid));
  const later = sum(points.slice(mid));
  return {
    points,
    changePct: earlier > 0 ? ((later - earlier) / earlier) * 100 : null,
  };
}

/**
 * Project a series onto an SVG polyline `points` string.
 *
 * A flat series is drawn along the vertical middle rather than at the baseline: with
 * min === max the normalised value is undefined, and pinning it to the bottom of the box
 * makes "unchanged" look like "collapsed to zero".
 */
export function toPolyline(points: readonly number[], width: number, height: number): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `0,${(height / 2).toFixed(1)} ${width},${(height / 2).toFixed(1)}`;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;
  const inset = 1.5;

  return points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = span === 0 ? height / 2 : height - inset - ((v - min) / span) * (height - inset * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
