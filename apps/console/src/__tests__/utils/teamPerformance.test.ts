import { describe, it, expect } from 'vitest';
import { COMPARE_PAGE_MAX_AGENTS } from '@magick-agency/contracts/api/agency/compare';
import { TEAM_OUTCOME_BARS_MAX } from '@magick-agency/contracts/api/agency/team-performance';
import { compareStateFromParams } from '../../utils/agency/compare/compareUrl';
import {
  answerAwaitsFinalRead,
  answerRunsToNow,
  comparePickedPath,
  teamStateFromParams,
  teamStateToParams,
  teamWindowDates,
  teamWindowError,
  togglePick,
  windowAutoRefreshes,
  windowHoldsToday,
  windowShorterThanWeek,
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
  mixedNote,
  outcomeLabel,
  outcomesFootnote,
  outcomesTitle,
  percent,
  picksLine,
  datesWords,
  rateLabel,
  rateWords,
  refreshFailedWords,
  rollupLine,
  staleWords,
  trendLine,
  withheldWords,
} from '../../utils/agency/team/teamCopy';
import { sortTeamRows } from '../../utils/agency/team/teamSort';
import { agentDisplayName } from '../../utils/agencyAgentFloor';
import {
  dayLabel,
  inlineScale,
  inlineShare,
  outcomeBars,
  trendAxis,
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

  it('reads again on its own only a window that holds today and spans at most 7 days (§2 States)', () => {
    const today = '2026-11-17';
    expect(windowAutoRefreshes({ from: today, to: today }, today)).toBe(true);
    expect(windowAutoRefreshes({ from: '2026-11-11', to: today }, today)).toBe(true);
    expect(windowAutoRefreshes({ from: '2026-11-10', to: today }, today)).toBe(false);
    expect(windowAutoRefreshes({ from: '2026-10-19', to: today }, today)).toBe(false);
    expect(windowAutoRefreshes({ from: '2026-11-01', to: '2026-11-07' }, today)).toBe(false);
    expect(windowAutoRefreshes(null, today)).toBe(false);
  });

  it('offers the last 7 days on an empty period only when the window is shorter than that (§2 States)', () => {
    expect(windowShorterThanWeek({ from: '2026-11-17', to: '2026-11-17' })).toBe(true);
    expect(windowShorterThanWeek({ from: '2026-11-12', to: '2026-11-17' })).toBe(true);
    expect(windowShorterThanWeek({ from: '2026-11-11', to: '2026-11-17' })).toBe(false);
    expect(windowShorterThanWeek({ from: '2026-10-19', to: '2026-11-17' })).toBe(false);
    expect(windowShorterThanWeek(null)).toBe(false);
  });

  it('says an answer runs to now from the answer itself: read inside its window, in its zone (TP11)', () => {
    const answer = { from: '2026-11-15', to: '2026-11-17', timezone: 'Asia/Kolkata' };
    // 18:00 UTC on 17 Nov is 23:30 in Kolkata: still the window's last day.
    expect(answerRunsToNow({ ...answer, as_of: '2026-11-17T18:00:00.000Z' })).toBe(true);
    // 18:40 UTC is 00:10 on 18 Nov in Kolkata: read after the window ended, so it covers all of it.
    expect(answerRunsToNow({ ...answer, as_of: '2026-11-17T18:40:00.000Z' })).toBe(false);
    expect(answerRunsToNow({ ...answer, as_of: '2026-11-20T08:00:00.000Z' })).toBe(false);
    expect(answerRunsToNow({ ...answer, as_of: 'not a time' })).toBe(false);
  });

  it('reads a short window once more when the day has passed its end under an answer that ran to now', () => {
    const ranToNow = { from: '2026-11-15', to: '2026-11-17', timezone: 'UTC', as_of: '2026-11-17T23:50:00.000Z' };
    expect(answerAwaitsFinalRead(ranToNow, '2026-11-17')).toBe(false);
    expect(answerAwaitsFinalRead(ranToNow, '2026-11-18')).toBe(true);
    // Already read after the window ended: nothing more to read.
    expect(answerAwaitsFinalRead({ ...ranToNow, as_of: '2026-11-18T00:01:00.000Z' }, '2026-11-18')).toBe(false);
    // A month is the heavy read: kept as it is.
    expect(answerAwaitsFinalRead({ ...ranToNow, from: '2026-10-19' }, '2026-11-18')).toBe(false);
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

  it('names the successes fallback’s rate in the singular: Success rate, Low success rate', () => {
    const label = mainLabel({ kind: 'successes', label: null });
    expect(rateLabel(label)).toBe('Success rate');
    expect(rateWords(label)).toBe('success rate');
    expect(findingBadge({ code: 'clear_gap', metric: 'success_rate' }, label)).toEqual({ label: 'Low success rate', tone: 'watch' });
    expect(
      mainLine({ main: { value: 0.3, numerator: 30, denominator: 100, reportable: true, interval: null, withheld: null }, other_conversations: 4 }, label, 20),
    ).toBe('30% success rate · counts 4 soft-phone and inbound calls');
    // A catalog's own label keeps its words.
    expect(rateLabel('Sale made')).toBe('Sale-made rate');
  });

  it('says calmly that some campaigns record no promises, in the label’s words (TP8)', () => {
    expect(mixedNote('Will pay')).toBe('Some campaigns here don’t record Will pay; their calls still count in the will-pay rate.');
    expect(mixedNote('PTP')).toBe('Some campaigns here don’t record PTP; their calls still count in the PTP rate.');
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
    expect(percent(0.2722)).toBe('27%');
  });

  it('words Call-backs on time by how far the answer runs (TP10, TP11)', () => {
    const { callbacks } = TEAM_ONE_CAMPAIGN.totals;
    const none = { due: 0, on_time: 0, late: 0, missed: 0, pending_due: 0, upcoming: 0 };
    expect(callbacksTile(callbacks, { runsToNow: true, oneDay: true })).toEqual({ value: '21', of: 'of 28', line: 'due so far today' });
    expect(callbacksTile(callbacks, { runsToNow: true, oneDay: false }).line).toBe('due so far');
    expect(callbacksTile(callbacks, { runsToNow: false, oneDay: true }).line).toBe('due in this period');
    expect(callbacksTile(none, { runsToNow: true, oneDay: true }).line).toBe('No call-backs due yet');
    expect(callbacksTile({ ...none, upcoming: 4 }, { runsToNow: true, oneDay: false }).line).toBe('No call-backs due yet · 4 later today');
    expect(callbacksTile(none, { runsToNow: false, oneDay: false })).toEqual({ value: '—', of: null, line: 'No call-backs were due' });
  });

  it('says the period and how far it runs (TP11)', () => {
    expect(asOfWords('today', { from: '2026-11-17', to: '2026-11-17' }, '2026-11-17T08:45:12.000Z', true)).toBe('Today, up to 8:45 AM');
    expect(asOfWords('custom', { from: '2026-11-01', to: '2026-11-07' }, '2026-11-17T08:45:12.000Z', false)).toBe('1 Nov to 7 Nov');
    expect(trendLine(TEAM_ONE_CAMPAIGN.trend)).toBe('whole team, last 7 working days');
    expect(trendLine(TEAM_ALL_CAMPAIGNS.trend)).toBe('whole team, 6 working days');
    expect(outcomesTitle('today', 360)).toBe('What happened on today’s 360 calls');
    expect(outcomesTitle('last_7_days', 2120)).toBe('What happened on 2,120 calls');
    expect(datesWords({ from: '2026-11-11', to: '2026-11-17' })).toBe('11 Nov to 17 Nov');
    expect(datesWords({ from: '2026-11-17', to: '2026-11-17' })).toBe('17 Nov');
  });

  it('names what stale figures are for: their dates, and their campaign when it is not the one chosen', () => {
    const dates = { from: '2026-11-11', to: '2026-11-17' };
    expect(staleWords(dates, { differs: false, all: false, name: 'Nov dues' })).toBe(
      'These are the last figures that loaded, for 11 Nov to 17 Nov, not for the filters above.',
    );
    expect(staleWords(dates, { differs: true, all: false, name: 'Nov dues' })).toBe(
      'These are the last figures that loaded, for Nov dues, 11 Nov to 17 Nov, not for the filters above.',
    );
    expect(staleWords(dates, { differs: true, all: true, name: null })).toBe(
      'These are the last figures that loaded, for all campaigns, 11 Nov to 17 Nov, not for the filters above.',
    );
    expect(staleWords(dates, { differs: true, all: false, name: null })).toContain('for another campaign, 11 Nov to 17 Nov');
  });

  it('says how fresh the bars are, as a line of its own, and a failed refresh calmly', () => {
    const now = new Date('2026-11-17T08:50:00.000Z');
    expect(rollupLine('2026-11-17T08:40:00.000Z', now)).toBe('Dialler calls only · as of 8:40 AM');
    // Not today's: the day too.
    expect(rollupLine('2026-11-16T23:58:00.000Z', now)).toBe('Dialler calls only · as of 16 Nov, 11:58 PM');
    expect(rollupLine(null, now)).toBe('Dialler calls only');
    expect(refreshFailedWords('2026-11-17T08:45:12.000Z')).toBe('Couldn’t refresh. Showing figures up to 8:45 AM.');
  });

  it('writes an outcome without a label as the code, and none chosen as such (TP13)', () => {
    expect(outcomeLabel({ code: null, label: null })).toBe('No outcome chosen');
    expect(outcomeLabel({ code: 'no_disposition', label: 'Whatever' })).toBe('No outcome chosen');
    expect(outcomeLabel({ code: 'legacy_paid', label: null })).toBe('legacy_paid');
    const promises = { kind: 'promises' as const, otherCalls: 0 };
    expect(outcomesFootnote('Will pay', 96, 96, promises)).toBeNull();
    expect(outcomesFootnote('Will pay', 96, 98, { kind: 'promises', otherCalls: 12 })).toBe(
      'The tile also counts Will pay on soft-phone and inbound calls (98 vs 96 here).',
    );
    expect(outcomesFootnote('Will pay', 96, 98, promises)).toBe(
      'The tile counts Will pay on the day it was given, the bars on the day the call was made (98 vs 96 here).',
    );
    expect(outcomesFootnote('Interested', 40, 41, { kind: 'successes', otherCalls: 0 })).toBe('The bars are a few minutes behind the tile (41 vs 40 here).');
  });

  it('words Worth a look as TP15: Stands out, Low will-pay rate, Slow to choose outcome', () => {
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
});

describe('the table’s order (teamSort, TP16)', () => {
  const names = (sort: 'rate' | 'calls' | 'shortest') => sortTeamRows(TEAM_ONE_CAMPAIGN.agents, sort).map(agentDisplayName);

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
    const shortest = sortTeamRows(rows, 'shortest').map(agentDisplayName);
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
    // The tallest column is 106: the axis tops out at 120, not 200, so the columns fill the plot.
    expect(g.top).toBe(120);
    expect(g.ticks.map((t) => t.value)).toEqual([0, 40, 80, 120]);
    expect(g.ticks[0]!.y).toBe(g.baseline);
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

  it('tops the axis just over the tallest column, on whole-number lines three or four gaps apart', () => {
    const lines = (max: number) => {
      const { top, step } = trendAxis(max);
      return Array.from({ length: top / step + 1 }, (_, k) => k * step);
    };
    expect(lines(105)).toEqual([0, 40, 80, 120]);
    expect(lines(98)).toEqual([0, 25, 50, 75, 100]);
    expect(lines(100)).toEqual([0, 25, 50, 75, 100]);
    expect(lines(7)).toEqual([0, 2, 4, 6, 8]);
    expect(lines(3)).toEqual([0, 1, 2, 3]);
    expect(lines(0)).toEqual([0, 1, 2]);
    expect(lines(1)).toEqual([0, 1, 2]);
    expect(lines(1234)).toEqual([0, 500, 1000, 1500]);
    for (let max = 1; max <= 2000; max++) {
      const { top, step } = trendAxis(max);
      expect(Number.isInteger(step) && top >= max && top / step <= 4, `max ${max}`).toBe(true);
      // Never more than half again the tallest column, past the smallest charts.
      if (max >= 10) expect(top / max, `max ${max}`).toBeLessThanOrEqual(1.5);
    }
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
    expect(bars.at(-1)).toMatchObject({ key: '…other', label: 'Other outcomes', conversations: 12 + 6 + 4 });
    expect(bars[0]!.share).toBe(100);
    expect(outcomeBars(TEAM_ONE_CAMPAIGN.outcomes).map((b) => b.label)).toEqual([
      'Will pay',
      'No one spoke',
      'Call later',
      'Refused',
      'Wrong number',
      'Don’t call again',
    ]);
  });

  it('scales the inline bars so every bar and the median tick fit', () => {
    expect(inlineScale([10, 40, null], 20)).toBe(40);
    expect(inlineScale([null], null)).toBe(1);
    expect(inlineShare(20, 40)).toBe(50);
    expect(inlineShare(null, 40)).toBeNull();
    expect(inlineShare(80, 40)).toBe(100);
  });
});
