import { describe, it, expect } from 'vitest';
import { todayWindow } from '../../utils/agency/home';

/**
 * Home's "Today so far" window (`todayWindow`), read from somewhere other than Greenwich.
 *
 * The window starts at the READER's local midnight. In the suite's pinned `TZ=UTC` local time and
 * the wire agree, so a window cut in the wrong frame would read correctly anyway; these run in the
 * `timezone` project (its own `forks` pool, where a `TZ` assignment moves the clock; see
 * `agentWindows.timezone.test.ts`). Every expectation is a literal instant, worked out by hand,
 * never rebuilt with the code's own `new Date(y, m, d)`.
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

describe('todayWindow: from the reader’s local midnight', () => {
  it('in Kolkata (+05:30), just after midnight, is the new day', () => {
    // 20:00Z on the 11th is 01:30 on the 12th in Kolkata; its midnight was 18:30Z on the 11th.
    const now = new Date('2026-11-11T20:00:00.000Z');
    expect(inZone('Asia/Kolkata', () => todayWindow(now))).toEqual({
      from: '2026-11-11T18:30:00.000Z',
      to: '2026-11-11T20:00:00.000Z',
    });
  });

  it('in Kolkata, a minute before midnight, is still the old day', () => {
    // 18:29Z is 23:59 on the 11th in Kolkata: the day began at 18:30Z on the 10th, not UTC's midnight.
    const now = new Date('2026-11-11T18:29:00.000Z');
    expect(inZone('Asia/Kolkata', () => todayWindow(now)).from).toBe('2026-11-10T18:30:00.000Z');
  });

  it('in New York on the day the clocks go back, starts at midnight daylight time (a 25-hour day)', () => {
    // 1 Nov 2026: 02:00 EDT becomes 01:00 EST. 15:00Z is 10:00 EST; midnight was 00:00 EDT, 04:00Z
    // (an hours-since-midnight sum at today's EST offset would say 05:00Z).
    const now = new Date('2026-11-01T15:00:00.000Z');
    expect(inZone('America/New_York', () => todayWindow(now)).from).toBe('2026-11-01T04:00:00.000Z');
  });

  it('in New York on the day the clocks go forward, starts at midnight standard time (a 23-hour day)', () => {
    // 8 Mar 2026: 02:00 EST becomes 03:00 EDT. Midnight was 00:00 EST, 05:00Z.
    const now = new Date('2026-03-08T15:00:00.000Z');
    expect(inZone('America/New_York', () => todayWindow(now)).from).toBe('2026-03-08T05:00:00.000Z');
  });

  it('in Santiago, where daylight time starts AT midnight (no 00:00 that day), starts at the day’s first instant', () => {
    // 6 Sep 2026: 00:00 -04:00 (04:00Z) is skipped to 01:00 -03:00, the same instant.
    const now = new Date('2026-09-06T15:00:00.000Z');
    expect(inZone('America/Santiago', () => todayWindow(now))).toEqual({
      from: '2026-09-06T04:00:00.000Z',
      to: '2026-09-06T15:00:00.000Z',
    });
  });
});
