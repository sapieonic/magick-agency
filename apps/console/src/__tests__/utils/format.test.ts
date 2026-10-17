import { describe, it, expect } from 'vitest';
import { clampPercent, formatCount, pct, plural } from '../../utils/format/number';
import { callSeconds, durationWords, formatDuration, statClock } from '../../utils/format/duration';
import { dateFormatter, formatClockTime, formatDayMonth, formatDayMonthYear } from '../../utils/format/date';
import { zoneFormatter, zonedParts } from '../../utils/format/zone';
import { describeIsoDays, hhmm } from '../../utils/format/weekdays';
import { ratePct, ratio, stateShares } from '../../utils/agency/metrics';

/**
 * The shared format and metric helpers. Each replaced two to four drifted
 * copies, so each case here is a rule one of those copies used to break.
 */

describe('format/number', () => {
  it('groups counts in the display locale (en-IN), whatever the reader’s browser says', () => {
    // The suite pins an en-US process locale; the output is en-IN regardless.
    expect(formatCount(12_345)).toBe('12,345');
    expect(formatCount(1_234_567)).toBe('12,34,567');
    expect(formatCount(0)).toBe('0');
  });

  it('prints one decimal with the trailing zero trimmed', () => {
    expect(pct(18)).toBe('18%');
    expect(pct(18.04)).toBe('18%');
    expect(pct(18.45)).toBe('18.4%');
    expect(pct(0)).toBe('0%');
  });

  it('agrees a count with its noun', () => {
    expect(plural(1, 'dial')).toBe('1 dial');
    expect(plural(2, 'dial')).toBe('2 dials');
    expect(plural(1, 'retry', 'retries')).toBe('1 retry');
    expect(plural(1_00_000, 'retry', 'retries')).toBe('1,00,000 retries');
  });

  it('keeps a meter inside its track', () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(42.5)).toBe(42.5);
  });
});

describe('format/duration — live timers floor, aggregates round', () => {
  it('floors a live clock: a second that has not elapsed is never shown', () => {
    expect(formatDuration(59_999)).toBe('0:59');
    expect(formatDuration(60_000)).toBe('1:00');
    expect(formatDuration(3_661_000)).toBe('1:01:01');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('rounds an aggregate clock to the nearest second', () => {
    expect(statClock(59.6)).toBe('1:00');
    expect(statClock(59.4)).toBe('0:59');
    expect(statClock(0)).toBe('0:00');
    expect(statClock(3_600)).toBe('1:00:00');
  });

  it('says the units of an aggregate, rounded the same way', () => {
    expect(durationWords(59.6)).toBe('1m');
    expect(durationWords(45)).toBe('45s');
    expect(durationWords(74)).toBe('1m 14s');
    expect(durationWords(8_100)).toBe('2h 15m');
    expect(durationWords(7_200)).toBe('2h');
  });

  it('renders a call record’s seconds, with -- for nothing to show', () => {
    expect(callSeconds(null)).toBe('--');
    expect(callSeconds(undefined)).toBe('--');
    expect(callSeconds(0)).toBe('--');
    expect(callSeconds(65)).toBe('1:05');
    // Rolls to hours like every other clock here, rather than `61:01`.
    expect(callSeconds(3_661)).toBe('1:01:01');
  });
});

describe('format/date — one locale, cached formatters', () => {
  const at = new Date('2026-08-11T09:05:00.000Z');

  it('prints day-month order in the display locale', () => {
    expect(formatDayMonth(at)).toBe('11 Aug');
    expect(formatDayMonthYear(at)).toBe('11 Aug 2026');
    expect(formatClockTime(at)).toBe('09:05 am');
  });

  it('reuses one formatter per option set', () => {
    expect(dateFormatter({ day: 'numeric', month: 'short' })).toBe(dateFormatter({ day: 'numeric', month: 'short' }));
  });
});

describe('format/zone — a named zone’s wall clock', () => {
  it('reads the zoned date and its ISO weekday, not the instant’s UTC day', () => {
    // 2026-08-16T20:00Z is Sunday in UTC and already Monday 01:30 in Kolkata.
    const parts = zonedParts(zoneFormatter('Asia/Kolkata')!, new Date('2026-08-16T20:00:00.000Z'));
    expect(parts).toEqual({ year: 2026, month: 8, day: 17, hour: 1, minute: 30, second: 0, isoDay: 1 });
    const ny = zonedParts(zoneFormatter('America/New_York')!, new Date('2026-08-16T20:00:00.000Z'));
    expect(ny?.isoDay).toBe(7);
  });

  it('caches per zone, and refuses a name that is not one without throwing', () => {
    expect(zoneFormatter('Asia/Kolkata')).toBe(zoneFormatter('Asia/Kolkata'));
    expect(zoneFormatter('Not/AZone')).toBeNull();
  });
});

describe('format/weekdays', () => {
  it('describes ISO days the shortest honest way, dropping what is not a day', () => {
    expect(describeIsoDays([1, 2, 3, 4, 5])).toBe('Mon–Fri');
    expect(describeIsoDays([1, 3, 5])).toBe('Mon, Wed, Fri');
    expect(describeIsoDays([6, 7])).toBe('Sat, Sun');
    expect(describeIsoDays([1, 2, 3, 4, 5, 6, 7])).toBe('Every day');
    expect(describeIsoDays([1, 2, 9])).toBe('Mon, Tue');
    expect(describeIsoDays([0, 8, 1.5])).toBeNull();
    expect(describeIsoDays(undefined)).toBeNull();
  });

  it('trims a TIME column to HH:MM and leaves anything else as sent', () => {
    expect(hhmm('09:00:00')).toBe('09:00');
    expect(hhmm('18:30')).toBe('18:30');
    expect(hhmm('9am')).toBe('9am');
  });
});

describe('agency/metrics', () => {
  it('divides only over a real, positive denominator', () => {
    expect(ratio(1, 4)).toBe(0.25);
    expect(ratePct(1, 4)).toBe(25);
    expect(ratePct(0, 4)).toBe(0);
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(Number.NaN, 4)).toBeNull();
    expect(ratePct(undefined, 4)).toBeNull();
    expect(ratePct(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('shares the on-shift states, skipping offline, zeroes and non-numbers', () => {
    const { total, shares } = stateShares({
      on_call: 3,
      wrapup: 0,
      reserved: Number.NaN,
      available: 1,
      break: '2' as unknown as number,
      offline: 50,
    });
    expect(total).toBe(4);
    expect(shares).toEqual([
      { state: 'on_call', value: 3, share: 75 },
      { state: 'available', value: 1, share: 25 },
    ]);
    expect(stateShares(undefined)).toEqual({ total: 0, shares: [] });
    expect(stateShares({ offline: 9 })).toEqual({ total: 0, shares: [] });
  });
});
