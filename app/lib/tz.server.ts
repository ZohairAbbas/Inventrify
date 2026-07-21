/**
 * Daily demand buckets must follow the merchant's calendar, not UTC.
 *
 * Sales were previously bucketed with `new Date(createdAt.split("T")[0])`, i.e. by UTC
 * day. Inventorify's markets sit at UTC+3..+8, so in Pakistan (UTC+5) every order placed
 * after 19:00 local was recorded against the *next* day. That shifts a slice of every
 * evening's demand — the busiest part of the day for COD — into tomorrow, which distorts
 * daily averages, day-of-week structure and the demand standard deviation that sizes
 * safety stock.
 *
 * The stored value stays "midnight UTC of a calendar date" so the existing @unique
 * (productId, date) shape is unchanged; what changes is *which* calendar date an order
 * is attributed to.
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = cache.get(timeZone);
  if (cached) return cached;
  let fmt: Intl.DateTimeFormat;
  try {
    // en-CA renders as YYYY-MM-DD.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown IANA zone must not take the sync down.
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  cache.set(timeZone, fmt);
  return fmt;
}

/** "YYYY-MM-DD" for `instant` as seen in `timeZone`. */
export function shopDateString(instant: Date, timeZone: string): string {
  return formatterFor(timeZone).format(instant);
}

/**
 * The storage key for the shop-local calendar day containing `instant`:
 * midnight UTC of that local date.
 */
export function shopDateKey(instant: Date, timeZone: string): Date {
  return new Date(`${shopDateString(instant, timeZone)}T00:00:00.000Z`);
}

/** Monday-start week key for the shop-local calendar date containing `instant`. */
export function shopWeekStart(instant: Date, timeZone: string): Date {
  const day = shopDateKey(instant, timeZone);
  const dow = day.getUTCDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  day.setUTCDate(day.getUTCDate() + diff);
  return day;
}
