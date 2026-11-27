import { describe, expect, it } from 'vitest';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import {
  assembleTeamPerformance,
  mainOutcomeFor,
  outcomeBars,
  teamAgentRow,
  teamTrend,
  teamTrendRange,
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
    main: mainOutcomeFor([campaign('c1', [SALE])]),
    campaigns: [campaign('c1', [SALE])], agents: [agent('a')], rollupCodes: [],
    trendRange: teamTrendRange('2026-11-01', '2026-11-07'), rollupDays: [], promiseDays: new Map(), ...o,
  };
}

describe('the main outcome (TP8)', () => {
  it('is promises when any campaign of the scope records them, a mixed scope too', () => {
    expect(mainOutcomeFor([campaign('a', [SALE]), campaign('b', [SALE, WILL_PAY])])).toEqual({ kind: 'promises', codes: ['will_pay'], label: 'Will pay' });
  });

  it('else successes, with their codes sorted and distinct', () => {
    const won = { code: 'won', label: 'Sale', is_success: true };
    expect(mainOutcomeFor([campaign('a', [SALE, won]), campaign('b', [SALE])])).toEqual({ kind: 'successes', codes: ['sale', 'won'], label: 'Sale' });
  });

  it('sends the label only when the codes carry exactly one', () => {
    const promised = { code: 'promised', label: 'Promised', requires_promise: true };
    expect(mainOutcomeFor([campaign('a', [WILL_PAY]), campaign('b', [promised])]).label).toBeNull();
    expect(mainOutcomeFor([]).label).toBeNull();
    expect(mainOutcomeFor([])).toEqual({ kind: 'successes', codes: [], label: null });
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
      main: mainOutcomeFor([campaign('c1', [WILL_PAY])]), campaigns: [campaign('c1', [WILL_PAY])],
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

  it('rollup_as_of is the oldest of the scope\'s campaigns that have one', () => {
    const cs = [campaign('a', [], { rollup_as_of: '2026-11-07T09:58:00.000Z' }), campaign('b', [], { rollup_as_of: '2026-11-07T09:50:00.000Z' }), campaign('c', [])];
    expect(assembleTeamPerformance(input({ campaigns: cs })).rollup_as_of).toBe('2026-11-07T09:50:00.000Z');
    expect(assembleTeamPerformance(input({ campaigns: [campaign('c', [])] })).rollup_as_of).toBeNull();
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

  it('All campaigns compares nobody: no findings, whatever the figures', () => {
    const a = assembleTeamPerformance(input({ campaignId: null, agents: cohort }));
    expect(a.comparable).toBe(false);
    expect(a.findings).toEqual([]);
    expect(a.campaign_id).toBeNull();
  });
});
