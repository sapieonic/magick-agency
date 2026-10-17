import { describe, it, expect } from 'vitest';
import {
  periodRange,
  windowRange,
  windowRangeReadout,
} from '../../utils/agencyAgentPerformance';

/**
 * The agent windows, read from somewhere other than Greenwich.
 *
 * `periodRange` and `windowRange` build their bounds from the READER's local
 * calendar (`startOfDay` / `startOfWeek({ weekStartsOn: 1 })` / `startOfMonth`),
 * and `windowRangeReadout` names the reader's zone beside the dates it prints.
 * In the suite's pinned `TZ=UTC` local time and the wire agree, so a bound cut in
 * the wrong frame reads correctly anyway — which is why these live in a
 * `.timezone.test.ts` file (its own `forks` project, where a `TZ` assignment
 * actually moves the clock; see `agencyBucketDates.timezone.test.tsx`).
 *
 * Pinned before the format modules consolidate, so the move cannot shift a
 * boundary or a caption unnoticed.
 */
function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env['TZ'];
  process.env['TZ'] = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  }
}

describe('periodRange — cut on the reader’s calendar', () => {
  // 2026-08-19 is a Wednesday. 20:00Z is 01:30 on the 20th in Kolkata.
  const NOW = new Date('2026-08-19T20:00:00.000Z');

  it('starts “today” at the reader’s local midnight, not UTC’s', () => {
    const range = inZone('Asia/Kolkata', () => periodRange('today', NOW));
    expect(range).toEqual({ from: '2026-08-19T18:30:00.000Z', to: NOW.toISOString() });
  });

  it('starts the week on the reader’s Monday', () => {
    // In Kolkata it is already Thursday the 20th; the week began Monday the 17th.
    expect(inZone('Asia/Kolkata', () => periodRange('week', NOW)).from).toBe('2026-08-16T18:30:00.000Z');
    // In New York it is still Wednesday the 19th, 16:00; same Monday, its own midnight.
    expect(inZone('America/New_York', () => periodRange('week', NOW)).from).toBe('2026-08-17T04:00:00.000Z');
  });

  it('starts the month on the reader’s 1st', () => {
    expect(inZone('America/New_York', () => periodRange('month', NOW)).from).toBe('2026-08-01T04:00:00.000Z');
  });
});

describe('windowRange — the completed windows tile with the to-date ones', () => {
  const NOW = new Date('2026-08-19T20:00:00.000Z');

  it('last week ends exactly where this week begins, in the reader’s zone', () => {
    const [last, current] = inZone('Asia/Kolkata', () => [windowRange('last_week', NOW), windowRange('week', NOW)]);
    expect(last).toEqual({ from: '2026-08-09T18:30:00.000Z', to: '2026-08-16T18:30:00.000Z' });
    expect(last!.to).toBe(current!.from);
  });

  it('last month ends exactly where this month begins, across a DST change', () => {
    // New York is on EDT for both August and July, but March→April crosses the spring change.
    const april = new Date('2026-04-10T12:00:00.000Z');
    const [last, current] = inZone('America/New_York', () => [windowRange('last_month', april), windowRange('month', april)]);
    expect(last).toEqual({ from: '2026-03-01T05:00:00.000Z', to: '2026-04-01T04:00:00.000Z' });
    expect(last!.to).toBe(current!.from);
  });
});

describe('windowRangeReadout — the dates and the zone they were cut in', () => {
  it('prints the reader’s calendar dates and names the reader’s zone', () => {
    const NOW = new Date('2026-08-19T20:00:00.000Z');
    // Tokyo rather than Kolkata: ICU names the reader's zone by its canonical
    // ID, which for Kolkata is still the legacy `Asia/Calcutta`.
    const text = inZone('Asia/Tokyo', () => {
      const range = windowRange('last_week', NOW);
      return windowRangeReadout(range.from, range.to);
    });
    // Mon 10 – Sun 16 Aug, read in Tokyo: the exclusive end is the instant before 17 Aug 00:00.
    expect(text).toBe('10 Aug – 16 Aug 2026 · Asia/Tokyo');
  });

  it('says one day once', () => {
    const NOW = new Date('2026-08-19T20:00:00.000Z');
    const text = inZone('America/New_York', () => {
      const range = windowRange('today', NOW);
      return windowRangeReadout(range.from, range.to);
    });
    expect(text).toBe('19 Aug 2026 · America/New_York');
  });

  it('gives both years when the range straddles a new year', () => {
    const text = inZone('Asia/Tokyo', () =>
      windowRangeReadout('2026-12-27T15:00:00.000Z', '2027-01-03T15:00:00.000Z'));
    expect(text).toBe('28 Dec 2026 – 3 Jan 2027 · Asia/Tokyo');
  });
});
