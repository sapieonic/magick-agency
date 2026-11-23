import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import { currentZoneName as legacyZoneTarget } from '@magick-agency/domain/zone-clock';
import { DISPLAY_LOCALE } from './number';
import { zoneFormatter } from './zone';

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

/**
 * `YYYY-MM-DD` on the reader's calendar (the browser's zone): the day Today so far counts
 * (`todayWindow` in `utils/agency/home.ts`), the one "Got it" lasts for (`homeAcks.ts`) and the
 * one the Call log opens on.
 */
export function localDay(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A `YYYY-MM-DD` for a date picker from an instant the URL carries, in the viewer's zone; '' for none or one that does not parse. */
export function dayOfInstant(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : localDay(date);
}

/**
 * An instant as a time when it fell on `now`'s calendar day ("11:03 am"), else as its date and
 * time: Live floor's Needs you now rows and its campaign cards.
 */
export function formatTimeOrDate(iso: string, now: Date): string {
  return new Date(iso).toDateString() === now.toDateString() ? formatTime(iso) : formatDate(iso);
}

/**
 * A formatted time with its day period in capitals: "3:31 pm" → "3:31 PM" (the house style,
 * AS15). The display locale (`en-IN`) writes "am" / "pm" in lower case, and most of the console
 * still shows it so; the campaign Call log and the inbound Call page say every time through this,
 * so one page never mixes the two (`docs/call-log.md` §4).
 */
export function upperDayPeriod(text: string): string {
  return text.replace(/\b([ap])\.?m\b\.?/gi, (_match, letter: string) => `${letter.toUpperCase()}M`);
}

/** `09:05 am`, on the reader's clock. */
export function formatClockTime(date: Date): string {
  return dateFormatter(CLOCK_TIME).format(date);
}

/**
 * A zone by its current IANA name: a legacy name ICU (so Chromium and Node) still reports as a
 * zone's canonical ID mapped to its current one (`currentZoneName` of
 * `@magick-agency/domain/zone-clock`, the table the server cuts days by too) when this browser knows
 * the current name (`zoneFormatter`), any other as given. A browser in India says `Asia/Calcutta`;
 * the console sends and shows `Asia/Kolkata`, the name the rest of the product stores, so the
 * reader's zone and a campaign's read the same. A browser whose ICU predates the rename keeps the
 * legacy name, which it can still format in, rather than one it would refuse.
 */
export function currentZoneName(zone: string): string {
  const current = legacyZoneTarget(zone);
  return current !== null && zoneFormatter(current) !== null ? current : zone;
}

/**
 * The reader's IANA zone, by its current name ({@link currentZoneName}), or
 * `null` where the environment cannot say.
 *
 * `resolvedOptions()` is specified to return an IANA name, but a caption must
 * not be the thing that throws in an environment with a partial `Intl`. Callers
 * pick their own fallback (`'UTC'` for a caption that must name a zone, the
 * short note for one that can omit it).
 */
export function readerZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone ? currentZoneName(zone) : null;
  } catch {
    return null;
  }
}
