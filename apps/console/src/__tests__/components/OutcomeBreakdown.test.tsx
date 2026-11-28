import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AgencyTeamPerformance } from '@magick-agency/contracts/api/agency/team-performance';
import { OutcomeBreakdown } from '../../components/agency/team/OutcomeBreakdown';
import { TEAM_ALL_CAMPAIGNS, TEAM_ONE_CAMPAIGN } from '../helpers/teamRecorded';

/**
 * What happened on the calls' footnote (`docs/team-performance.md` TP13): the main outcome's share
 * of the bars is the server's `main_outcome.bar_conversations`, counted per campaign before the bars
 * merge campaigns by code. With All campaigns a code can be the main outcome in one campaign and a
 * plain outcome in another, so a sum of the merged bars over `main_outcome.codes` would count the
 * other campaign's calls too; the footnote never sums them.
 */

afterEach(cleanup);

const footnote = () => screen.queryByTestId('team-outcomes-footnote')?.textContent ?? null;

function withBarMain(a: AgencyTeamPerformance, bar: number, tile: number): AgencyTeamPerformance {
  return {
    ...a,
    main_outcome: { ...a.main_outcome, bar_conversations: bar },
    totals: { ...a.totals, main: { ...a.totals.main, numerator: tile } },
  };
}

describe('OutcomeBreakdown footnote', () => {
  it('compares the tile with the server\'s count, not with the merged bars on the main codes', () => {
    // The bars on will_pay and promise_to_pay hold 74 + 22 = 96 conversations, of which 80 are the
    // main outcome in their own campaign.
    render(<OutcomeBreakdown data={withBarMain(TEAM_ALL_CAMPAIGNS, 80, 98)} label="Will pay" preset="last_7_days" />);
    expect(footnote()).toMatch(/\(98 vs 80 here\)/);
  });

  it('says nothing when the server\'s count equals the tile, whatever the merged bars sum to', () => {
    render(<OutcomeBreakdown data={withBarMain(TEAM_ALL_CAMPAIGNS, 98, 98)} label="Will pay" preset="last_7_days" />);
    expect(footnote()).toBeNull();
  });

  it('with one campaign the count is the main bars, so the page tests\' answer footnotes 98 vs 96', () => {
    render(<OutcomeBreakdown data={TEAM_ONE_CAMPAIGN} label="Will pay" preset="today" />);
    expect(footnote()).toMatch(/\(98 vs 96 here\)/);
  });
});
