/**
 * An inbound route's opening hours (`docs/inbound.md` §3 step 1, §7): is the route open at an
 * instant, and when does it next open (the due time of an inbound callback).
 *
 * A LEAF module: no I/O; it imports the contract's shapes and the zone clock. Pure and total:
 * hours and holidays arrive from a JSONB column, so nothing here throws on a malformed value; an
 * unusable timezone or a malformed stretch or holiday makes the whole schedule `unresolvable`,
 * which callers treat as closed (and log) and which has no next opening. The route API refuses
 * such a schedule before it is stored, so `unresolvable` is a row written by hand or by an older
 * build.
 *
 * ── The rules ────────────────────────────────────────────────────────────────
 *  - **Weekly hours.** A stretch `{ day, start, end }` (ISO day, `HH:MM`, `end` may be `24:00`)
 *    is open from `start` to just before `end` in the route's timezone. `end` earlier than
 *    `start` runs overnight into the next local day, and **belongs to the day it opens on**
 *    (calling-hours' rule: a Friday 22:00–02:00 stretch runs into Saturday morning whether or not
 *    Saturday has hours). `start == end` is empty (the API refuses it). Stretches may overlap.
 *  - **Holidays** are local date ranges, both ends inclusive. A holiday closes the route **all
 *    day**, and a stretch that **opens** on a holiday does not run at all, so its overnight tail
 *    is closed too. A stretch that opened the day before a holiday stops at the holiday's
 *    midnight. So: open at T ⇔ T's local date is not a holiday AND some stretch covers T whose
 *    opening date is not a holiday.
 *  - **DST.** Evaluated on the local wall clock, so a stretch keeps its wall times across a
 *    change. A spring-forward gap's wall times do not exist: a stretch opening inside the gap
 *    opens at the first instant after it (an opening is verified and stepped forward, never
 *    trusted from the arithmetic). A fall-back's repeated hour is open (or closed) on both passes.
 *
 * ── Why there are no midnight openings ───────────────────────────────────────
 * The route can only go from closed to open at a stretch's start. The one other boundary, a
 * local midnight, cannot open it: the tail of an overnight stretch past midnight belongs to a
 * stretch that was already open at its own start the evening before, unless that evening was a
 * holiday, in which case the tail is closed as well. So the next opening is found by walking the
 * stretch starts, day by day ({@link nextInboundOpening}).
 */

import type { AgencyInboundHoliday, AgencyInboundHoursInterval } from '@magick-agency/contracts/agency';
import { instantForLocalTime, isoDowOf, isUsableTimezone, localParts } from './zone-clock';

/** What the schedule rule reads off a route. */
export interface InboundSchedule {
  timezone: string;
  weekly_hours: readonly AgencyInboundHoursInterval[];
  holidays: readonly AgencyInboundHoliday[];
}

/**
 * `unresolvable` is not folded into `closed`: both refuse to connect anyone, but only `closed`
 * has a next opening to book a callback at (calling-hours' distinction).
 */
export type InboundScheduleState = 'open' | 'closed' | 'unresolvable';

/** The stretch, parsed: seconds since local midnight; `end` > `start` unless overnight. */
interface Stretch {
  day: number;
  start: number;
  end: number;
  overnight: boolean;
}

interface ParsedSchedule {
  timezone: string;
  stretches: Stretch[];
  /** Inclusive `[from, to]` pairs of `YYYY-MM-DD`, which compare as strings. */
  holidays: Array<[string, string]>;
}

const CLOCK_RE = /^(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `HH:MM` (24-hour, two digits each) → seconds since local midnight, or null. `24:00` is
 * accepted and means the end of the day (86400): the only way to say "to midnight".
 */
export function parseInboundClock(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const m = CLOCK_RE.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h === 24) return mi === 0 ? 86_400 : null;
  if (h > 23 || mi > 59) return null;
  return h * 3600 + mi * 60;
}

/** Is `raw` a real calendar date written `YYYY-MM-DD` (no `2026-02-30`)? */
export function isInboundCalendarDate(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const m = DATE_RE.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1) return false;
  const back = new Date(Date.UTC(y, mo - 1, d));
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d;
}

/** Days from `from` to `to` inclusive (1 for a one-day holiday); both must be calendar dates. */
export function inboundHolidaySpanDays(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** Parse every part, or null when any part is unusable (the whole schedule is `unresolvable`). */
function parse(schedule: InboundSchedule): ParsedSchedule | null {
  if (!schedule || !isUsableTimezone(schedule.timezone)) return null;
  if (!Array.isArray(schedule.weekly_hours) || !Array.isArray(schedule.holidays)) return null;
  const stretches: Stretch[] = [];
  for (const raw of schedule.weekly_hours) {
    if (!raw || typeof raw !== 'object') return null;
    const day = raw.day;
    const start = parseInboundClock(raw.start);
    const end = parseInboundClock(raw.end);
    if (!Number.isInteger(day) || day < 1 || day > 7 || start === null || end === null) return null;
    // `24:00` opens nothing; an empty stretch is skipped (never stored by the API).
    if (start === 86_400 || start === end) continue;
    stretches.push({ day, start, end, overnight: end < start });
  }
  const holidays: Array<[string, string]> = [];
  for (const raw of schedule.holidays) {
    if (!raw || typeof raw !== 'object') return null;
    if (!isInboundCalendarDate(raw.from) || !isInboundCalendarDate(raw.to) || raw.to < raw.from) return null;
    holidays.push([raw.from, raw.to]);
  }
  return { timezone: schedule.timezone.trim(), stretches, holidays };
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The calendar date `offset` days after (year, month, day), via UTC arithmetic. */
function addDays(year: number, month: number, day: number, offset: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + offset));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function isHoliday(p: ParsedSchedule, date: string): boolean {
  return p.holidays.some(([from, to]) => date >= from && date <= to);
}

function stateOf(p: ParsedSchedule, at: Date): InboundScheduleState {
  const l = localParts(p.timezone, at);
  if (!l) return 'unresolvable';
  const today = ymd(l.year, l.month, l.day);
  if (isHoliday(p, today)) return 'closed';
  const t = l.hour * 3600 + l.minute * 60 + l.second;
  const y = addDays(l.year, l.month, l.day, -1);
  const yesterday = ymd(y.year, y.month, y.day);
  const yesterdayDow = isoDowOf(y.year, y.month, y.day);
  for (const s of p.stretches) {
    // Opened today: from its start, to its end (or to midnight, when overnight).
    if (s.day === l.isoDow && t >= s.start && (s.overnight || t < s.end)) return 'open';
    // Opened yesterday and still running: an overnight tail, unless it opened on a holiday.
    if (s.overnight && s.day === yesterdayDow && t < s.end && !isHoliday(p, yesterday)) return 'open';
  }
  return 'closed';
}

/** Is the route open at `at`? */
export function inboundScheduleState(schedule: InboundSchedule, at: Date): InboundScheduleState {
  const p = parse(schedule);
  if (!p || !Number.isFinite(at.getTime())) return 'unresolvable';
  return stateOf(p, at);
}

/**
 * How far ahead {@link nextInboundOpening} looks: a year and a week, so a route with a stretch
 * on one weekday a year away is still found. Holidays may cover more than that
 * (`AGENCY_INBOUND_ROUTE_LIMITS`: up to 100 entries of up to 31 days); a schedule closed for the
 * whole horizon is treated as never opening (null: no callback time is invented) rather than
 * searched without end.
 */
export const INBOUND_NEXT_OPENING_HORIZON_DAYS = 373;

/** Across a spring-forward gap, how far either side of a computed opening the real one is hunted. */
const GAP_SCAN_LIMIT_MS = 4 * 60 * 60 * 1000;
/** Not every transition is a whole hour (Lord Howe shifts 30 minutes). */
const GAP_SCAN_STEP_MS = 5 * 60 * 1000;

/**
 * The first instant at or after `from` at which the route is open: `from` itself when open then,
 * else the next stretch start that is genuinely open. Null when there is none within
 * {@link INBOUND_NEXT_OPENING_HORIZON_DAYS} (no hours at all, every day a holiday) or the
 * schedule is `unresolvable`; the caller must not read null as "now".
 *
 * A stretch start is a wall time, converted with `instantForLocalTime` and then **settled**,
 * never trusted from the arithmetic ({@link settleOpening}): inside a spring-forward gap the
 * conversion lands up to an hour either side of the real opening, and inside a fall-back's
 * repeated hour it may pick the second pass. Exactness matters: this is the due time of a
 * callback a customer was promised.
 */
export function nextInboundOpening(schedule: InboundSchedule, from: Date): Date | null {
  const p = parse(schedule);
  if (!p || !Number.isFinite(from.getTime())) return null;
  const now = stateOf(p, from);
  if (now === 'open') return from;
  if (now === 'unresolvable' || p.stretches.length === 0) return null;
  const l = localParts(p.timezone, from)!;
  // Day 0 is `from`'s own local date: a stretch later today is the commonest answer.
  for (let offset = 0; offset <= INBOUND_NEXT_OPENING_HORIZON_DAYS; offset++) {
    const d = addDays(l.year, l.month, l.day, offset);
    const date = ymd(d.year, d.month, d.day);
    if (isHoliday(p, date)) continue;
    const dow = isoDowOf(d.year, d.month, d.day);
    const starts = [...new Set(p.stretches.filter((s) => s.day === dow).map((s) => s.start))].sort((a, b) => a - b);
    for (const start of starts) {
      const opened = settleOpening(p, date, start, instantForLocalTime(p.timezone, d.year, d.month, d.day, start));
      if (!opened) continue;
      if (opened.getTime() >= from.getTime()) return opened;
      // Passed already, but a fall-back repeats the wall time: its second pass reopens the
      // route when the first pass's stretch was cut short by the clock going back.
      const again = secondPass(p, date, start, opened);
      if (again && again.getTime() >= from.getTime()) return again;
    }
  }
  return null;
}

/**
 * The later instant with the same wall time as `first` (a fall-back's second pass, 30 or 60
 * minutes later), when it exists and the route is open there; else null.
 */
function secondPass(p: ParsedSchedule, date: string, start: number, first: Date): Date | null {
  for (const laterMs of [1_800_000, 3_600_000]) {
    const alt = new Date(first.getTime() + laterMs);
    const w = wallOf(p, alt);
    if (w && w.date === date && w.seconds === start && stateOf(p, alt) === 'open') return alt;
  }
  return null;
}

/** Seconds since local midnight and the local date of `at`, or null. */
function wallOf(p: ParsedSchedule, at: Date): { date: string; seconds: number } | null {
  const l = localParts(p.timezone, at);
  return l ? { date: ymd(l.year, l.month, l.day), seconds: l.hour * 3600 + l.minute * 60 + l.second } : null;
}

/**
 * The exact instant a stretch starting at wall time `start` on local `date` opens, from the
 * converted `candidate`, or null when it does not open there (another rule closes it).
 *
 *  1. **Repeated hour** (fall-back): the wall time occurs twice; the first pass is the opening.
 *     If the same wall time also occurs 30 or 60 minutes earlier (every transition is one of
 *     those), that earlier instant is taken.
 *  2. **Not open yet** (the conversion landed before a spring-forward gap): step forward in
 *     5-minute steps, up to 4 hours, until it is open.
 *  3. **Open, but past the real opening** (the conversion landed after the gap): step back in
 *     5-minute steps while it is still open, still `date` and still at or after `start` on the
 *     wall clock; the last such instant is the first one that exists after `start`.
 *
 * Transitions fall on whole 30-minute boundaries, so the 5-minute steps land on them exactly.
 */
function settleOpening(p: ParsedSchedule, date: string, start: number, candidate: Date | null): Date | null {
  if (!candidate) return null;
  let at = candidate;
  for (const earlierMs of [3_600_000, 1_800_000]) {
    const alt = new Date(at.getTime() - earlierMs);
    const w = wallOf(p, alt);
    if (w && w.date === date && w.seconds === start) {
      at = alt;
      break;
    }
  }
  if (stateOf(p, at) !== 'open') {
    let found: Date | null = null;
    for (let delta = GAP_SCAN_STEP_MS; delta <= GAP_SCAN_LIMIT_MS; delta += GAP_SCAN_STEP_MS) {
      const stepped = new Date(at.getTime() + delta);
      if (stateOf(p, stepped) === 'open') {
        found = stepped;
        break;
      }
    }
    if (!found) return null;
    at = found;
  }
  for (let delta = GAP_SCAN_STEP_MS; delta <= GAP_SCAN_LIMIT_MS; delta += GAP_SCAN_STEP_MS) {
    const prev = new Date(at.getTime() - GAP_SCAN_STEP_MS);
    const w = wallOf(p, prev);
    if (!w || w.date !== date || w.seconds < start || stateOf(p, prev) !== 'open') break;
    at = prev;
  }
  return at;
}
