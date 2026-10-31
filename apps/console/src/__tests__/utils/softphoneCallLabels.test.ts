import { describe, it, expect } from 'vitest';
import { recentCallWhen } from '../../utils/softphone/callLabels';
import { formatClockTime } from '../../utils/format/date';

/**
 * The recent-calls list's "when": a day as well as a time, so a call from last
 * week does not read as one from this morning. This project pins `TZ=UTC`.
 */
describe('recentCallWhen', () => {
  const now = new Date('2026-10-30T15:00:00Z');
  const at = (iso: string) => new Date(iso);

  it('says Today for a call earlier today', () => {
    const call = at('2026-10-30T00:05:00Z');
    expect(recentCallWhen(call, now)).toBe(`Today, ${formatClockTime(call)}`);
  });

  it('says Yesterday for one the calendar day before, however few hours ago', () => {
    const call = at('2026-10-29T23:55:00Z');
    expect(recentCallWhen(call, now)).toBe(`Yesterday, ${formatClockTime(call)}`);
  });

  it('gives the date for anything older, and the year once it is not this one', () => {
    expect(recentCallWhen(at('2026-10-28T09:00:00Z'), now)).toMatch(/^28 Oct, /);
    expect(recentCallWhen(at('2025-12-31T09:00:00Z'), now)).toMatch(/^31 Dec 2025, /);
  });

  it('counts calendar days across a month boundary', () => {
    const first = new Date('2026-11-01T08:00:00Z');
    expect(recentCallWhen(at('2026-10-31T22:00:00Z'), first)).toMatch(/^Yesterday, /);
  });
});
