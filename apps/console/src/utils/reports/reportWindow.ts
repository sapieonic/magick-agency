import { reportWindowProblem } from '@magick-agency/contracts/api/agency/reports';
import { REPORT_ERROR_MESSAGES } from '../../api/reports';
import { addDaysToDay, zoneDay } from '../agency/insights/range';
import { readerZone } from '../format/date';
import { zoneFormatter } from '../format/zone';

/**
 * The export dialog's window (`docs/reports.md` RP2, RP3): local dates in the
 * report's zone, both ends inclusive, checked with the contract's
 * `reportWindowProblem` so the console and the server refuse the same windows (at
 * most 30 days, or exactly one calendar month; never ending after today).
 */

export type ReportWindowPreset = 'last_7_days' | 'last_30_days' | 'previous_week' | 'previous_month' | 'custom';

export const REPORT_WINDOW_PRESETS: ReadonlyArray<{ id: ReportWindowPreset; label: string }> = [
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'last_30_days', label: 'Last 30 days' },
  { id: 'previous_week', label: 'Previous week' },
  { id: 'previous_month', label: 'Previous month' },
  { id: 'custom', label: 'Custom' },
];

export interface ReportWindowDates {
  /** `YYYY-MM-DD`, the first local day. */
  from: string;
  /** `YYYY-MM-DD`, the last local day (inclusive). */
  to: string;
}

/** ISO weekday of a calendar date, Monday 1 … Sunday 7. Pure date arithmetic. */
function isoWeekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * A preset's dates, given today in the report's zone (`YYYY-MM-DD`):
 * - Last 7 days / Last 30 days: ending today, as Insights' "Last 7 days" does;
 * - Previous week: the Monday to Sunday before this week;
 * - Previous month: the previous calendar month, 1st to its last day.
 */
export function presetWindow(preset: Exclude<ReportWindowPreset, 'custom'>, today: string): ReportWindowDates {
  switch (preset) {
    case 'last_7_days':
      return { from: addDaysToDay(today, -6), to: today };
    case 'last_30_days':
      return { from: addDaysToDay(today, -29), to: today };
    case 'previous_week': {
      const thisMonday = addDaysToDay(today, -(isoWeekday(today) - 1));
      return { from: addDaysToDay(thisMonday, -7), to: addDaysToDay(thisMonday, -1) };
    }
    case 'previous_month': {
      const firstOfThisMonth = `${today.slice(0, 7)}-01`;
      const lastOfPrevious = addDaysToDay(firstOfThisMonth, -1);
      return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious };
    }
  }
}

/** Today's date in `zone` (UTC when the zone is not one this browser knows). */
export function todayIn(zone: string, now: Date = new Date()): string {
  return zoneDay(zoneFormatter(zone) ? zone : 'UTC', now);
}

/**
 * Why a window cannot be sent, in the console's words, or null when it can. The
 * rule is the contract's; only the empty-field case is the form's own.
 */
export function reportWindowError(from: string, to: string, today: string): string | null {
  if (!from || !to) return 'Choose a start and an end date.';
  const problem = reportWindowProblem(from, to, today);
  return problem === null ? null : REPORT_ERROR_MESSAGES[problem];
}

/** The browser's IANA zone, the default for agent and account reports (RP3). */
export function browserZone(): string {
  const zone = readerZone();
  return zone && zoneFormatter(zone) ? zone : 'UTC';
}

const FALLBACK_ZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/**
 * The zones the select offers: every IANA zone this browser knows, plus UTC and
 * the zone already chosen (so a default the list lacks is never silently swapped).
 */
export function reportZoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : FALLBACK_ZONES;
  } catch {
    zones = FALLBACK_ZONES;
  }
  return [...new Set([...zones, 'UTC', current])].sort((a, b) => a.localeCompare(b));
}
