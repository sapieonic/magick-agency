import { describe, it, expect } from 'vitest';
import { presetWindow, reportWindowError, reportZoneOptions, todayIn } from '../../utils/reports/reportWindow';
import {
  cadenceDescription,
  failureMessage,
  formatFileSize,
  formatReportWindow,
  ordinal,
  isPendingStatus,
  REPORT_FAILURE_MESSAGES,
} from '../../utils/reports/reportCopy';
import { REPORT_FAILURE_CODES, REPORT_RUN_STATUSES } from '@magick-agency/contracts/api/agency/reports';

/**
 * The export window (`docs/reports.md` RP2, RP3): the presets' local dates, today in
 * the report's zone, the shared rule's verdict in the console's words; and the
 * subscription cadence sentence.
 */

describe('presetWindow', () => {
  // Sunday 8 November 2026.
  const today = '2026-11-08';

  it('Last 7 days ends today and spans seven days', () => {
    expect(presetWindow('last_7_days', today)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('Last 30 days ends today and spans thirty days', () => {
    expect(presetWindow('last_30_days', today)).toEqual({ from: '2026-10-10', to: '2026-11-08' });
  });

  it('Previous week is the Monday to Sunday before this week', () => {
    // Today is a Sunday: this week began Monday 2 Nov, so the previous one is 26 Oct–1 Nov.
    expect(presetWindow('previous_week', today)).toEqual({ from: '2026-10-26', to: '2026-11-01' });
    // On a Monday, the previous week ended yesterday.
    expect(presetWindow('previous_week', '2026-11-09')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });

  it('Previous month is the previous calendar month, across a year end and a leap February', () => {
    expect(presetWindow('previous_month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetWindow('previous_month', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(presetWindow('previous_month', '2028-03-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('every preset passes the shared window rule', () => {
    for (const p of ['last_7_days', 'last_30_days', 'previous_week', 'previous_month'] as const) {
      for (const day of ['2026-11-08', '2026-03-31', '2027-01-01', '2028-03-01']) {
        const w = presetWindow(p, day);
        expect(reportWindowError(w.from, w.to, day), `${p} on ${day}`).toBeNull();
      }
    }
  });
});

describe('todayIn', () => {
  it('reads today in the report zone, not the browser’s', () => {
    // 20:00 UTC on 8 Nov is already 9 Nov in Kolkata (+05:30), still 8 Nov in New York.
    const at = new Date('2026-11-08T20:00:00Z');
    expect(todayIn('Asia/Kolkata', at)).toBe('2026-11-09');
    expect(todayIn('America/New_York', at)).toBe('2026-11-08');
  });

  it('falls back to UTC for a zone the browser does not know', () => {
    expect(todayIn('Not/AZone', new Date('2026-11-08T23:30:00Z'))).toBe('2026-11-08');
  });
});

describe('reportWindowError (the contract’s rule, in words)', () => {
  const today = '2026-11-08';

  it('accepts up to 30 days', () => {
    expect(reportWindowError('2026-10-10', '2026-11-08', today)).toBeNull();
  });

  it('refuses 31 days that are not one calendar month', () => {
    expect(reportWindowError('2026-10-09', '2026-11-08', today)).toMatch(/at most 30 days, or exactly one calendar month/);
  });

  it('accepts exactly one 31-day calendar month', () => {
    expect(reportWindowError('2026-10-01', '2026-10-31', today)).toBeNull();
  });

  it('refuses an end after today, an end before the start, and missing dates', () => {
    expect(reportWindowError('2026-11-01', '2026-11-09', today)).toMatch(/no later than today/);
    expect(reportWindowError('2026-11-05', '2026-11-01', today)).toMatch(/start date on or before the end date/);
    expect(reportWindowError('', '2026-11-01', today)).toBe('Choose a start and an end date.');
  });
});

describe('reportZoneOptions', () => {
  it('always offers UTC and the current choice, sorted, without duplicates', () => {
    const zones = reportZoneOptions('Asia/Kolkata');
    expect(zones).toContain('UTC');
    expect(zones).toContain('Asia/Kolkata');
    expect(new Set(zones).size).toBe(zones.length);
    expect([...zones].sort((a, b) => a.localeCompare(b))).toEqual(zones);
  });
});

describe('copy', () => {
  it('describes each cadence with its day, time and zone', () => {
    const base = { send_local_time: '08:30', timezone: 'Asia/Kolkata', send_weekday: null, send_monthday: null };
    expect(cadenceDescription({ ...base, cadence: 'daily' })).toBe('Daily at 08:30 (Asia/Kolkata)');
    expect(cadenceDescription({ ...base, cadence: 'weekly', send_weekday: 1 })).toBe('Weekly on Monday at 08:30 (Asia/Kolkata)');
    expect(cadenceDescription({ ...base, cadence: 'weekly', send_weekday: 7 })).toBe('Weekly on Sunday at 08:30 (Asia/Kolkata)');
    expect(cadenceDescription({ ...base, cadence: 'monthly', send_monthday: 22 })).toBe('Monthly on the 22nd at 08:30 (Asia/Kolkata)');
  });

  it('writes ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 28].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '28th',
    ]);
  });

  it('formats a window as calendar dates, never shifted by the reader’s zone', () => {
    expect(formatReportWindow({ from: '2026-10-09', to: '2026-11-07' })).toBe('9 Oct – 7 Nov 2026');
    expect(formatReportWindow({ from: '2025-12-28', to: '2026-01-03' })).toBe('28 Dec 2025 – 3 Jan 2026');
    expect(formatReportWindow({ from: '2026-11-07', to: '2026-11-07' })).toBe('7 Nov 2026');
  });

  it('has words for every failure code, and only the in-flight statuses are pending', () => {
    for (const code of REPORT_FAILURE_CODES) expect(failureMessage({ code, message: 'x' })).toBe(REPORT_FAILURE_MESSAGES[code]);
    expect(REPORT_RUN_STATUSES.filter(isPendingStatus)).toEqual(['queued', 'assembling', 'rendering']);
  });

  it('formats file sizes', () => {
    expect(formatFileSize(900)).toBe('900 B');
    expect(formatFileSize(830 * 1024)).toBe('830 KB');
    expect(formatFileSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
  });
});
