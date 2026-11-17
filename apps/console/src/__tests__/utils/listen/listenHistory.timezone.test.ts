import { describe, it, expect, afterEach } from 'vitest';
import { EMPTY_LISTEN_HISTORY_DRAFT, listenHistoryQuery } from '../../../utils/listen/listenHistory';

/**
 * The Listening history's date range as the route's query, in the reader's own zone
 * (`docs/listening.md` §12): `from` is the first instant of the local day, `to` the first instant
 * of the local day after the last (the route's `to` is exclusive), across a daylight-saving change.
 *
 * Why `.timezone.test.ts`: the suite is pinned to UTC, where local and UTC days are the same and
 * no day is 23 or 25 hours long, so a "local versus UTC" mistake cannot show. The suffix runs the
 * file in its own Vitest project on `pool: 'forks'`, the one place a `TZ` change moves the clock
 * (see `agencyAttemptRange.timezone.test.ts`). The expectations are UTC instants, literal: what
 * goes on the wire, not a restatement of the code's own arithmetic.
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

afterEach(() => {
  // Also the guard that this file runs where it thinks it does: on the threads pool the zone
  // would never have changed in the first place.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');
});

const range = (from: string, to: string) => listenHistoryQuery({ ...EMPTY_LISTEN_HISTORY_DRAFT, from, to });

describe('listenHistoryQuery in the reader’s zone', () => {
  it('Asia/Kolkata (UTC+5:30, no daylight saving): the local day, not the UTC one', () => {
    expect(inZone('Asia/Kolkata', () => range('2026-11-01', '2026-11-16'))).toEqual({
      from: '2026-10-31T18:30:00.000Z',
      to: '2026-11-16T18:30:00.000Z',
    });
  });

  it('Europe/London, the day the clocks go back (25 October 2026, 25 hours): the whole of it', () => {
    // 25 Oct begins at 00:00 BST (23:00Z on the 24th) and the 26th at 00:00 GMT (00:00Z).
    expect(inZone('Europe/London', () => range('2026-10-25', '2026-10-25'))).toEqual({
      from: '2026-10-24T23:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
    });
  });

  it('Europe/London, the day before: `to` ends at the BST midnight that starts the 25th', () => {
    expect(inZone('Europe/London', () => range('2026-10-24', '2026-10-24'))).toEqual({
      from: '2026-10-23T23:00:00.000Z',
      to: '2026-10-24T23:00:00.000Z',
    });
  });

  it('Europe/London, the day the clocks go forward (29 March 2026, 23 hours): the whole of it', () => {
    // 29 Mar begins at 00:00 GMT (00:00Z) and the 30th at 00:00 BST (23:00Z on the 29th).
    expect(inZone('Europe/London', () => range('2026-03-29', '2026-03-29'))).toEqual({
      from: '2026-03-29T00:00:00.000Z',
      to: '2026-03-29T23:00:00.000Z',
    });
  });

  it('Asia/Beirut, whose clocks go back AT midnight (25 October 2026): the repeated last hour is kept', () => {
    // The 25th begins at 00:00 EET (22:00Z on the 24th), after 23:00–24:00 local has happened twice.
    expect(inZone('Asia/Beirut', () => range('2026-10-24', '2026-10-24'))).toEqual({
      from: '2026-10-23T21:00:00.000Z',
      to: '2026-10-24T22:00:00.000Z',
    });
  });

  it('America/Havana, whose clocks go forward AT midnight (8 March 2026): the first instant that exists', () => {
    // There is no 00:00 on the 8th: it begins at 01:00 CDT (05:00Z); the 9th at 00:00 CDT (04:00Z).
    expect(inZone('America/Havana', () => range('2026-03-08', '2026-03-08'))).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
  });
});
