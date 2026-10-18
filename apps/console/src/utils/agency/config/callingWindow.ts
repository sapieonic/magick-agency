import { describeIsoDays } from '../../format/weekdays';
import { zoneFormatter, zonedParts } from '../../format/zone';
import type { CallingWindowState } from './configConstants';

/*
  The calling window: its time and zone checks, the window as a sentence, and
  whether the campaign would be dialling right now in its own zone. Out of
  `agencyCampaignConfigForm.ts`, which re-exports the public part of it.
*/

/** Normalise `HH:MM` / `HH:MM:SS` to a comparable `HH:MM:SS`. Mirrors the API. */
export function comparableTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * `Area/Location`, or exactly `UTC`.
 *
 * **A bare abbreviation must be refused, and `Intl` will not do it for you.**
 * `new Intl.DateTimeFormat(undefined, { timeZone: 'EST' })` does not throw — ICU
 * resolves `EST` to `America/Panama`, which observes no DST, so a campaign
 * configured `EST` would dial an hour early for half the year and would test
 * clean whenever anyone checked. The shape gate is what catches it.
 */
const IANA_ZONE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)+$/;

export function isUsableTimezone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  if (value === 'UTC') return true;
  if (!IANA_ZONE_RE.test(value)) return false;
  // One cached formatter per zone (`format/zone.ts`), shared with the echo below:
  // this runs on every keystroke in the timezone field.
  return zoneFormatter(value) !== null;
}

/**
 * Plain-English echo of the calling window.
 *
 * *An echo catches an inverted range that a pair of time inputs never will* —
 * and it names whether the campaign would be dialing right now, because "is it
 * on?" is the question the operator actually has.
 */
export function callingWindowEcho(state: CallingWindowState, now: Date = new Date()): string {
  if (!TIME_RE.test(state.start) || !TIME_RE.test(state.end) || state.days.length === 0) {
    return 'Set a window and at least one day to see when this campaign would dial.';
  }
  const days = describeDays(state.days);
  const wraps = comparableTime(state.start) > comparableTime(state.end);
  const base = `${days}, ${state.start}–${state.end}${wraps ? ' (overnight)' : ''}, ${state.timezone}.`;

  if (!isUsableTimezone(state.timezone)) return base;

  const local = zonedNow(now, state.timezone);
  if (local === null) return base;

  const open = isWithinWindow(local, state, wraps);
  return `${base} Right now it is ${local.time} there — the campaign ${
    open ? 'would be dialing' : 'would not be dialing'
  }.`;
}

interface ZonedNow {
  /** `HH:MM` in the campaign's zone. */
  time: string;
  /** ISO-8601 weekday, 1 = Monday. */
  isoDay: number;
}

function zonedNow(now: Date, timeZone: string): ZonedNow | null {
  const formatter = zoneFormatter(timeZone);
  const parts = formatter ? zonedParts(formatter, now) : null;
  if (parts === null) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { time: `${pad(parts.hour)}:${pad(parts.minute)}`, isoDay: parts.isoDay };
}

function isWithinWindow(local: ZonedNow, state: CallingWindowState, wraps: boolean): boolean {
  const now = comparableTime(local.time);
  const start = comparableTime(state.start);
  const end = comparableTime(state.end);
  const inTime = wraps ? now >= start || now < end : now >= start && now < end;
  return inTime && state.days.includes(local.isoDay);
}

/**
 * The calling days as the echo says them — `describeIsoDays` (shared with the
 * campaigns home's schedule line), with "No days" for a list with nothing valid
 * in it. A day outside 1–7 is dropped; this copy used to print it as "undefined".
 */
export function describeDays(days: number[]): string {
  return describeIsoDays(days) ?? 'No days';
}
