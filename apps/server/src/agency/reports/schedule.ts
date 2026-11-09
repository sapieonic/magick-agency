/**
 * Report schedules and windows in a named zone (docs/reports.md, RP2, RP3, RP14). Pure: no I/O,
 * no clock (every instant is an argument). The wall clock is read with `localParts` from
 * `../calling-hours.ts`, the one `Intl` reader in the agency area; zones are checked with its
 * `isUsableTimezone` (`Area/Location` or `UTC`).
 *
 *  - {@link localDayBounds}: a local inclusive date window → the half-open instant window the
 *    server reads, `[local midnight of from, local midnight after to)`; a run's `range_from` and
 *    `range_to`.
 *  - {@link periodFor}: the local dates a subscription's run covers, from the instant it is due:
 *    daily the previous local day, weekly the seven local days ending the day before, monthly
 *    the previous local calendar month (the contract's periods).
 *  - {@link nextRunAt} / {@link previousRunAt}: a subscription's send instants, at
 *    `send_local_time` in its zone, every day (daily), on `send_weekday` (weekly, ISO: Monday 1),
 *    or on `send_monthday` (monthly, 1–28, a day every month has).
 *
 * ── The clock-change rule ({@link localInstant}) ─────────────────────────────
 * A local wall time names zero, one or two instants. Resolved deterministically:
 *  - **in a gap** (spring forward: 02:30 on a day New York goes from 02:00 straight to 03:00), the
 *    wall time is read with the offset in force BEFORE the gap, which lands the same distance
 *    after the gap's end: 02:30 → 03:30 EDT. A send is never dropped and never runs early;
 *  - **in an overlap** (fall back: 01:30 happens twice), the FIRST occurrence: 01:30 EDT, not EST.
 *    A send runs once (the next one is computed from after it, a day on);
 *  - otherwise the one instant.
 * A local midnight that falls in a gap (a zone that changes its clocks at 00:00) therefore resolves
 * to the first instant of that day, which is what a day window needs. These are the rules
 * `Temporal`'s `disambiguation: 'compatible'` and RFC 5545 apply.
 *
 * Every function throws a `RangeError` on an unusable zone or a malformed date or time: callers
 * validate zones and dates at the edge (the request schema, the stored row), so a throw here is a
 * caller bug, never user input.
 */
import type { ReportCadence } from '@magick-agency/contracts/api/agency/reports';
import { isUsableTimezone, localParts } from '../calling-hours.js';

const DAY_MS = 86_400_000;

/** A local inclusive date window, `YYYY-MM-DD` both ends. */
export interface LocalDateWindow {
  from: string;
  to: string;
}

/** What {@link nextRunAt} and {@link previousRunAt} read from a subscription. */
export interface ReportSchedule {
  cadence: ReportCadence;
  /** `HH:MM`, 24-hour (a stored `HH:MM:SS` with zero seconds is accepted too). */
  send_local_time: string;
  /** ISO weekday 1–7; weekly only. */
  send_weekday: number | null;
  /** 1–28; monthly only. */
  send_monthday: number | null;
  timezone: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::00)?$/;

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function assertZone(timezone: string): void {
  if (!isUsableTimezone(timezone) || timezone !== timezone.trim()) {
    throw new RangeError(`report schedule: unusable time zone ${JSON.stringify(timezone)}`);
  }
}

function parseDate(text: string): CivilDate {
  const m = DATE_RE.exec(text);
  if (m) {
    const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    const back = new Date(Date.UTC(date.year, date.month - 1, date.day));
    if (back.getUTCFullYear() === date.year && back.getUTCMonth() === date.month - 1 && back.getUTCDate() === date.day) {
      return date;
    }
  }
  throw new RangeError(`report schedule: not a YYYY-MM-DD date: ${JSON.stringify(text)}`);
}

/** Seconds since local midnight of an `HH:MM` send time. */
export function parseSendLocalTime(text: string): number {
  const m = TIME_RE.exec(text);
  if (m) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) return h * 3600 + mi * 60;
  }
  throw new RangeError(`report schedule: not an HH:MM time: ${JSON.stringify(text)}`);
}

/** Calendar arithmetic on a civil date (no zone): `days` later (negative: earlier). */
function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function formatDate(date: CivilDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function isoWeekday(date: CivilDate): number {
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** The wall clock at `instant` in `timezone` as a UTC-epoch number (wall fields read as if UTC). */
function wallMs(timezone: string, instant: number): number {
  const p = localParts(timezone, new Date(instant));
  if (!p) throw new RangeError(`report schedule: cannot read the clock in ${timezone}`);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The zone's UTC offset at `instant`, ms, positive east of UTC. */
function offsetMs(timezone: string, instant: number): number {
  return wallMs(timezone, instant) - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a local wall time names in `timezone`, under the clock-change rule in the module
 * header (gap: the offset before it; overlap: the first occurrence).
 */
function resolveWall(timezone: string, date: CivilDate, secondsOfDay: number): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + secondsOfDay * 1000;
  // No zone changes its clocks twice within two days, so the offsets a day either side are the
  // only two the wall time can be read with.
  const before = offsetMs(timezone, wall - DAY_MS);
  const after = offsetMs(timezone, wall + DAY_MS);
  const candidates = [...new Set([wall - before, wall - after])]
    .filter((t) => wallMs(timezone, t) === wall)
    .sort((a, b) => a - b);
  return new Date(candidates[0] ?? wall - before);
}

/** The instant of `HH:MM`-style seconds on a local date in `timezone`. Exported for tests and the tick. */
export function localInstant(timezone: string, date: string, secondsOfDay = 0): Date {
  assertZone(timezone);
  return resolveWall(timezone, parseDate(date), secondsOfDay);
}

/** The local date (`YYYY-MM-DD`) of `instant` in `timezone`. */
export function localDateOf(instant: Date, timezone: string): string {
  assertZone(timezone);
  const p = localParts(timezone, instant);
  if (!p) throw new RangeError('report schedule: not a valid instant');
  return formatDate({ year: p.year, month: p.month, day: p.day });
}

/**
 * The half-open instant window `[start, end)` of a local inclusive date window: local midnight of
 * `from` to local midnight after `to`, in `timezone`. A run's `range_from` / `range_to`.
 */
export function localDayBounds(from: string, to: string, timezone: string): { start: Date; end: Date } {
  assertZone(timezone);
  const first = parseDate(from);
  const last = parseDate(to);
  if (Date.UTC(last.year, last.month - 1, last.day) < Date.UTC(first.year, first.month - 1, first.day)) {
    throw new RangeError(`report schedule: ${to} is before ${from}`);
  }
  return { start: resolveWall(timezone, first, 0), end: resolveWall(timezone, addDays(last, 1), 0) };
}

/**
 * The local dates a subscription's run due at `sendAt` covers, in `timezone`: daily the previous
 * local day; weekly the seven local days ending the day before; monthly the previous local
 * calendar month. `from` is the run's `period_start`.
 */
export function periodFor(cadence: ReportCadence, sendAt: Date, timezone: string): LocalDateWindow {
  const today = parseDate(localDateOf(sendAt, timezone));
  switch (cadence) {
    case 'daily': {
      const day = formatDate(addDays(today, -1));
      return { from: day, to: day };
    }
    case 'weekly':
      return { from: formatDate(addDays(today, -7)), to: formatDate(addDays(today, -1)) };
    case 'monthly': {
      const last = addDays({ ...today, day: 1 }, -1);
      return { from: formatDate({ ...last, day: 1 }), to: formatDate(last) };
    }
  }
}

function sendsOn(schedule: ReportSchedule, date: CivilDate): boolean {
  switch (schedule.cadence) {
    case 'daily':
      return true;
    case 'weekly':
      return isoWeekday(date) === schedule.send_weekday;
    case 'monthly':
      return date.day === schedule.send_monthday;
  }
}

function checkSchedule(schedule: ReportSchedule): number {
  assertZone(schedule.timezone);
  const seconds = parseSendLocalTime(schedule.send_local_time);
  if (schedule.cadence === 'weekly' && !(Number.isInteger(schedule.send_weekday) && schedule.send_weekday! >= 1 && schedule.send_weekday! <= 7)) {
    throw new RangeError('report schedule: a weekly schedule needs send_weekday 1-7');
  }
  if (schedule.cadence === 'monthly' && !(Number.isInteger(schedule.send_monthday) && schedule.send_monthday! >= 1 && schedule.send_monthday! <= 28)) {
    throw new RangeError('report schedule: a monthly schedule needs send_monthday 1-28');
  }
  return seconds;
}

/** Local days scanned for a send: a month and a day either side covers every cadence. */
const SCAN_DAYS = 32;

/** The first send instant strictly after `after`. */
export function nextRunAt(schedule: ReportSchedule, after: Date): Date {
  const seconds = checkSchedule(schedule);
  const start = parseDate(localDateOf(after, schedule.timezone));
  // From the day before: a gap at the end of a day can push its send past midnight.
  for (let offset = -1; offset <= SCAN_DAYS; offset++) {
    const date = addDays(start, offset);
    if (!sendsOn(schedule, date)) continue;
    const at = resolveWall(schedule.timezone, date, seconds);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new RangeError('report schedule: no send found'); // unreachable for a checked schedule
}

/**
 * The latest send instant at or before `atOrBefore`: after downtime, the one missed period the
 * tick sends (RP14 catch-up sends only the most recent).
 */
export function previousRunAt(schedule: ReportSchedule, atOrBefore: Date): Date {
  const seconds = checkSchedule(schedule);
  const start = parseDate(localDateOf(atOrBefore, schedule.timezone));
  for (let offset = 1; offset >= -SCAN_DAYS; offset--) {
    const date = addDays(start, offset);
    if (!sendsOn(schedule, date)) continue;
    const at = resolveWall(schedule.timezone, date, seconds);
    if (at.getTime() <= atOrBefore.getTime()) return at;
  }
  throw new RangeError('report schedule: no send found'); // unreachable for a checked schedule
}
