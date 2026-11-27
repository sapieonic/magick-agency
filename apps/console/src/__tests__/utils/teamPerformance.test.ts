import { describe, it, expect } from 'vitest';
import { COMPARE_PAGE_MAX_AGENTS } from '@magick-agency/contracts/api/agency/compare';
import { TEAM_OUTCOME_BARS_MAX } from '@magick-agency/contracts/api/agency/team-performance';
import { ApiError } from '../../api/client';
import { isRetryableTeamError, teamErrorMessage } from '../../api/teamPerformance';
import { compareStateFromParams } from '../../utils/agency/compare/compareUrl';
import {
  comparePickedPath,
  teamStateFromParams,
  teamStateToParams,
  teamWindowDates,
  teamWindowError,
  togglePick,
  windowHoldsToday,
} from '../../utils/agency/team/teamUrl';
import {
  allowedWords,
  asOfWords,
  callbacksTile,
  chooseLine,
  compareDisabledReason,
  findingBadge,
  mainLabel,
  mainLine,
  outcomeLabel,
  outcomesFootnote,
  outcomesTitle,
  percent,
  picksLine,
  rateLabel,
  rateWords,
  trendLine,
  withheldWords,
} from '../../utils/agency/team/teamCopy';
import { rowName, sortTeamRows } from '../../utils/agency/team/teamSort';
import {
  dayLabel,
  inlineScale,
  inlineShare,
  mainOutcomeBarCount,
  outcomeBars,
  trendColumnsGeometry,
} from '../../utils/agency/team/teamCharts';
import { TEAM_ALL_CAMPAIGNS, TEAM_ONE_CAMPAIGN } from '../helpers/teamRecorded';

/**
 * Team performance's leaves (`docs/team-performance.md`): the URL state, the words, the table's
 * order and the chart geometry, held to the recorded answers (`helpers/teamRecorded.ts`).
 */

describe('the URL (teamUrl)', () => {
  it('opens on All campaigns, Today, sorted by the rate', () => {
    expect(teamStateFromParams(new URLSearchParams())).toEqual({ campaignId: null, window: 'today', from: null, to: null, sort: 'rate' });
    expect(teamStateToParams(teamStateFromParams(new URLSearchParams())).toString()).toBe('');
  });

  it('round-trips a campaign, a custom window and a sort, and drops what it does not know', () => {
    const state = { campaignId: 'c-1', window: 'custom' as const, from: '2026-11-01', to: '2026-11-07', sort: 'shortest' as const };
    expect(teamStateFromParams(teamStateToParams(state))).toEqual(state);
    expect(teamStateFromParams(new URLSearchParams('when=fortnight&sort=best&from=2026-11-01'))).toEqual({
      campaignId: null,
      window: 'today',
      from: null,
      to: null,
      sort: 'rate',
    });
    for (const [when, preset] of [['week', 'this_week'], ['7d', 'last_7_days'], ['30d', 'last_30_days']] as const) {
      expect(teamStateFromParams(new URLSearchParams(`when=${when}`)).window).toBe(preset);
    }
  });

  it('reads the window as Compare does: the reports’ rule, ending no later than today', () => {
    expect(teamWindowDates({ window: 'today', from: null, to: null }, '2026-11-17')).toEqual({ from: '2026-11-17', to: '2026-11-17' });
    expect(teamWindowDates({ window: 'this_week', from: null, to: null }, '2026-11-17')).toEqual({ from: '2026-11-16', to: '2026-11-17' });
    expect(teamWindowError({ from: '2026-10-01', to: '2026-11-17' }, '2026-11-17')).toMatch(/at most 30 days/);
    expect(teamWindowError(null, '2026-11-17')).toBe('Choose a start and an end date.');
    expect(windowHoldsToday({ from: '2026-11-11', to: '2026-11-17' }, '2026-11-17')).toBe(true);
    expect(windowHoldsToday({ from: '2026-11-01', to: '2026-11-07' }, '2026-11-17')).toBe(false);
  });

  it(`picks at most ${COMPARE_PAGE_MAX_AGENTS}: a fourth changes nothing, and unpicking frees a place`, () => {
    let picks: string[] = [];
    for (const id of ['a', 'b', 'c', 'd']) picks = togglePick(picks, id);
    expect(picks).toEqual(['a', 'b', 'c']);
    picks = togglePick(picks, 'b');
    expect(picks).toEqual(['a', 'c']);
    expect(togglePick(picks, 'd')).toEqual(['a', 'c', 'd']);
  });

  it('opens Compare agents on the campaign, the same window and the picks in pick order', () => {
    const path = comparePickedPath({ window: 'today', from: null, to: null }, 'c-1', ['x', 'y']);
    expect(path.startsWith('/agency/compare?')).toBe(true);
    const state = compareStateFromParams(new URLSearchParams(path.split('?')[1]));
    expect(state).toMatchObject({ campaignId: 'c-1', window: 'today', slots: ['x', 'y', null] });
    const custom = compareStateFromParams(
      new URLSearchParams(comparePickedPath({ window: 'custom', from: '2026-11-01', to: '2026-11-07' }, 'c-1', ['x']).split('?')[1]),
    );
    expect(custom).toMatchObject({ window: 'custom', from: '2026-11-01', to: '2026-11-07' });
  });
});

describe('the words (teamCopy)', () => {
  it('names the main outcome by its one catalog label, else Will pay or Successes (TP8)', () => {
    expect(mainLabel(TEAM_ONE_CAMPAIGN.main_outcome)).toBe('Will pay');
    expect(mainLabel(TEAM_ALL_CAMPAIGNS.main_outcome)).toBe('Will pay');
    expect(mainLabel({ kind: 'successes', label: null })).toBe('Successes');
    expect(mainLabel({ kind: 'successes', label: 'Sale made' })).toBe('Sale made');
    expect(rateLabel('Will pay')).toBe('Will-pay rate');
    expect(rateWords('Will pay')).toBe('will-pay rate');
    expect(rateWords('PTP')).toBe('PTP rate');
  });

  it('writes the tiles’ lines from the answer', () => {
    expect(mainLine(TEAM_ONE_CAMPAIGN.totals, 'Will pay', 20)).toBe('27% of calls handled');
    // Soft-phone and inbound calls in the rate (TP4): the line says so.
    expect(mainLine(TEAM_ALL_CAMPAIGNS.totals, 'Will pay', 20)).toBe('26% will-pay rate · counts 12 soft-phone and inbound calls');
    expect(
      mainLine({ main: { value: 0.25, numerator: 3, denominator: 12, reportable: false, interval: null, withheld: 'too_few' }, other_conversations: 0 }, 'Will pay', 20),
    ).toBe('Too few calls for a rate (12; needs 20)');
    expect(chooseLine(TEAM_ONE_CAMPAIGN.totals.wrapup_allowed)).toBe('average · 30 s allowed');
    expect(allowedWords({ seconds: 0, varies: false })).toBe('no time limit');
    expect(chooseLine(TEAM_ALL_CAMPAIGNS.totals.wrapup_allowed)).toBe('average · allowed time differs by campaign');
    expect(callbacksTile(TEAM_ONE_CAMPAIGN.totals.callbacks, true)).toEqual({ value: '21', of: 'of 28', line: 'due so far today' });
    expect(callbacksTile(TEAM_ONE_CAMPAIGN.totals.callbacks, false).line).toBe('due in this period');
    expect(callbacksTile({ due: 0, on_time: 0, late: 0, missed: 0, pending_due: 0, upcoming: 0 }, true).line).toBe('No call-backs due yet');
    expect(percent(0.2722)).toBe('27%');
  });

  it('says the period and how far it runs (TP11)', () => {
    expect(asOfWords('today', { from: '2026-11-17', to: '2026-11-17' }, '2026-11-17T08:45:12.000Z', true)).toBe('Today, up to 8:45 AM');
    expect(asOfWords('custom', { from: '2026-11-01', to: '2026-11-07' }, '2026-11-17T08:45:12.000Z', false)).toBe('1 Nov to 7 Nov');
    expect(trendLine(TEAM_ONE_CAMPAIGN.trend)).toBe('whole team, last 7 working days');
    expect(trendLine(TEAM_ALL_CAMPAIGNS.trend)).toBe('whole team, 6 working days');
    expect(outcomesTitle('today', 360)).toBe('What happened on today’s 360 calls');
    expect(outcomesTitle('last_7_days', 2120)).toBe('What happened on 2,120 calls');
  });

  it('writes an outcome without a label as the code, and none chosen as such (TP13)', () => {
    expect(outcomeLabel({ code: null, label: null })).toBe('No outcome chosen');
    expect(outcomeLabel({ code: 'no_disposition', label: 'Whatever' })).toBe('No outcome chosen');
    expect(outcomeLabel({ code: 'legacy_paid', label: null })).toBe('legacy_paid');
    expect(outcomesFootnote('Will pay', 96, 96)).toBeNull();
    expect(outcomesFootnote('Will pay', 96, 98)).toMatch(/Will pay here is 96, the tile above says 98/);
  });

  it('words Worth a look as TP15: Stands out, Low {label} rate, Slow to choose outcome', () => {
    const badges = TEAM_ONE_CAMPAIGN.findings.map((f) => findingBadge(f, 'Will pay')?.label);
    expect(badges.sort()).toEqual(['Low will-pay rate', 'Slow to choose outcome', 'Stands out']);
    expect(findingBadge({ code: 'too_few_calls', metric: 'promises_rate' }, 'Will pay')).toBeNull();
  });

  it('says under the floor in words, and why Compare picked is off', () => {
    expect(withheldWords({ value: 0.12, numerator: 2, denominator: 17, reportable: false, interval: null, withheld: 'too_few' }, 20)).toBe(
      'Too few calls (17; needs 20)',
    );
    expect(picksLine(2)).toBe('2 of 3 picked');
    expect(compareDisabledReason(false, 2)).toBe('Choose one campaign to see who’s worth a look and to compare agents.');
    expect(compareDisabledReason(true, 0)).toBe('Pick up to 3 agents to compare.');
    expect(compareDisabledReason(true, 1)).toBeNull();
  });

  it('words each refusal, and offers Try again only for one that can clear by itself', () => {
    const refusal = (status: number, code?: string) => new ApiError(status, code ? { error: 'x', code, message: 'fallback' } : { error: 'x', message: 'fallback' });
    expect(teamErrorMessage(refusal(503, 'team_timed_out'), 'f')).toBe('Too much to read at once. Try a shorter period.');
    expect(isRetryableTeamError(refusal(503, 'team_timed_out'))).toBe(true);
    expect(isRetryableTeamError(refusal(429, 'team_busy'))).toBe(true);
    expect(isRetryableTeamError(refusal(400, 'team_window_invalid'))).toBe(false);
    expect(isRetryableTeamError(refusal(404, 'team_campaign_not_found'))).toBe(false);
    expect(isRetryableTeamError(refusal(403, 'feature_disabled'))).toBe(false);
    expect(isRetryableTeamError(refusal(502))).toBe(true);
    expect(isRetryableTeamError(new TypeError('Failed to fetch'))).toBe(true);
    expect(teamErrorMessage(new TypeError('Failed to fetch'), 'f')).toMatch(/Couldn’t reach the server/);
    expect(teamErrorMessage(refusal(403), 'f')).toBe('You don’t have permission to see the team’s figures.');
  });
});

describe('the table’s order (teamSort, TP16)', () => {
  const names = (sort: 'rate' | 'calls' | 'shortest') => sortTeamRows(TEAM_ONE_CAMPAIGN.agents, sort).map(rowName);

  it('by the rate: rows over the floor first, highest first; the rest by calls', () => {
    expect(names('rate')).toEqual([
      'Lakshmi P',
      'Swapna K',
      'Ravi Kumar',
      'Kiran J',
      'Divya S',
      // 12 of 44 and 9 of 33 are the same rate: more calls first.
      'Arjun T',
      'Sandeep R',
      'Mahesh B',
      'Pooja M',
      'Farhan A',
    ]);
  });

  it('by calls handled, most first; by shortest calls, a row with no calls last', () => {
    expect(names('calls').slice(0, 3)).toEqual(['Lakshmi P', 'Swapna K', 'Arjun T']);
    const rows = [...TEAM_ONE_CAMPAIGN.agents, { ...TEAM_ONE_CAMPAIGN.agents[0]!, agent_user_id: 'z', agent_name: 'Nobody', calls_handled: 0, avg_call_seconds: null }];
    const shortest = sortTeamRows(rows, 'shortest').map(rowName);
    expect(shortest[0]).toBe('Lakshmi P');
    expect(shortest.at(-1)).toBe('Nobody');
  });

  it('never changes the answer it was given', () => {
    const before = TEAM_ONE_CAMPAIGN.agents.map((a) => a.agent_user_id);
    sortTeamRows(TEAM_ONE_CAMPAIGN.agents, 'calls');
    expect(TEAM_ONE_CAMPAIGN.agents.map((a) => a.agent_user_id)).toEqual(before);
  });
});

describe('the chart geometry (teamCharts)', () => {
  it('draws one column per working day on a clean axis, the last one labelled (TP12)', () => {
    const g = trendColumnsGeometry({ width: 600, trend: TEAM_ONE_CAMPAIGN.trend });
    expect(g.columns).toHaveLength(7);
    expect(g.top).toBe(200);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 100, 200]);
    expect(g.lastLabel?.text).toBe(98);
    expect(g.columns.map((c) => c.label)).toEqual(['Tue 10', 'Wed 11', 'Thu 12', 'Fri 13', 'Sat 14', 'Mon 16', 'Tue 17']);
    // Every column sits inside the plot, left to right.
    const xs = g.columns.map((c) => c.cx);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[0]!).toBeGreaterThan(g.left);
    expect(xs.at(-1)!).toBeLessThan(g.right);
    // A taller count is a taller column: Fri 13 (106) over Sat 14 (74).
    const height = (i: number) => Number(/L[\d.]+,([\d.]+)/.exec(g.columns[i]!.path)![1]);
    expect(height(3)).toBeLessThan(height(4));
  });

  it('thins the day labels on a narrow chart, always keeping the last', () => {
    const month = { dates: Array.from({ length: 26 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`), counts: Array.from({ length: 26 }, () => 10) };
    const g = trendColumnsGeometry({ width: 320, trend: month });
    const labelled = g.columns.filter((c) => c.label !== null);
    expect(labelled.length).toBeLessThan(26);
    expect(g.columns.at(-1)!.label).toBe(dayLabel('2026-11-26'));
  });

  it(`draws the first ${TEAM_OUTCOME_BARS_MAX} outcomes and folds the rest into Other outcomes (TP13)`, () => {
    const bars = outcomeBars(TEAM_ALL_CAMPAIGNS.outcomes);
    expect(bars).toHaveLength(TEAM_OUTCOME_BARS_MAX + 1);
    expect(bars.at(-1)).toMatchObject({ label: 'Other outcomes', conversations: 12 + 6 + 4, other: true });
    expect(bars[0]!.share).toBe(100);
    expect(outcomeBars(TEAM_ONE_CAMPAIGN.outcomes).map((b) => b.label)).toEqual([
      'Will pay',
      'No one spoke',
      'Call later',
      'Refused',
      'Wrong number',
      'Don’t call again',
    ]);
    expect(mainOutcomeBarCount(TEAM_ONE_CAMPAIGN.outcomes, TEAM_ONE_CAMPAIGN.main_outcome.codes)).toBe(96);
    expect(mainOutcomeBarCount(TEAM_ALL_CAMPAIGNS.outcomes, TEAM_ALL_CAMPAIGNS.main_outcome.codes)).toBe(74 + 22);
  });

  it('scales the inline bars so every bar and the median tick fit', () => {
    expect(inlineScale([10, 40, null], 20)).toBe(40);
    expect(inlineScale([null], null)).toBe(1);
    expect(inlineShare(20, 40)).toBe(50);
    expect(inlineShare(null, 40)).toBeNull();
    expect(inlineShare(80, 40)).toBe(100);
  });
});
