/**
 * Wall-clock parts of an instant in a NAMED zone — a campaign's, never the
 * reader's — from one cached formatter per zone.
 *
 * Two modules computed this separately, in two shapes: the best-hours matrix
 * (year/month/day/hour/minute/second, to mark which weekday-hours a window
 * covers) and the campaign builder's calling-window echo (`HH:MM` and an ISO
 * weekday, to say whether the campaign would be dialling right now). Both built
 * a new `Intl.DateTimeFormat` per call — the coverage walk up to 5,760 times per
 * window, the builder on every keystroke in the timezone field.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** ISO-8601 weekday of the ZONED calendar date: 1 = Monday … 7 = Sunday. */
  isoDay: number;
}

/**
 * Bounded, because the builder feeds it what an operator is typing: every
 * keystroke that passes the IANA shape check is a distinct key. A zone that is
 * not one is cached as `null` too, so a mistyped name is refused once.
 */
const ZONE_CACHE_LIMIT = 64;
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

/**
 * The parts formatter for one named zone, or `null` when the name is not one.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unknown `timeZone`, and a
 * zone that crossed the API boundary — or that an operator is typing — can be
 * one. A caught `RangeError` degrades to "unknown"; an uncaught one takes a
 * section down.
 *
 * `en-US` with `hourCycle: 'h23'` for numeric, locale-stable parts: these are
 * parsed, never shown.
 */
export function zoneFormatter(zone: string): Intl.DateTimeFormat | null {
  if (ZONE_FORMATTERS.has(zone)) return ZONE_FORMATTERS.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    formatter = null;
  }
  if (ZONE_FORMATTERS.size >= ZONE_CACHE_LIMIT) ZONE_FORMATTERS.clear();
  ZONE_FORMATTERS.set(zone, formatter);
  return formatter;
}

/** The wall-clock parts of `at` in the formatter's zone, or `null` if any part is missing. */
export function zonedParts(formatter: Intl.DateTimeFormat, at: Date): ZonedParts | null {
  let year: number | null = null;
  let month: number | null = null;
  let day: number | null = null;
  let hour: number | null = null;
  let minute: number | null = null;
  let second: number | null = null;
  for (const part of formatter.formatToParts(at)) {
    const value = Number(part.value);
    if (!Number.isFinite(value)) continue;
    if (part.type === 'year') year = value;
    else if (part.type === 'month') month = value;
    else if (part.type === 'day') day = value;
    else if (part.type === 'hour') hour = value;
    else if (part.type === 'minute') minute = value;
    else if (part.type === 'second') second = value;
  }
  if (year === null || month === null || day === null) return null;
  if (hour === null || minute === null || second === null) return null;
  /*
    The weekday of the ZONED calendar date, computed from that date rather than
    from the instant: `getUTCDay` over a `Date.UTC` of the same y/m/d is the only
    reading that cannot drift back a day for a zone behind UTC.
  */
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  // `h23` should never produce 24, but an implementation that does would
  // otherwise put a real dial in a column the best-hours matrix has no room for,
  // and compare above every calling-window end.
  return { year, month, day, hour: hour % 24, minute, second, isoDay: weekday === 0 ? 7 : weekday };
}
