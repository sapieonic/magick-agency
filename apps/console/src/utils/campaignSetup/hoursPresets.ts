import type { CallingWindowState } from '../agencyCampaignConfigForm';
import { hhmm, ISO_WEEKDAY_SHORT } from '../format/weekdays';

/*
  "When to call" as choices (CS11): three common windows and Custom, the days as pills. The
  presets only write `start` and `end`; the days and the time zone are kept. Nothing about the
  server's defaults changes: the builder still starts at 9 AM – 8 PM (`EMPTY_CAMPAIGN_CONFIG`).
*/

export type HoursPresetId = '9-18' | '9-20' | '9-21';
export type HoursChoice = HoursPresetId | 'custom';

export interface HoursPreset {
  id: HoursPresetId;
  /** `HH:MM`, as the form holds it. */
  start: string;
  end: string;
  /** "9 AM – 6 PM". */
  label: string;
}

/** A time of day as copy says it: `09:00` → "9 AM", `15:30` → "3:30 PM". Anything else as given. */
export function timeOfDayLabel(value: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const minutes = match[2]!;
  if (hours > 23 || Number(minutes) > 59) return value;
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  const suffix = hours < 12 ? 'AM' : 'PM';
  return minutes === '00' ? `${h12} ${suffix}` : `${h12}:${minutes} ${suffix}`;
}

/** "9 AM – 6 PM". */
export function windowLabel(start: string, end: string): string {
  return `${timeOfDayLabel(start)} – ${timeOfDayLabel(end)}`;
}

function preset(id: HoursPresetId, start: string, end: string): HoursPreset {
  return { id, start, end, label: windowLabel(start, end) };
}

/** In pill order. `9-20` is the builder's starting window. */
export const HOURS_PRESETS: readonly HoursPreset[] = [
  preset('9-18', '09:00', '18:00'),
  preset('9-20', '09:00', '20:00'),
  preset('9-21', '09:00', '21:00'),
];

export const DEFAULT_HOURS_PRESET_ID: HoursPresetId = '9-20';

/**
 * Which preset the window is, or `custom`. Read from `start` and `end` only (a stored
 * `09:00:00` counts as `09:00`); the days and the time zone are not part of a preset.
 */
export function presetOfWindow(window: Pick<CallingWindowState, 'start' | 'end'>): HoursChoice {
  const start = hhmm(window.start);
  const end = hhmm(window.end);
  return HOURS_PRESETS.find((p) => p.start === start && p.end === end)?.id ?? 'custom';
}

/** The window with a preset's hours; the days and the time zone are kept. */
export function withPreset(window: CallingWindowState, id: HoursPresetId): CallingWindowState {
  const found = HOURS_PRESETS.find((p) => p.id === id);
  return found ? { ...window, start: found.start, end: found.end } : window;
}

const ISO_WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

/** The day pills, Monday first. Values are ISO days as strings (`PillGroup` takes strings). */
export const DAY_PILLS: readonly { value: string; label: string; ariaLabel: string }[] = ISO_WEEKDAY_SHORT.map(
  (label, i) => ({ value: String(i + 1), label, ariaLabel: ISO_WEEKDAY_LONG[i]! }),
);

/** ISO days → the pills' values. */
export function dayPillValues(days: readonly number[]): string[] {
  return days.map(String);
}

/** The pills' values → ISO days, sorted, without duplicates or anything outside 1–7. */
export function daysFromPills(values: readonly string[]): number[] {
  return [...new Set(values.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7).sort((a, b) => a - b);
}

/** "every day", "6 days a week", "1 day a week", "no days". */
export function daysPerWeekLabel(days: readonly number[]): string {
  const count = daysFromPills(days.map(String)).length;
  if (count === 7) return 'every day';
  if (count === 0) return 'no days';
  return `${count} day${count === 1 ? '' : 's'} a week`;
}
