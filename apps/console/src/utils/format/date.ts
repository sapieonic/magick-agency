import { DISPLAY_LOCALE } from './number';

/**
 * Dates and times for the console's analytics surfaces: one locale, cached
 * formatters, and the reader's zone.
 *
 * ── One locale ──────────────────────────────────────────────────────────────
 * `DISPLAY_LOCALE` (`en-IN`), the locale `@magick-agency/web-ui/format` already
 * used. These surfaces used to mix it with the reader's default, which put
 * "16 Oct" (a caption) next to "Oct 16" (a chart tooltip) on one screen.
 *
 * ── Cached ──────────────────────────────────────────────────────────────────
 * `toLocaleDateString(locale, options)` builds a new `Intl.DateTimeFormat` on
 * every call, and the series charts call it twice per bucket per render. One
 * formatter per option set is built once and reused; the set of option shapes
 * in this codebase is small and fixed.
 *
 * A formatter with no `timeZone` captures the reader's zone when it is BUILT,
 * so the key also carries the zone's offsets at two fixed instants (January and
 * July — standard and summer time). `getTimezoneOffset` is cheap, and it moves
 * when the process's zone does, which in practice is only the `.timezone` test
 * project switching `TZ` between cases; a cache keyed on options alone would
 * keep printing the first zone's dates there.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const JANUARY = new Date(Date.UTC(2026, 0, 15));
const JULY = new Date(Date.UTC(2026, 6, 15));

/** The cached `Intl.DateTimeFormat` for these options, in the display locale. */
export function dateFormatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${JANUARY.getTimezoneOffset()}/${JULY.getTimezoneOffset()}|${JSON.stringify(options)}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, options);
    FORMATTERS.set(key, formatter);
  }
  return formatter;
}

const DAY_MONTH: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };
const DAY_MONTH_YEAR: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' };
const CLOCK_TIME: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

/** `16 Oct`, on the reader's calendar. */
export function formatDayMonth(date: Date): string {
  return dateFormatter(DAY_MONTH).format(date);
}

/** `16 Oct 2026`, on the reader's calendar. */
export function formatDayMonthYear(date: Date): string {
  return dateFormatter(DAY_MONTH_YEAR).format(date);
}

/** `09:05 am`, on the reader's clock. */
export function formatClockTime(date: Date): string {
  return dateFormatter(CLOCK_TIME).format(date);
}

/**
 * The reader's IANA zone, or `null` where the environment cannot say.
 *
 * `resolvedOptions()` is specified to return an IANA name, but a caption must
 * not be the thing that throws in an environment with a partial `Intl`. Callers
 * pick their own fallback (`'UTC'` for a caption that must name a zone, the
 * short note for one that can omit it).
 */
export function readerZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
