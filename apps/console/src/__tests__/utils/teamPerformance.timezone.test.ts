import { describe, it, expect } from 'vitest';
import { asOfWords } from '../../utils/agency/team/teamCopy';
import { teamWindowDates, windowHoldsToday } from '../../utils/agency/team/teamUrl';
import { browserZone, todayIn } from '../../utils/reports/reportWindow';
import { TEAM_ONE_CAMPAIGN } from '../helpers/teamRecorded';

/**
 * Team performance read from somewhere other than Greenwich (`docs/team-performance.md` TP11):
 * the window is the READER's local dates, sent with the browser's zone by its current name, and
 * "Today, up to 2:15 PM" is on the reader's clock. In the suite's pinned `TZ=UTC` the local day
 * and the wire's agree, so these run in the `timezone` project, where a `TZ` assignment moves the
 * clock (`agentWindows.timezone.test.ts`). Every expectation is worked out by hand.
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

describe('Team performance in Kolkata (+05:30)', () => {
  it('sends the browser’s zone by its current name', () => {
    expect(inZone('Asia/Kolkata', () => browserZone())).toBe('Asia/Kolkata');
    // ICU's legacy name for it is answered with the current one.
    expect(inZone('Asia/Calcutta', () => browserZone())).toBe('Asia/Kolkata');
  });

  it('turns Today at local midnight, not UTC’s', () => {
    // 18:20Z on the 16th is 23:50 on the 16th in Kolkata; 18:40Z is 00:10 on the 17th.
    const before = inZone('Asia/Kolkata', () => todayIn(browserZone(), new Date('2026-11-16T18:20:00.000Z')));
    const after = inZone('Asia/Kolkata', () => todayIn(browserZone(), new Date('2026-11-16T18:40:00.000Z')));
    expect(before).toBe('2026-11-16');
    expect(after).toBe('2026-11-17');
    expect(teamWindowDates({ window: 'today', from: null, to: null }, after)).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(teamWindowDates({ window: 'this_week', from: null, to: null }, after)).toEqual({ from: '2026-11-16', to: '2026-11-17' });
    expect(windowHoldsToday({ from: '2026-11-16', to: '2026-11-16' }, after)).toBe(false);
  });

  it('says how far Today runs on the reader’s clock', () => {
    // as_of 08:45:12Z is 2:15 PM in Kolkata.
    const words = inZone('Asia/Kolkata', () =>
      asOfWords('today', { from: '2026-11-17', to: '2026-11-17' }, TEAM_ONE_CAMPAIGN.as_of, true),
    );
    expect(words).toBe('Today, up to 2:15 PM');
  });
});
