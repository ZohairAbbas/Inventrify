/**
 * The reporting window shared by the dashboard and analytics.
 *
 * Presets are a lookback from today; a custom range is two explicit dates. Both resolve
 * to the same {from, to} pair so every query downstream takes one shape rather than some
 * taking "days" and others taking dates — which is how the dashboard ended up showing a
 * 30-day breakdown beside a 90-day one.
 *
 * Pure and framework-free so the parsing and clamping rules are unit-testable.
 */

const DAY_MS = 86400000;

/** How far back demand history actually goes. See SYNC_WINDOW_DAYS in order-sync. */
export const HISTORY_WINDOW_DAYS = 90;

/** Guard against a range so wide the queries become pointless. */
export const MAX_RANGE_DAYS = 365;

export const RANGE_PRESETS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

export const DEFAULT_RANGE_DAYS = 30;

export interface DateRange {
  /** Inclusive start, midnight UTC. */
  from: Date;
  /** Exclusive end, midnight UTC — the day after the last day shown. */
  to: Date;
  /** Whole days covered. */
  days: number;
  /** Preset value ("7"/"30"/"90") or "custom". Drives which chip is active. */
  preset: string;
  label: string;
  /** ISO dates for populating the custom inputs. */
  fromInput: string;
  toInput: string;
  /**
   * Set when the window reaches further back than retained history, so the UI can say
   * so rather than presenting a partial period as a complete one.
   */
  exceedsHistory: boolean;
}

function midnightUtc(d: Date): Date {
  const c = new Date(d);
  c.setUTCHours(0, 0, 0, 0);
  return c;
}

function parseIsoDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject dates that do not exist. JS rolls an overflowing day into the next month, so
  // "2026-02-31" parses happily as 3 March — a typo becomes a real date a week away,
  // silently, which is worse than an error. The round trip only matches a real date.
  return d.toISOString().slice(0, 10) === value ? d : null;
}

/**
 * Parse a `<input type="date">` value posted in a form.
 *
 * Returns null for empty *and* for malformed input, so a caller can tell "the merchant
 * left it blank" from "the merchant sent something we cannot read". `new Date(value)`
 * cannot: it yields an Invalid Date that Prisma then rejects at write time, or — worse
 * for a two-digit-year typo — a real date nobody meant. Dates chosen in a date picker
 * are calendar dates, so they anchor at UTC midnight rather than the server's zone.
 */
export function parseFormDate(value: FormDataEntryValue | string | null): Date | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === "") return null;
  return parseIsoDate(raw);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Resolve `?range=` / `?from=&to=` into a window.
 *
 * Anything invalid falls back to the default preset rather than erroring: a malformed URL
 * should show the usual dashboard, not a stack trace.
 */
export function resolveDateRange(
  params: URLSearchParams,
  now: Date = new Date(),
): DateRange {
  const today = midnightUtc(now);
  // `to` is exclusive, so the end of "today" is tomorrow midnight.
  const tomorrow = new Date(today.getTime() + DAY_MS);

  const rawFrom = parseIsoDate(params.get("from"));
  const rawTo = parseIsoDate(params.get("to"));

  if (rawFrom && rawTo) {
    // Order the pair rather than rejecting it — a reversed range is an obvious slip.
    const lo = rawFrom <= rawTo ? rawFrom : rawTo;
    const hi = rawFrom <= rawTo ? rawTo : rawFrom;

    // Never report on the future: there is no data there, and a range extending past
    // today would silently dilute every per-day average.
    const endExclusive = new Date(
      Math.min(hi.getTime() + DAY_MS, tomorrow.getTime()),
    );
    let start = lo;
    const span = Math.round((endExclusive.getTime() - start.getTime()) / DAY_MS);
    if (span > MAX_RANGE_DAYS) {
      start = new Date(endExclusive.getTime() - MAX_RANGE_DAYS * DAY_MS);
    }

    const days = Math.max(
      1,
      Math.round((endExclusive.getTime() - start.getTime()) / DAY_MS),
    );
    const lastDay = new Date(endExclusive.getTime() - DAY_MS);

    return {
      from: start,
      to: endExclusive,
      days,
      preset: "custom",
      label: `${iso(start)} → ${iso(lastDay)}`,
      fromInput: iso(start),
      toInput: iso(lastDay),
      exceedsHistory: days > HISTORY_WINDOW_DAYS,
    };
  }

  const rawRange = Number(params.get("range"));
  const days = RANGE_PRESETS.some((r) => Number(r.value) === rawRange)
    ? rawRange
    : DEFAULT_RANGE_DAYS;

  const from = new Date(tomorrow.getTime() - days * DAY_MS);
  return {
    from,
    to: tomorrow,
    days,
    preset: String(days),
    label: `last ${days} days`,
    fromInput: iso(from),
    toInput: iso(today),
    exceedsHistory: days > HISTORY_WINDOW_DAYS,
  };
}

/**
 * The equal-length window immediately before `range`, for period-over-period comparison.
 */
export function previousRange(range: DateRange): { from: Date; to: Date } {
  const span = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - span), to: range.from };
}
