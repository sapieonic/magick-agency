/**
 * Every figure the PDF prints goes through these helpers, so one report cannot print a number two
 * ways. Numbers use the console's display locale (`en-IN`, lakh grouping: the product's readers
 * write `1,00,000`); dates and times are written British style (`9 Oct 2026`, `09:04`, 24-hour)
 * in the dataset's zone. Rates follow the house rule: a rate without enough calls behind it is
 * words, never 0.
 */

/** The console's display locale for numbers (`apps/console/src/utils/format/number.ts`). */
export const NUMBER_LOCALE = 'en-IN';
/** Dates and times are printed British style. */
export const DATE_LOCALE = 'en-GB';

const COUNT = new Intl.NumberFormat(NUMBER_LOCALE);

/** A count, `12,34,567`. */
export function count(value: number): string {
  return COUNT.format(value);
}

/** A percentage, one decimal, trailing zero trimmed: `18%`, `18.4%` (the console's `pct`). */
export function pct(value: number, decimals = 1): string {
  return `${Number(value.toFixed(decimals))}%`;
}

/** A count and its noun, agreeing: `1 dial`, `2 dials`. */
export function plural(n: number, singular: string, many = `${singular}s`): string {
  return `${count(n)} ${n === 1 ? singular : many}`;
}

/**
 * A duration in words, compact: `142 h 10 m`, `3 m 18 s`, `41 s`. Hours keep counting past a day
 * (a month's station time reads in hours).
 */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total >= 3600) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `${count(h)} h ${String(m).padStart(2, '0')} m`;
  }
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m} m ${String(s).padStart(2, '0')} s`;
  }
  return `${total} s`;
}

/** Hours with one decimal for chart axes and tooltips: `7.4 h`. */
export function hours(seconds: number): string {
  return `${Number((seconds / 3600).toFixed(1))} h`;
}

// ── Rates ───────────────────────────────────────────────────────────────────

/** A rate under the floor rules: a value, no denominator at all, or withheld below the floor. */
export type Rate =
  | { kind: 'value'; pct: number; numerator: number; denominator: number }
  | { kind: 'none' }
  | { kind: 'withheld'; denominator: number; floor: number };

/** The words for a rate with nothing behind it. */
export const NO_CALLS_TO_RATE = 'No calls to rate';
/** The words for a rate below its floor. */
export const NOT_ENOUGH_CALLS = 'Not enough calls to rate';

/** `numerator / denominator × 100` under the floor: none on 0, withheld below `floor`. */
export function rate(numerator: number, denominator: number, floor: number): Rate {
  if (!Number.isFinite(denominator) || denominator <= 0) return { kind: 'none' };
  if (denominator < floor) return { kind: 'withheld', denominator, floor };
  return { kind: 'value', pct: (numerator / denominator) * 100, numerator, denominator };
}

/**
 * A served rate (`number | null`) with its served gate (`rates_reportable` and the like): the
 * value only when it is non-null AND the gate says it may be quoted.
 */
export function servedRate(value: number | null | undefined, reportable: boolean, denominator = 0): Rate {
  if (value === null || value === undefined) return { kind: 'none' };
  if (!reportable) return { kind: 'withheld', denominator, floor: 0 };
  return { kind: 'value', pct: value, numerator: 0, denominator };
}

/** The rate as printed: `30.9%`, or words. */
export function rateText(r: Rate): string {
  if (r.kind === 'none') return NO_CALLS_TO_RATE;
  if (r.kind === 'withheld') return NOT_ENOUGH_CALLS;
  return pct(r.pct);
}

/** The percentage, or null for both kinds of "no rate" (workbook cells, chart marks). */
export function rateValue(r: Rate): number | null {
  return r.kind === 'value' ? r.pct : null;
}

/** A time share (seconds over seconds): no sample floor, null on no time at all. */
export function share(part: number, whole: number): number | null {
  if (!Number.isFinite(whole) || whole <= 0) return null;
  return (part / whole) * 100;
}

/** `total / n`, null when nothing was counted. */
export function average(total: number, n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return total / n;
}

// ── Dates and times in a zone ─────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${zone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(DATE_LOCALE, { timeZone: zone, ...options });
    formatters.set(key, f);
  }
  return f;
}

/** `YYYY-MM-DD` as a UTC noon instant, so a calendar date formats as itself in any zone. */
function dateAsUtc(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** `9 Oct 2026` for a `YYYY-MM-DD`. */
export function longDate(date: string): string {
  return fmt('UTC', { day: 'numeric', month: 'short', year: 'numeric' }).format(dateAsUtc(date));
}

/** `Fri 7 Nov` for a `YYYY-MM-DD`. */
export function dayLabel(date: string): string {
  const d = dateAsUtc(date);
  const weekday = fmt('UTC', { weekday: 'short' }).format(d);
  const dm = fmt('UTC', { day: 'numeric', month: 'short' }).format(d);
  return `${weekday} ${dm}`;
}

/** `7 Nov` for a `YYYY-MM-DD`. */
export function shortDate(date: string): string {
  return fmt('UTC', { day: 'numeric', month: 'short' }).format(dateAsUtc(date));
}

/** `9 Oct – 7 Nov 2026` (the year once when both ends share it). */
export function rangeLabel(from: string, to: string): string {
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return from === to ? longDate(from) : `${shortDate(from)} – ${longDate(to)}`;
  }
  return `${longDate(from)} – ${longDate(to)}`;
}

/** `09:04` for an instant, in the zone, 24-hour. */
export function clockTime(iso: string, zone: string): string {
  return fmt(zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** `8 Nov 2026 09:00` for an instant, in the zone. */
export function dateTime(iso: string, zone: string): string {
  const d = new Date(iso);
  return `${fmt(zone, { day: 'numeric', month: 'short', year: 'numeric' }).format(d)} ${clockTime(iso, zone)}`;
}

/** The wall-clock parts of an instant in a zone. */
export function zonedParts(
  iso: string | Date,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = fmt(zone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(ms: number, zone: string): number {
  const p = zonedParts(new Date(ms), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant (epoch ms) the local day `date` starts in the zone: its midnight, or, where the
 * clocks skip midnight, the first instant after the gap.
 */
export function localDayStart(date: string, zone: string): number {
  const wall = Date.parse(`${date}T00:00:00Z`);
  let t = wall - offsetAt(wall, zone);
  t = wall - offsetAt(t, zone);
  // Midnight fell in a gap: the wall clock reads the previous evening, so step past the gap.
  const p = zonedParts(new Date(t), zone);
  const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return shown < wall ? t + (wall - shown) : t;
}

/** The day after a `YYYY-MM-DD`. */
function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The length of the local day `date` in the zone, in hours: 24, or 23 or 25 on a clock change. */
export function dayHours(date: string, zone: string): number {
  return (localDayStart(nextDate(date), zone) - localDayStart(date, zone)) / 3_600_000;
}

/**
 * Hours ELAPSED since the start of the local day `date` in the zone, for placing an instant on a
 * day's axis. Elapsed, not read off the wall clock: on a day the clocks go back the repeated
 * hour is drawn after the first, and the day runs to 25.
 */
export function hoursIntoDay(iso: string, date: string, zone: string): number {
  return (Date.parse(iso) - localDayStart(date, zone)) / 3_600_000;
}

/** The wall clock `hours` elapsed into the local day `date`: `01`, or `01:30` off the hour. */
export function wallClockInto(hours: number, date: string, zone: string): string {
  const p = zonedParts(new Date(localDayStart(date, zone) + hours * 3_600_000), zone);
  const hh = String(p.hour).padStart(2, '0');
  return p.minute === 0 ? hh : `${hh}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * The local date of a trend bucket: `bucket_start` as served, which is `YYYY-MM-DD` in the
 * campaign's zone for `day` buckets. An instant (a sub-day bucket) is dated in `zone`. Never
 * counted from `range.from`: the rollup may serve fewer buckets than the window has days.
 */
export function bucketDate(bucketStart: string, zone: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(bucketStart)) return bucketStart;
  const p = zonedParts(bucketStart, zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
