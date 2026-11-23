import { describe, expect, it } from 'vitest';
import {
  DAY_PILLS,
  DEFAULT_HOURS_PRESET_ID,
  HOURS_PRESETS,
  dayPillValues,
  daysFromPills,
  daysPerWeekLabel,
  presetOfWindow,
  timeOfDayLabel,
  windowLabel,
  withPreset,
} from '../../../utils/campaignSetup/hoursPresets';
import { EMPTY_CAMPAIGN_CONFIG } from '../../../utils/agencyCampaignConfigForm';

/** "When to call" as choices (CS11). */

describe('timeOfDayLabel', () => {
  it('says a time as copy does, dropping ":00" on the hour', () => {
    expect(timeOfDayLabel('09:00')).toBe('9 AM');
    expect(timeOfDayLabel('18:00')).toBe('6 PM');
    expect(timeOfDayLabel('15:30')).toBe('3:30 PM');
    expect(timeOfDayLabel('00:00')).toBe('12 AM');
    expect(timeOfDayLabel('12:00')).toBe('12 PM');
    expect(timeOfDayLabel('12:05')).toBe('12:05 PM');
  });

  it('reads a stored HH:MM:SS, and gives anything else back as it came', () => {
    expect(timeOfDayLabel('20:00:00')).toBe('8 PM');
    expect(timeOfDayLabel('')).toBe('');
    expect(timeOfDayLabel('25:00')).toBe('25:00');
    expect(timeOfDayLabel('soon')).toBe('soon');
  });

  it('puts an en dash with spaces between the two ends', () => {
    expect(windowLabel('09:00', '18:00')).toBe('9 AM – 6 PM');
  });
});

describe('HOURS_PRESETS', () => {
  it('offers 9 AM – 6 PM, 9 AM – 8 PM and 9 AM – 9 PM, in that order', () => {
    expect(HOURS_PRESETS.map((p) => p.label)).toEqual(['9 AM – 6 PM', '9 AM – 8 PM', '9 AM – 9 PM']);
  });

  it('starts where the builder starts today (9 AM – 8 PM), so the server defaults are unchanged', () => {
    expect(presetOfWindow(EMPTY_CAMPAIGN_CONFIG.window)).toBe(DEFAULT_HOURS_PRESET_ID);
    expect(DEFAULT_HOURS_PRESET_ID).toBe('9-20');
  });
});

describe('presetOfWindow', () => {
  it('names the preset a window is, reading a stored time with seconds', () => {
    expect(presetOfWindow({ start: '09:00', end: '18:00' })).toBe('9-18');
    expect(presetOfWindow({ start: '09:00:00', end: '21:00:00' })).toBe('9-21');
  });

  it('is custom for any other window', () => {
    expect(presetOfWindow({ start: '10:00', end: '18:00' })).toBe('custom');
    expect(presetOfWindow({ start: '09:00', end: '18:30' })).toBe('custom');
    expect(presetOfWindow({ start: '', end: '' })).toBe('custom');
  });
});

describe('withPreset', () => {
  it('writes the hours and keeps the days and the time zone', () => {
    const window = { start: '07:00', end: '11:00', days: [1, 3], timezone: 'Europe/London' };
    expect(withPreset(window, '9-21')).toEqual({ start: '09:00', end: '21:00', days: [1, 3], timezone: 'Europe/London' });
    expect(window.start).toBe('07:00');
  });
});

describe('the day pills', () => {
  it('are Monday to Sunday, each read by its full name', () => {
    expect(DAY_PILLS.map((d) => d.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(DAY_PILLS[6]).toEqual({ value: '7', label: 'Sun', ariaLabel: 'Sunday' });
  });

  it('round-trip ISO days, sorted, without duplicates or days outside 1–7', () => {
    expect(dayPillValues([1, 2, 5])).toEqual(['1', '2', '5']);
    expect(daysFromPills(['5', '1', '1', '9', 'x'])).toEqual([1, 5]);
  });

  it('count the days in a week as copy says them', () => {
    expect(daysPerWeekLabel([1, 2, 3, 4, 5, 6, 7])).toBe('every day');
    expect(daysPerWeekLabel([1, 2, 3, 4, 5, 6])).toBe('6 days a week');
    expect(daysPerWeekLabel([3])).toBe('1 day a week');
    expect(daysPerWeekLabel([])).toBe('no days');
    expect(daysPerWeekLabel([1, 1, 8])).toBe('1 day a week');
  });
});
