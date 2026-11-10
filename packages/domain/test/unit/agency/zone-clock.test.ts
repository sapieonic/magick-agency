import { describe, expect, it } from 'vitest';
import { instantForLocalTime, isoDowOf, isUsableTimezone, localParts } from '../../../src/zone-clock.js';

/*
 * The one wall-clock reader (calling hours, the report schedule, the inbound schedule). The
 * calling-window suites exercise it end to end; these pin its own contract.
 */
describe('isUsableTimezone', () => {
  it.each([
    ['Europe/London', true], ['America/New_York', true], ['Asia/Kolkata', true], ['UTC', true], ['utc', true],
    [' Europe/London ', true],
    // Bare abbreviations resolve to fixed-offset zones (EST → no DST): refused.
    ['EST', false], ['IST', false], ['GMT', false], ['Japan', false],
    ['Mars/Olympus_Mons', false], ['', false], [null, false], [undefined, false],
  ])('%j → %j', (zone, want) => {
    expect(isUsableTimezone(zone)).toBe(want);
  });
});

describe('localParts', () => {
  it('reads the wall clock and the ISO weekday', () => {
    expect(localParts('Europe/London', new Date('2026-07-06T08:00:00Z'))).toEqual({
      year: 2026, month: 7, day: 6, hour: 9, minute: 0, second: 0, isoDow: 1,
    });
    // Midnight is hour 0 of the new day, never hour 24 of the old one.
    expect(localParts('UTC', new Date('2026-11-15T00:00:00Z'))).toMatchObject({ day: 15, hour: 0, isoDow: 7 });
  });

  it('is null for an unusable zone or instant', () => {
    expect(localParts('Mars/Olympus_Mons', new Date())).toBeNull();
    expect(localParts('UTC', new Date(Number.NaN))).toBeNull();
  });
});

describe('isoDowOf', () => {
  it('Monday is 1 and Sunday 7; a day past the month rolls over', () => {
    expect(isoDowOf(2026, 11, 9)).toBe(1);
    expect(isoDowOf(2026, 11, 15)).toBe(7);
    expect(isoDowOf(2026, 11, 31)).toBe(2); // 1 Dec 2026, a Tuesday
  });
});

describe('instantForLocalTime', () => {
  it('converts an ordinary wall time on either side of a change', () => {
    expect(instantForLocalTime('Europe/London', 2026, 7, 6, 9 * 3600)).toEqual(new Date('2026-07-06T08:00:00Z'));
    expect(instantForLocalTime('America/New_York', 2026, 11, 2, 9 * 3600)).toEqual(new Date('2026-11-02T14:00:00Z'));
    expect(instantForLocalTime('Asia/Kolkata', 2026, 11, 9, 9 * 3600)).toEqual(new Date('2026-11-09T03:30:00Z'));
  });

  it('rolls a day past the month over', () => {
    expect(instantForLocalTime('UTC', 2026, 11, 31, 0)).toEqual(new Date('2026-12-01T00:00:00Z'));
  });

  it('is null for an unusable zone', () => {
    expect(instantForLocalTime('Mars/Olympus_Mons', 2026, 11, 9, 0)).toBeNull();
  });
});
