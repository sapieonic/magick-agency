/**
 * The wall clock in an IANA timezone: which zones we evaluate at all, the local date and time at
 * an instant, and the instant a local wall time falls on. The repo's ONE wall-clock reader: the
 * campaign calling window (`apps/server/src/agency/calling-hours.ts`), the report schedule and
 * the inbound route schedule (`./inbound-schedule.ts`) all read through it.
 *
 * A LEAF module: no imports, no I/O. Total: nothing here throws on a bad zone or a bad instant;
 * each answers null (or false) and the caller decides what an unreadable clock means.
 */

/**
 * `Intl.DateTimeFormat` construction is not free and callers ask per contact, so formatters are
 * cached per zone, including the **negative** result: a roster with a thousand rows carrying the
 * same junk zone pays one `RangeError` rather than a thousand.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  if (FORMATTERS.has(timezone)) return FORMATTERS.get(timezone) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      // `hourCycle` rather than `hour12: false`, which yields hour '24' at
      // midnight in some ICU builds and would put midnight on the wrong day.
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    fmt = null;
  }
  FORMATTERS.set(timezone, fmt);
  return fmt;
}

/**
 * Is this string a zone we are willing to evaluate a window in?
 *
 * **Stricter than `Intl` accepts, and the extra rule is load-bearing.** ICU resolves bare
 * abbreviations to fixed-offset zones, measured on this runtime: `'EST'` → **America/Panama**,
 * which is EST all year and observes no DST, so a zone written `EST` would place every call an
 * hour off for half the year. `'IST'` → Asia/Calcutta (harmlessly right) and `'GMT'` → UTC (right
 * by luck); the rule cannot tell those from the dangerous one, and an inferred timezone that puts
 * a call outside legal hours is worse than an honest default.
 *
 * So we require the `Area/Location` form, or exactly `UTC`. A handful of legitimate legacy IANA
 * links (`Japan`, `Cuba`, `EST5EDT`) are refused by this rule too; that is the trade.
 */
export function isUsableTimezone(timezone: string | null | undefined): boolean {
  if (typeof timezone !== 'string') return false;
  const trimmed = timezone.trim();
  if (trimmed === '') return false;
  if (!trimmed.includes('/') && trimmed.toUpperCase() !== 'UTC') return false;
  return formatterFor(trimmed) !== null;
}

export interface LocalParts {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  /** ISO-8601: 1=Mon…7=Sun. */
  isoDow: number;
}

/** The wall clock in `timezone` at `instant`, or null when the zone or the instant is unusable. */
export function localParts(timezone: string, instant: Date): LocalParts | null {
  const fmt = formatterFor(timezone);
  if (!fmt || !Number.isFinite(instant.getTime())) return null;
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type === 'literal') continue;
    const n = Number(part.value);
    if (!Number.isFinite(n)) return null;
    out[part.type] = n;
  }
  const { year, month, day, hour, minute, second } = out;
  if ([year, month, day, hour, minute, second].some((v) => v === undefined)) return null;
  return {
    year: year!, month: month!, day: day!, hour: hour!, minute: minute!, second: second!,
    isoDow: isoDowOf(year!, month!, day!),
  };
}

/**
 * Day of week for a calendar date, from UTC arithmetic rather than from a localized weekday
 * string: `formatToParts` weekday names are locale data, and comparing them would make every
 * predicate depend on the ICU bundle. Out-of-range days roll over (`Date.UTC`'s rule), so
 * `day + 1` past a month's end names the right weekday.
 */
export function isoDowOf(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

/** UTC offset of `timezone` at `instant`, in ms. Positive east of UTC. */
function zoneOffsetMs(timezone: string, instant: Date): number | null {
  const p = localParts(timezone, instant);
  if (!p) return null;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * The instant at which a given local wall clock occurs, or null. `day` may run past the month
 * (`Date.UTC` rolls it over), so "the day after" is `day + 1`.
 *
 * Two passes, because the offset depends on the answer: the first pass converts using the offset
 * near the guess, the second using the offset at the result. That converges everywhere except
 * across a DST transition: a wall time inside a spring-forward gap does not exist, and the answer
 * lands an hour off. Every caller that needs an exact opening **verifies the result against its
 * own predicate** and steps forward (calling-hours' `nextWindowOpen`, the inbound schedule's
 * next opening); a fall-back's repeated hour needs no care (either instant is that wall time).
 */
export function instantForLocalTime(
  timezone: string, year: number, month: number, day: number, secondsOfDay: number,
): Date | null {
  const wall = Date.UTC(year, month - 1, day) + secondsOfDay * 1000;
  const first = zoneOffsetMs(timezone, new Date(wall));
  if (first === null) return null;
  const second = zoneOffsetMs(timezone, new Date(wall - first));
  if (second === null) return null;
  return new Date(wall - second);
}
