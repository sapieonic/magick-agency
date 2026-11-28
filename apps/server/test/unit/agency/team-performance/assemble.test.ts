import { describe, expect, it } from 'vitest';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import {
  assembleTeamPerformance,
  mainOutcomeFor,
  outcomeBars,
  teamAgentRow,
  teamTrend,
  teamTrendRange,
  workedCampaigns,
  wrapupAllowed,
  type TeamAgentSources,
  type TeamAssembleInput,
  type TeamCampaign,
} from '../../../../src/agency/team-performance/assemble.js';

/**
 * Team performance's answer from the read's figures (docs/team-performance.md §3), pure: the main
 * outcome's rule (TP8), the chart's working days (TP12), the bars (TP13), the allowed time, the rows
 * and sums by Compare's rules (TP2), and findings only with one campaign (TP7, TP15). The SQL and the
 * figures against the roster and Compare are held on Postgres in
 * `test/integration/api/team-performance.test.ts`.
 */

const WILL_PAY: AgencyDisposition = { code: 'will_pay', label: 'Will pay', requires_promise: true };
const SALE: AgencyDisposition = { code: 'sale', label: 'Sale', is_success: true, icon: 'thumbs_up' };
/** Nothing worked in the window: the main outcome is decided over the whole scope. */
const NONE = workedCampaigns([], []);
const campaign = (id: string, catalog: AgencyDisposition[], o: Partial<TeamCampaign> = {}): TeamCampaign =>
  ({ id, wrapup_seconds: 30, catalog, rollup_as_of: null, ...o });

function agent(id: string, o: { connected?: number; successes?: number; promises?: number; other?: number; wrapup?: number; measured?: number } = {}): TeamAgentSources {
  const connected = o.connected ?? 100;
  return {
    agent_user_id: id, agent_name: `Agent ${id}`, departed: false,
    roster: { connected, successes: o.successes ?? 30, talk_seconds: connected * 60, wrapup_seconds: o.wrapup ?? connected * 20, measured_wrapups: o.measured ?? connected },
    occupancy: { shift_seconds: 28_800, break_seconds: 1_800 },
    promises: o.promises === undefined ? null : { promises: o.promises, other_conversations: o.other ?? 0 },
    callbacks: { on_time: 2, late: 1, missed: 1, pending_due: 1, pending_future: 3 },
  };
}

function input(o: Partial<TeamAssembleInput> = {}): TeamAssembleInput {
  return {
    campaignId: 'c1', from: '2026-11-01', to: '2026-11-07', timezone: 'Asia/Kolkata', asOf: new Date('2026-11-07T10:00:00Z'),
    main: mainOutcomeFor([campaign('c1', [SALE])], NONE),
    campaigns: [campaign('c1', [SALE])], agents: [agent('a')], rollupCodes: [],
    trendRange: teamTrendRange('2026-11-01', '2026-11-07'), rollupDays: [], promiseDays: new Map(), ...o,
  };
}

describe('the main outcome (TP8)', () => {
  const calls = (...ids: string[]) => ids.map((campaign_id) => ({ campaign_id, disposition_code: 'x', conversations: 3 }));

  it('is promises when any campaign worked in the window records them; a mixed scope is mixed', () => {
    const cs = [campaign('a', [SALE]), campaign('b', [SALE, WILL_PAY])];
    expect(mainOutcomeFor(cs, workedCampaigns(calls('a', 'b'), []))).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: true });
    expect(mainOutcomeFor(cs, workedCampaigns(calls('b'), []))).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: false });
  });

  it('an idle promise campaign does not make a successes day promises (only what was worked decides)', () => {
    const cs = [campaign('idle', [WILL_PAY]), campaign('dialled', [SALE])];
    expect(mainOutcomeFor(cs, workedCampaigns(calls('dialled'), []))).toEqual({ kind: 'successes', codes: ['sale'], label: 'Sale', mixed: false });
    // A promise recorded in the window on it (a soft-phone or inbound call) is work: promises, and mixed.
    expect(mainOutcomeFor(cs, workedCampaigns(calls('dialled'), ['idle']))).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: true });
    // Only promises on it, no dialler conversation on the success campaign: not mixed.
    expect(mainOutcomeFor(cs, workedCampaigns([], ['idle'])).mixed).toBe(false);
  });

  it('nothing worked in the window: decided over the whole scope, never mixed', () => {
    const cs = [campaign('a', [SALE]), campaign('b', [SALE, WILL_PAY])];
    expect(mainOutcomeFor(cs, NONE)).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: false });
    // A rollup row with no conversations is no work.
    expect(mainOutcomeFor(cs, workedCampaigns([{ campaign_id: 'a', disposition_code: 'x', conversations: 0 }], []))).toEqual(mainOutcomeFor(cs, NONE));
  });

  it('else successes, with their codes sorted and distinct', () => {
    const won = { code: 'won', label: 'Sale', is_success: true };
    expect(mainOutcomeFor([campaign('a', [SALE, won]), campaign('b', [SALE])], NONE)).toEqual({ kind: 'successes', codes: ['sale', 'won'], label: 'Sale', mixed: false });
  });

  it('sends the label only when the codes carry exactly one', () => {
    const promised = { code: 'promised', label: 'Promised', requires_promise: true };
    expect(mainOutcomeFor([campaign('a', [WILL_PAY]), campaign('b', [promised])], NONE).label).toBeNull();
    expect(mainOutcomeFor([], NONE).label).toBeNull();
    expect(mainOutcomeFor([], NONE)).toEqual({ kind: 'successes', codes: [], label: null, mixed: false });
  });
});

describe('the per-day chart (TP12)', () => {
  it('a window of 7 days or more is read as it is; a shorter one looks back 14 days from its last', () => {
    expect(teamTrendRange('2026-11-01', '2026-11-07')).toEqual({ span: 'window', from: '2026-11-01', to: '2026-11-07' });
    expect(teamTrendRange('2026-11-27', '2026-11-27')).toEqual({ span: 'last_working_days', from: '2026-11-14', to: '2026-11-27' });
    expect(teamTrendRange('2026-11-22', '2026-11-27')).toMatchObject({ span: 'last_working_days', from: '2026-11-14' });
  });

  it('keeps a day with a conversation or a count, leaves a day off out, and a short window keeps the last 7', () => {
    const range = teamTrendRange('2026-11-27', '2026-11-27');
    const day = (date: string, n: number) => ({ campaign_id: 'c1', date, disposition_code: 'other', conversations: n });
    // Nine working days in the 14, a day off between them, and one day with a promise but no dialler call.
    const days = ['2026-11-14', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24'].map((d) => day(d, 5));
    const promises = new Map([['2026-11-25', 2], ['2026-11-24', 1]]);
    const t = teamTrend(range, 'promises', [campaign('c1', [WILL_PAY])], days, promises);
    expect(t.span).toBe('last_working_days');
    expect(t.dates).toEqual(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(t.counts).toEqual([0, 0, 0, 0, 0, 1, 2]);
    // The 21st and 22nd (a weekend off) and the 26th–27th are not drawn as 0.
    expect(t.dates).not.toContain('2026-11-21');
  });

  it('a window holds every working day of it; a day with no conversation and no count is out', () => {
    const range = teamTrendRange('2026-11-01', '2026-11-08');
    const days = [
      { campaign_id: 'c1', date: '2026-11-02', disposition_code: 'sale', conversations: 3 },
      { campaign_id: 'c1', date: '2026-11-04', disposition_code: null, conversations: 2 },
    ];
    const t = teamTrend(range, 'successes', [campaign('c1', [SALE])], days, new Map());
    expect(t).toEqual({ span: 'window', dates: ['2026-11-02', '2026-11-04'], counts: [3, 0] });
  });

  it('counts a success by its own campaign\'s catalog: one code, a success on one campaign only', () => {
    const range = teamTrendRange('2026-11-01', '2026-11-07');
    const notASale = { code: 'sale', label: 'Sale (pending)' };
    const days = [
      { campaign_id: 'a', date: '2026-11-03', disposition_code: 'sale', conversations: 4 },
      { campaign_id: 'b', date: '2026-11-03', disposition_code: 'sale', conversations: 6 },
    ];
    expect(teamTrend(range, 'successes', [campaign('a', [SALE]), campaign('b', [notASale])], days, new Map()).counts).toEqual([4]);
  });
});

describe('what happened on the calls (TP13)', () => {
  it('every outcome, most first; a null code and no_disposition are one "no outcome chosen", last among equals', () => {
    const bars = outcomeBars([campaign('a', [SALE, WILL_PAY])], [
      { campaign_id: 'a', disposition_code: 'sale', conversations: 5 },
      { campaign_id: 'a', disposition_code: null, conversations: 3 },
      { campaign_id: 'a', disposition_code: 'no_disposition', conversations: 2 },
      { campaign_id: 'a', disposition_code: 'will_pay', conversations: 5 },
      { campaign_id: 'a', disposition_code: 'gone', conversations: 1 },
    ]);
    expect(bars).toEqual([
      { code: 'sale', label: 'Sale', icon: 'thumbs_up', conversations: 5 },
      { code: 'will_pay', label: 'Will pay', icon: null, conversations: 5 },
      { code: null, label: null, icon: null, conversations: 5 },
      // A code in no current catalog: the console shows the code.
      { code: 'gone', label: null, icon: null, conversations: 1 },
    ]);
  });

  it('a label clash goes to the campaign with the most conversations on the code', () => {
    const a = campaign('a', [{ code: 'paid', label: 'Paid' }]);
    const b = campaign('b', [{ code: 'paid', label: 'Paid in full', icon: 'rupee' }]);
    const bars = outcomeBars([a, b], [
      { campaign_id: 'a', disposition_code: 'paid', conversations: 2 },
      { campaign_id: 'b', disposition_code: 'paid', conversations: 7 },
    ]);
    expect(bars).toEqual([{ code: 'paid', label: 'Paid in full', icon: 'rupee', conversations: 9 }]);
  });

  it('bar_conversations counts a code only on the campaigns where it is the main outcome, before the bars merge them', () => {
    // will_pay records a promise on a, and is a plain outcome on b: its one bar holds both.
    const cs = [campaign('a', [WILL_PAY]), campaign('b', [{ code: 'will_pay', label: 'Will pay later' }, SALE])];
    const rollupCodes = [
      { campaign_id: 'a', disposition_code: 'will_pay', conversations: 5 },
      { campaign_id: 'b', disposition_code: 'will_pay', conversations: 3 },
      { campaign_id: 'b', disposition_code: 'sale', conversations: 4 },
      { campaign_id: 'a', disposition_code: null, conversations: 2 },
    ];
    const main = mainOutcomeFor(cs, workedCampaigns(rollupCodes, []));
    const a = assembleTeamPerformance(input({ campaignId: null, main, campaigns: cs, rollupCodes }));
    expect(a.main_outcome).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay', mixed: true, bar_conversations: 5 });
    expect(a.outcomes.find((o) => o.code === 'will_pay')!.conversations).toBe(8);
    // Successes, the same way: sale is a success on b only.
    const s = [campaign('a', [{ code: 'sale', label: 'Sale (pending)' }]), campaign('b', [SALE])];
    expect(assembleTeamPerformance(input({ campaignId: null, main: mainOutcomeFor(s, workedCampaigns(rollupCodes, [])), campaigns: s, rollupCodes: [
      { campaign_id: 'a', disposition_code: 'sale', conversations: 6 },
      { campaign_id: 'b', disposition_code: 'sale', conversations: 4 },
    ] })).main_outcome).toMatchObject({ kind: 'successes', codes: ['sale'], bar_conversations: 4 });
  });

  it('bar_conversations is every main bar with one campaign, never no outcome chosen, and 0 with no conversations', () => {
    const cs = [campaign('c1', [SALE, { code: 'won', label: 'Won', is_success: true }])];
    const rollupCodes = [
      { campaign_id: 'c1', disposition_code: 'sale', conversations: 5 },
      { campaign_id: 'c1', disposition_code: 'won', conversations: 2 },
      { campaign_id: 'c1', disposition_code: 'no_disposition', conversations: 3 },
      { campaign_id: 'c1', disposition_code: 'other', conversations: 9 },
    ];
    const a = assembleTeamPerformance(input({ main: mainOutcomeFor(cs, workedCampaigns(rollupCodes, [])), campaigns: cs, rollupCodes }));
    expect(a.main_outcome.bar_conversations).toBe(7);
    expect(a.main_outcome.bar_conversations).toBe(a.outcomes.filter((o) => o.code !== null && a.main_outcome.codes.includes(o.code)).reduce((n, o) => n + o.conversations, 0));
    expect(assembleTeamPerformance(input()).main_outcome.bar_conversations).toBe(0);
  });
});

describe('the allowed time to choose an outcome', () => {
  const calls = (...ids: string[]) => ids.map((campaign_id) => ({ campaign_id, disposition_code: 'x', conversations: 1 }));
  it('one value over the campaigns with calls; 0 is no limit; several vary; none is null', () => {
    const cs = [campaign('a', [], { wrapup_seconds: 30 }), campaign('b', [], { wrapup_seconds: 45 }), campaign('z', [], { wrapup_seconds: 0 })];
    expect(wrapupAllowed(cs, calls('a'))).toEqual({ seconds: 30, varies: false });
    expect(wrapupAllowed(cs, calls('z'))).toEqual({ seconds: 0, varies: false });
    expect(wrapupAllowed(cs, calls('a', 'b'))).toEqual({ seconds: null, varies: true });
    expect(wrapupAllowed(cs, [])).toEqual({ seconds: null, varies: false });
  });
});

describe('rows and sums (Compare\'s figures, TP2)', () => {
  it('promises are over the dialler conversations and the other ones (CP2); a count past its calls is withheld', () => {
    const row = teamAgentRow('promises', agent('a', { promises: 30, other: 20 }));
    expect(row.main).toMatchObject({ numerator: 30, denominator: 120, value: 0.25, reportable: true, withheld: null });
    expect(row.calls_handled).toBe(100);
    expect(row.avg_call_seconds).toBe(60);
    expect(row.choose).toMatchObject({ numerator: 2000, denominator: 100, value: 20, reportable: true });
    const odd = teamAgentRow('promises', agent('b', { connected: 2, promises: 3 }));
    expect(odd.main).toMatchObject({ value: null, reportable: false, interval: null, withheld: 'counts_disagree', numerator: 3, denominator: 2 });
    expect(teamAgentRow('successes', agent('c', { connected: 10, successes: 4 })).main).toMatchObject({ value: 0.4, reportable: false, withheld: 'too_few' });
  });

  it('totals are sums over every row; other conversations only for promises; due excludes upcoming', () => {
    const a = assembleTeamPerformance(input({
      main: mainOutcomeFor([campaign('c1', [WILL_PAY])], NONE), campaigns: [campaign('c1', [WILL_PAY])],
      agents: [agent('a', { promises: 30, other: 20 }), agent('b', { connected: 10, promises: 2, other: 1 })],
    }));
    expect(a.totals).toMatchObject({ agents: 2, calls_handled: 110, other_conversations: 21, avg_call_seconds: 60, choose_seconds: 20 });
    expect(a.totals.main).toMatchObject({ numerator: 32, denominator: 131 });
    expect(a.totals.callbacks).toEqual({ due: 10, on_time: 4, late: 2, missed: 2, pending_due: 2, upcoming: 6 });
    // Medians: the rate over reportable rows only (b's 11 calls are under the floor).
    expect(a.medians).toEqual({ calls_handled: 55, main_rate: 0.25, avg_call_seconds: 60, choose_seconds: 20 });
    const s = assembleTeamPerformance(input({ agents: [agent('a')] }));
    expect(s.totals.other_conversations).toBe(0);
    expect(s.totals.main).toMatchObject({ numerator: 30, denominator: 100, value: 0.3 });
  });

  it('rollup_as_of is the newest of the campaigns with conversations in the window; an idle one never holds it back', () => {
    const calls = (...ids: string[]) => ids.map((campaign_id) => ({ campaign_id, disposition_code: 'x', conversations: 2 }));
    const cs = [
      campaign('a', [], { rollup_as_of: '2026-11-07T09:58:00.000Z' }),
      campaign('b', [], { rollup_as_of: '2026-11-07T09:50:00.000Z' }),
      // Paused weeks ago: its rollup is as old as its last call.
      campaign('idle', [], { rollup_as_of: '2026-10-12T16:00:00.000Z' }),
      campaign('c', []),
    ];
    expect(assembleTeamPerformance(input({ campaigns: cs, rollupCodes: calls('a', 'b', 'c') })).rollup_as_of).toBe('2026-11-07T09:58:00.000Z');
    expect(assembleTeamPerformance(input({ campaigns: cs, rollupCodes: calls('b') })).rollup_as_of).toBe('2026-11-07T09:50:00.000Z');
    // No conversations in the window: no bars, nothing to date.
    expect(assembleTeamPerformance(input({ campaigns: cs, rollupCodes: [] })).rollup_as_of).toBeNull();
    expect(assembleTeamPerformance(input({ campaigns: [campaign('c', [])], rollupCodes: calls('c') })).rollup_as_of).toBeNull();
  });
});

describe('worth a look (TP7, TP15)', () => {
  // Seven rated agents, one far below the rest; one slow to choose; one thin.
  const cohort = [
    ...['a', 'b', 'c', 'd', 'e'].map((id) => agent(id, { connected: 200, successes: 60 })),
    agent('low', { connected: 200, successes: 10 }),
    agent('slow', { connected: 200, successes: 60, wrapup: 200 * 60 }),
    agent('thin', { connected: 5, successes: 0 }),
  ];

  it('names the clear gaps with one campaign, never too few calls and never not clear', () => {
    const a = assembleTeamPerformance(input({ agents: cohort }));
    expect(a.comparable).toBe(true);
    expect(a.findings.map((f) => [f.code, f.agent_user_id, f.metric])).toEqual([
      ['clear_gap', 'low', 'success_rate'],
      ['clear_gap', 'slow', 'choose_time'],
    ]);
    expect(a.findings.every((f) => f.code === 'clear_gap' || f.code === 'stands_out')).toBe(true);
  });

  it('every gap and every praise of a large team, past Compare\'s cap of 5 in all (TP15)', () => {
    // 30 agents: 20 at the team's rate, 8 far below it, 2 far above it.
    const team = [
      ...Array.from({ length: 20 }, (_, i) => agent(`m${String(i).padStart(2, '0')}`, { connected: 400, successes: 120 })),
      ...Array.from({ length: 8 }, (_, i) => agent(`weak${i}`, { connected: 400, successes: 40 + i })),
      ...Array.from({ length: 2 }, (_, i) => agent(`strong${i}`, { connected: 400, successes: 220 + i })),
    ];
    const a = assembleTeamPerformance(input({ agents: team }));
    const named = (code: string) => a.findings.filter((f) => f.code === code && f.metric === 'success_rate').map((f) => f.agent_user_id).sort();
    expect(named('clear_gap')).toEqual(Array.from({ length: 8 }, (_, i) => `weak${i}`));
    expect(named('stands_out')).toEqual(['strong0', 'strong1']);
    expect(a.findings).toHaveLength(10);
  });

  it('All campaigns compares nobody: no findings, whatever the figures', () => {
    const a = assembleTeamPerformance(input({ campaignId: null, agents: cohort }));
    expect(a.comparable).toBe(false);
    expect(a.findings).toEqual([]);
    expect(a.campaign_id).toBeNull();
  });
});
