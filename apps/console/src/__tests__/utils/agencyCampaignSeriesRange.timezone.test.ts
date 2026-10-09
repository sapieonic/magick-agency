/**
 * The campaign series range, in a zone whose clocks move AT MIDNIGHT.
 *
 * ── Why this file exists separately ────────────────────────────────────────
 * The main suite is pinned `TZ=UTC` (`vite.config.ts`, at module scope, on the
 * main thread — see the test config). A non-UTC assertion written
 * into an ordinary test file silently reads UTC and passes whatever the code
 * does, which is worse than no test. `*.timezone.test.ts` files form a second
 * vitest project on `pool: 'forks'`, the only place `process.env.TZ` actually
 * moves the clock.
 *
 * ── The defect it was written for ─────────────────────────────────────────
 * `campaignSeriesRange` walked days with `addDays` from a `startOfDay` anchor.
 * `addDays` preserves its anchor's WALL-CLOCK time, and in Santiago on
 * 2026-09-06 local midnight does not exist (00:00 → 01:00), so `startOfDay`
 * resolved to 01:00 and every boundary inherited that hour:
 *
 *     from  2026-08-31T05:00Z   (local midnight is 04:00Z)
 *     to    2026-09-07T04:00Z   (local midnight is 03:00Z)
 *
 * Both an hour late — so the window excluded the first hour of the first day on
 * the chart and included the first hour of the day AFTER the last one. The fix
 * walks from local noon, which exists exactly once in every zone, and converts
 * to midnight only at the boundaries.
 *
 * The sibling file's claim that "nothing here needs a second zone" was what
 * stopped this being written the first time.
 */
process.env.TZ = 'America/Santiago';

import { describe, it, expect } from 'vitest';
import { campaignSeriesRange } from '../../utils/agencyCampaignSeries';

/** The true local midnight starting the given calendar day, as an instant. */
function localMidnight(year: number, month1: number, day: number): string {
  return new Date(year, month1 - 1, day, 0, 0, 0, 0).toISOString();
}

const live = { finished: false };

describe('campaignSeriesRange across a spring-forward at midnight', () => {
  // Chile springs forward 2026-09-06: 00:00 becomes 01:00, so that day has no
  // local midnight at all.
  const DURING = new Date('2026-09-06T15:00:00Z');

  it('starts the range at the first day’s REAL local midnight', () => {
    expect(campaignSeriesRange('7d', live, DURING).from).toBe(localMidnight(2026, 8, 31));
  });

  it('ends it at the real local midnight after the last day, not an hour later', () => {
    // An hour late here means attempts from a day that is not on the chart fall
    // inside the window.
    expect(campaignSeriesRange('7d', live, DURING).to).toBe(localMidnight(2026, 9, 7));
  });

  it('still spans exactly the number of days it says', () => {
    expect(campaignSeriesRange('7d', live, DURING).days).toBe(7);
    expect(campaignSeriesRange('30d', live, DURING).days).toBe(30);
  });

  it('holds when the anchor IS the transition day’s own start', () => {
    // `startOfDay` resolves to 01:00 on this day. Anchoring the walk there was
    // the whole bug.
    const range = campaignSeriesRange('7d', live, new Date('2026-09-06T04:30:00Z'));
    expect(range.from).toBe(localMidnight(2026, 8, 31));
    expect(range.to).toBe(localMidnight(2026, 9, 7));
  });
});

describe('campaignSeriesRange across a fall-back at midnight', () => {
  // Chile falls back 2026-04-05: 00:00 happens twice.
  const DURING = new Date('2026-04-05T15:00:00Z');

  it('takes the FIRST local midnight, so no hour is counted twice', () => {
    const range = campaignSeriesRange('7d', live, DURING);
    expect(range.from).toBe(localMidnight(2026, 3, 30));
    expect(range.to).toBe(localMidnight(2026, 4, 6));
    expect(range.days).toBe(7);
  });
});

describe('a terminal campaign anchored on a transition day', () => {
  it('ends on its own last day, at that day’s real midnight', () => {
    const range = campaignSeriesRange(
      'life',
      {
        finished: true,
        started_at: '2026-09-01T12:00:00Z',
        ended_at: '2026-09-06T18:00:00Z',
      },
      new Date('2026-09-20T15:00:00Z'),
    );
    // The day AFTER the campaign's last day — 7 September, not 7 September plus
    // the hour the transition ate.
    expect(range.to).toBe(localMidnight(2026, 9, 7));
    expect(range.partialToday).toBe(false);
  });
});
