import { describe, expect, it } from 'vitest';

/**
 * The report builders' pure parts (`agency/reports/datasets/`): folding state intervals into
 * the report zone's days, the timeline's day and strip, sum-preserving rounding, RP7's masking,
 * the account's sums with rates recomputed, the audience's columns. The figures themselves are
 * held to the screens by `test/integration/api/report-datasets-oracle.test.ts`.
 */

import {
  buildTimeline,
  dailyRows,
  foldPresence,
  reportedState,
  timelineDay,
  timelineSegments,
  type PresenceInterval,
} from '../../../src/agency/reports/datasets/agent-presence.js';
import {
  dispositionLabel,
  breakReasonLabel,
  localDates,
  localDays,
  maskPhone,
  reportRange,
  roundPreservingSum,
} from '../../../src/agency/reports/datasets/shared.js';
import {
  agentCallCells,
  agentCallColumns,
  agentNotes,
  occupancyReadings,
  outcomeRows,
  sentimentBlock,
} from '../../../src/agency/reports/datasets/agent.js';
import { accountDaily, campaignFigures, sumCounts, totalFigures } from '../../../src/agency/reports/datasets/account.js';
import { agentIdsIn } from '../../../src/agency/reports/datasets/campaign.js';
import { agentCallsStatement, type ReportAgentCallRow } from '../../../src/db/repositories/agency.repository.js';
import type { ReportRunRecord } from '../../../src/db/repositories/agency/report-run.repository.js';

const T = (s: string) => new Date(s);
const iv = (state: string, started: string, ended: string, o: Partial<PresenceInterval> = {}): PresenceInterval =>
  ({ session_id: 's1', state, break_reason: null, started: T(started), ended: T(ended), ...o });

describe('localDays / localDates / reportRange', () => {
  it('cuts local midnights, 23 and 25 hours across clock changes', () => {
    const ny = localDays('2026-10-31', '2026-11-02', 'America/New_York');
    expect(ny.map((d) => d.date)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(ny.map((d) => (d.end.getTime() - d.start.getTime()) / 3600_000)).toEqual([24, 25, 24]);
    expect(ny[1]!.start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    const london = localDays('2026-03-29', '2026-03-29', 'Europe/London');
    expect((london[0]!.end.getTime() - london[0]!.start.getTime()) / 3600_000).toBe(23);
    expect(localDates('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('range.days counts the local dates, both inclusive', () => {
    const run = { local_from: '2026-10-01', local_to: '2026-10-31', timezone: 'Asia/Kolkata',
      range_from: T('2026-09-30T18:30:00Z'), range_to: T('2026-10-31T18:30:00Z') } as ReportRunRecord;
    expect(reportRange(run)).toEqual({ from: '2026-10-01', to: '2026-10-31', timezone: 'Asia/Kolkata', days: 31,
      start: '2026-09-30T18:30:00.000Z', end: '2026-10-31T18:30:00.000Z' });
  });
});

describe('roundPreservingSum', () => {
  it('whole parts summing to the rounded total, the largest remainders rounded up', () => {
    expect(roundPreservingSum([0.4, 0.4, 0.4])).toEqual([1, 0, 0]);
    expect(roundPreservingSum([1.5, 2.5, 3.0])).toEqual([2, 2, 3]);
    expect(roundPreservingSum([10, 20])).toEqual([10, 20]);
    expect(roundPreservingSum([])).toEqual([]);
    const parts = roundPreservingSum([3599.7, 1.2, 0.6, 86_399.9]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(Math.round(3599.7 + 1.2 + 0.6 + 86_399.9));
  });
});

describe('maskPhone (RP7)', () => {
  it('keeps the last four digits only', () => {
    expect(maskPhone('+919812345678')).toBe('****5678');
    expect(maskPhone('+1 (415) 555-0100')).toBe('****0100');
    expect(maskPhone('+12')).toBe('****');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('foldPresence: state intervals into the report zone\'s days', () => {
  const days = localDays('2026-11-03', '2026-11-04', 'Asia/Kolkata'); // midnight 18:30Z

  it('splits at local midnight, folds reserved into available, drops unknown states', () => {
    const folded = foldPresence([
      iv('available', '2026-11-03T17:30:00Z', '2026-11-03T19:30:00Z'),  // 1 h each side of 18:30Z
      iv('reserved', '2026-11-03T19:30:00Z', '2026-11-03T19:30:10Z'),
      iv('on_call', '2026-11-03T19:30:10Z', '2026-11-03T19:40:10Z'),
      iv('break', '2026-11-03T19:40:10Z', '2026-11-03T19:50:10Z', { break_reason: 'lunch' }),
      iv('break', '2026-11-03T19:50:10Z', '2026-11-03T19:55:10Z'),
      iv('mystery', '2026-11-03T20:00:00Z', '2026-11-03T21:00:00Z'),
    ], days);
    expect(folded.days[0]).toMatchObject({ date: '2026-11-03', available_s: 3600, on_call_s: 0, station_s: 3600, sessions: 1,
      first_in: '2026-11-03T17:30:00.000Z', last_out: '2026-11-03T18:30:00.000Z' });
    expect(folded.days[1]).toMatchObject({ date: '2026-11-04', available_s: 3610, on_call_s: 600, break_s: 900,
      first_in: '2026-11-03T18:30:00.000Z', last_out: '2026-11-03T19:55:10.000Z' });
    expect(folded.by_state).toEqual({ available: 7210, on_call: 600, wrapup: 0, break: 900 });
    expect([...folded.break_by_reason]).toEqual([['lunch', 600], ['unspecified', 300]]);
  });

  it('rounds each column across the days so they sum to the rounded window total', () => {
    const folded = foldPresence([
      iv('on_call', '2026-11-03T10:00:00.400Z', '2026-11-03T10:00:01.000Z'),
      iv('on_call', '2026-11-04T10:00:00.400Z', '2026-11-04T10:00:01.000Z'),
      iv('break', '2026-11-03T11:00:00.000Z', '2026-11-03T11:00:00.700Z', { break_reason: 'a' }),
      iv('break', '2026-11-03T11:00:00.700Z', '2026-11-03T11:00:01.400Z', { break_reason: 'b' }),
    ], days);
    expect(folded.days.map((d) => d.on_call_s)).toEqual([1, 0]); // 0.6 + 0.6 = 1.2 → 1
    expect(folded.by_state.break).toBe(1);
    expect([...folded.break_by_reason.values()].reduce((s, v) => s + v, 0)).toBe(1);
  });

  it('counts sessions per day and leaves days nobody worked at zero', () => {
    const folded = foldPresence([
      iv('available', '2026-11-03T04:00:00Z', '2026-11-03T05:00:00Z', { session_id: 'a' }),
      iv('available', '2026-11-03T06:00:00Z', '2026-11-03T07:00:00Z', { session_id: 'b' }),
    ], days);
    expect(folded.days.map((d) => d.sessions)).toEqual([2, 0]);
    expect(folded.days[1]).toMatchObject({ station_s: 0, first_in: null, last_out: null });
  });
});

describe('dailyRows', () => {
  it('joins attempts to presence on the date, every day present, talk rounded to the total', () => {
    const presence = foldPresence([], localDays('2026-11-03', '2026-11-05', 'UTC')).days;
    const rows = dailyRows(presence, [
      { date: '2026-11-03', attempts: 5, first_dials: 4, connected: 2, human_connects: 1, successes: 1, talk_seconds: 60.6, drops: 1 },
      { date: '2026-11-05', attempts: 1, first_dials: 1, connected: 1, human_connects: 1, successes: 0, talk_seconds: 10.6, drops: 0 },
    ]);
    expect(rows.map((r) => [r.date, r.dials, r.conversations, r.connected, r.talk_s, r.drops])).toEqual([
      ['2026-11-03', 5, 2, 2, 61, 1], ['2026-11-04', 0, 0, 0, 0, 0], ['2026-11-05', 1, 1, 1, 10, 0],
    ]);
  });
});

describe('the timeline', () => {
  it('the day with the most logged-in time, the latest on a tie, none when nobody worked', () => {
    expect(timelineDay([{ date: 'a', station_s: 10 }, { date: 'b', station_s: 30 }, { date: 'c', station_s: 20 }])).toBe('b');
    expect(timelineDay([{ date: '2026-11-01', station_s: 30 }, { date: '2026-11-02', station_s: 30 }])).toBe('2026-11-02');
    expect(timelineDay([{ date: 'a', station_s: 0 }])).toBeNull();
  });

  it('covers the whole day, offline in the gaps, merging equal neighbours, clipped', () => {
    const [day] = localDays('2026-11-03', '2026-11-03', 'UTC') as [ReturnType<typeof localDays>[number]];
    const segs = timelineSegments([
      iv('available', '2026-11-02T22:00:00Z', '2026-11-03T01:00:00Z'),
      iv('reserved', '2026-11-03T01:00:00Z', '2026-11-03T01:00:05Z'),
      iv('on_call', '2026-11-03T01:00:05Z', '2026-11-03T02:00:00Z'),
      iv('break', '2026-11-03T09:00:00Z', '2026-11-03T10:00:00Z', { break_reason: 'lunch' }),
      iv('break', '2026-11-03T10:00:00Z', '2026-11-03T10:30:00Z'),
    ], day, T('2026-11-03T20:00:00Z'));
    expect(segs).toEqual([
      { start: '2026-11-03T00:00:00.000Z', end: '2026-11-03T01:00:05.000Z', state: 'available', break_reason: null },
      { start: '2026-11-03T01:00:05.000Z', end: '2026-11-03T02:00:00.000Z', state: 'on_call', break_reason: null },
      { start: '2026-11-03T02:00:00.000Z', end: '2026-11-03T09:00:00.000Z', state: 'offline', break_reason: null },
      { start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z', state: 'break', break_reason: 'lunch' },
      { start: '2026-11-03T10:00:00.000Z', end: '2026-11-03T10:30:00.000Z', state: 'break', break_reason: 'unspecified' },
      { start: '2026-11-03T10:30:00.000Z', end: '2026-11-03T20:00:00.000Z', state: 'offline', break_reason: null },
    ]);
    expect(buildTimeline([], [day], [{ date: day.date, station_s: 0 }], day.end)).toBeNull();
  });

  it('reportedState folds reserved and refuses the rest', () => {
    expect(['available', 'reserved', 'on_call', 'wrapup', 'break', 'offline', 'x'].map(reportedState))
      .toEqual(['available', 'available', 'on_call', 'wrapup', 'break', null, null]);
  });
});

describe('the agent review\'s pure blocks', () => {
  it('occupancy: three readings, null on a zero denominator (RP11)', () => {
    const record = { occupancy: { shift_seconds: 1000, by_state: { available: 300, reserved: 0, on_call: 400, wrapup: 100, break: 200, offline: 0 } } };
    expect(occupancyReadings(42.5, record)).toEqual({ handling_pct: 42.5, on_call_pct: 40, on_call_pct_excl_break: 50 });
    expect(occupancyReadings(undefined, { occupancy: null })).toEqual({ handling_pct: null, on_call_pct: null, on_call_pct_excl_break: null });
  });

  it('outcomes: largest first, shares of the total, average talk; empty codes dropped', () => {
    const rows = outcomeRows([
      { code: 'sale', conversations: 1, successes: 1, talk_seconds: 100 },
      { code: null, conversations: 3, successes: 0, talk_seconds: 31 },
      { code: 'gone', conversations: 0, successes: 0, talk_seconds: 0 },
    ], (c) => c ?? 'none');
    expect(rows).toEqual([
      { code: null, label: 'none', is_success: false, conversations: 3, share_pct: 75, avg_talk_s: 10 },
      { code: 'sale', label: 'sale', is_success: true, conversations: 1, share_pct: 25, avg_talk_s: 100 },
    ]);
  });

  it('sentiment: one count per analysis label, mixed its own; an unknown label is not counted; nothing analysed is null', () => {
    expect(sentimentBlock([{ label: 'positive', calls: 2 }, { label: 'mixed', calls: 1 }, { label: 'neutral', calls: 1 }, { label: 'negative', calls: 3 }]))
      .toEqual({ analysed_calls: 7, sentiment: { positive: 2, neutral: 1, negative: 3, mixed: 1 } });
    expect(sentimentBlock([{ label: 'positive', calls: 1 }, { label: 'ecstatic', calls: 4 }, { label: 'constructor', calls: 2 }]))
      .toEqual({ analysed_calls: 1, sentiment: { positive: 1, neutral: 0, negative: 0, mixed: 0 } });
    expect(sentimentBlock([{ label: 'ecstatic', calls: 4 }])).toBeNull();
    expect(sentimentBlock([])).toBeNull();
  });

  it('the self copy says what it leaves out', () => {
    const base = { timezone: 'UTC', occupancyMeasured: true, rosterRow: true, future: false };
    expect(agentNotes({ ...base, supervisor: false }).at(-1)).toMatch(/last four digits/);
    expect(agentNotes({ ...base, supervisor: true }).join(' ')).not.toMatch(/last four digits/);
  });

  it('the calls sheet: self masks the phone and has no recording or sentiment cells (RP5, RP7)', () => {
    const row: ReportAgentCallRow = {
      at: T('2026-11-03T10:00:00Z'), id: 'x', origin: 'campaign', campaign_id: 'c', campaign_name: 'Spring', phone: '+919812345678',
      outcome: 'connected', disposition_code: 'sale', talk_s: 61.4, wrapup_s: 9.6, redial_number: 0, callback_at: null,
      recorded: true, sentiment: 'positive',
    };
    const catalog = () => [{ code: 'sale', label: 'Sale', is_success: true }] as never;
    const self = agentCallCells(row, false, catalog);
    expect(self).toHaveLength(agentCallColumns(false).length);
    expect(self).toEqual(['2026-11-03T10:00:00.000Z', 'Campaign', 'Spring', '****5678', 'Connected', 'sale', 'Sale', 61, 10, 0, null]);
    expect(agentCallColumns(false).map((c) => c.key)).not.toEqual(expect.arrayContaining(['recorded']));
    const sup = agentCallCells(row, true, catalog);
    expect(sup).toHaveLength(agentCallColumns(true).length);
    expect(sup.slice(3, 4)).toEqual(['+919812345678']);
    expect(sup.slice(-2)).toEqual([true, 'positive']);
  });
});

describe('labels', () => {
  it('a disposition from the current catalog, the system\'s words, or marked retired', () => {
    const catalog = [{ code: 'sale', label: 'Sale (renamed)' }] as never;
    expect(dispositionLabel('sale', catalog)).toBe('Sale (renamed)');
    expect(dispositionLabel('no_disposition', catalog)).toBe('No outcome recorded (closed automatically)');
    expect(dispositionLabel('old', catalog)).toBe('old (no longer in the outcome list)');
    expect(dispositionLabel(null, catalog)).toBe('Closed without an outcome');
  });

  it('a break reason from a campaign catalog, a reserved code, or none given', () => {
    expect(breakReasonLabel('lunch', [[{ code: 'lunch', label: 'Lunch' }] as never])).toBe('Lunch');
    expect(breakReasonLabel('soft_phone', [])).toBe('Soft phone');
    expect(breakReasonLabel('unspecified', [])).toBe('No reason given');
    expect(breakReasonLabel('zz', [])).toBe('zz');
  });
});

describe('the account\'s sums', () => {
  const calls = (dials: number, extra: Record<string, number> = {}) => ({
    dials, connected: 1, human_connects: 1, conversations: 1, successes: 1,
    by_outcome: { connected: 1, null_outcome: 0, ...extra },
    redials: { placed: 1, connected: 0, chains_at_limit: 0, refused_at_limit: 2 },
    agent_retries: { reopened_dials: 0, reopened_connected: 0, manual_dials: 1, manual_connected: 0 },
    softphone_calls: 0, talk_seconds: 10.5, wrapup_seconds: 1, wrapup_measured: 1,
  }) as never;

  it('sums field by field, the union of outcome keys', () => {
    expect(sumCounts([{ a: 1, n: { x: 1 } }, { a: 2, n: { y: 3 } }])).toEqual({ a: 3, n: { x: 1, y: 3 } });
  });

  it('totals recompute the abandonment rate from the summed counts, never the average of rates', () => {
    const a = campaignFigures({ calls: calls(10, { busy: 2 }), callbacks: { booked: 1 } as never },
      [{ abandoned: 1, answered: 2 }], { recording: { connected: 1, recorded: 1 } });
    const b = campaignFigures({ calls: calls(30), callbacks: { booked: 2 } as never },
      [{ abandoned: 9, answered: 5 }, { abandoned: 0, answered: 5 }], { recording: { connected: 3, recorded: 0 } });
    expect(a.abandoned_pct).toBe(50);
    expect(b.abandoned_pct).toBe(90);
    const total = totalFigures([a, b]);
    expect(total.abandoned_pct).toBeCloseTo((10 / 12) * 100, 9); // not (50 + 90) / 2
    expect(total.calls.dials).toBe(40);
    expect(total.calls.by_outcome).toMatchObject({ connected: 2, busy: 2, null_outcome: 0 });
    expect(total.calls.redials.refused_at_limit).toBe(4);
    expect(total.calls.talk_seconds).toBe(21);
    expect(total).toMatchObject({ callbacks_booked: 3, abandoned: 10, answered: 12, recording_connected: 4, recorded: 1 });
    expect(totalFigures([]).abandoned_pct).toBeNull();
  });

  it('the days: every date present, campaigns summed on their label, peak not measured', () => {
    const row = (d: string, dials: number) => ({ bucket_start: d, dials, first_dials: dials, human_connects: 0, connected: 0, conversations: 0, successes: 0, abandoned: 0, answered: 0 });
    expect(accountDaily(['2026-11-01', '2026-11-02'], [[row('2026-11-01', 2)], [row('2026-11-01', 3), row('2026-11-02', 1)]])
      .map((d) => [d.date, d.dials, d.agents_online_peak])).toEqual([['2026-11-01', 5, null], ['2026-11-02', 1, null]]);
  });
});

describe('agentIdsIn', () => {
  it('every id under agent_user_id, user_id or never_joined, at any depth', () => {
    expect(agentIdsIn(
      { agents: [{ agent_user_id: 'a' }, { agent_user_id: null }], never_joined: ['b'] },
      { callbacks: { by_owner: [{ agent_user_id: 'c' }] }, dnc_marked: { by_agent: [{ user_id: 'd' }] }, headline: { paused: { actor: { user_id: 'e' } } } },
    ).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('the calls statement per audience', () => {
  const scope = { agentUserId: 'a', tenantId: 't', accountId: 'c', from: T('2026-11-01T00:00:00Z'), to: T('2026-11-02T00:00:00Z') };
  it('the self statement never reads the call table: no recording, no analysis', () => {
    const self = agentCallsStatement({ ...scope, analysis: false }).text;
    expect(self).not.toContain('agency_calls');
    expect(self).not.toContain('recording_url');
    expect(self).not.toContain('call_analysis');
    const sup = agentCallsStatement({ ...scope, analysis: true }).text;
    expect(sup).toContain('AS recorded');
    expect(sup).toContain('AS sentiment');
    expect(agentCallsStatement({ ...scope, analysis: true }).values).toEqual(['a', scope.from, scope.to, 't', 'c']);
  });
});
