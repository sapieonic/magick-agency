import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgencyCompareMetricRef, AgencyCompareOutcomeCode } from '@magick-agency/contracts/api/agency/compare';
import { resolveCompareMetrics } from '@magick-agency/domain/agent-compare';

/**
 * Compare agents' read cuts days in POSTGRES's name for the zone (docs/compare-agents.md §7
 * "Zones"): a legacy name a browser reports (`Asia/Calcutta`) that Postgres may not know reaches the
 * day statements as its current name (`Asia/Kolkata`), while the answer echoes the request's own.
 * The repository is stubbed, so this holds whatever zone names the Postgres running the tests
 * knows (the integration test's legacy-zone case passes on a Postgres that knows both names even
 * when the read sends the wrong one).
 */

const calls = vi.hoisted(() => ({ zones: [] as Array<{ statement: string; timezone: string }> }));

vi.mock('../../../../src/db/repositories/agency.repository.js', () => {
  const day = (statement: string) => async (_db: unknown, q: { timezone: string }) => {
    calls.zones.push({ statement, timezone: q.timezone });
    return statement === 'loggedInDays' ? new Map() : [];
  };
  return {
    rosterAttemptTotals: async () => [{
      agent_user_id: 'a1', attempts: 30, connected: 25, successes: 5, talk_seconds: 900, wrapup_seconds: 300,
      human_connects: 20, first_dials: 30, measured_wrapups: 25, campaigns: 1, last_dialed_at: null,
    }],
    rosterOccupancyTotals: async () => [],
    agencyCompareReadRepository: {
      rollupCodes: async () => [],
      promises: async () => [],
      callbacks: async () => new Map(),
      breakOverruns: async () => new Map(),
      rollupCodeDays: day('rollupCodeDays'),
      promiseDays: day('promiseDays'),
      loggedInDays: day('loggedInDays'),
    },
  };
});

const { CompareReads } = await import('../../../../src/agency/compare/read.js');

const CODES: AgencyCompareOutcomeCode[] = [
  { code: 'interested', label: 'Interested', is_success: true, requires_promise: false },
  { code: 'will_pay', label: 'Will pay', is_success: false, requires_promise: true },
];

function resolved(trend: AgencyCompareMetricRef) {
  const r = resolveCompareMetrics([{ kind: 'builtin', key: 'calls_handled' } as AgencyCompareMetricRef], trend, CODES, 6);
  if (!r.ok) throw new Error(`metrics refused: ${r.problem}`);
  return r;
}

/** A connection that answers the transaction's own statements; the reads are stubbed above. */
const client = {
  query: async (text: string, values?: unknown[]) =>
    (/pg_backend_pid/.test(text) ? { rows: [{ pid: 1, session_ms: '0', applied_ms: String(values?.[0]) }] } : { rows: [] }),
  release: () => undefined,
};

function reads() {
  return new CompareReads({
    deps: {
      pool: { connect: async () => client as never },
      cancelBackend: async () => true,
      poolMax: () => 30,
      memberships: async () => [{ user_id: 'a1', tenant_id: 't1', account_id: 'acc1', status: 'active' }] as never,
      names: async () => new Map([['a1', 'Asha']]),
      now: () => new Date('2026-11-03T06:00:00Z'),
    },
  });
}

const SCOPE = {
  tenantId: 't1', accountId: 'acc1', campaignId: '00000000-0000-4000-8000-0000000000c1',
  from: '2026-11-01', to: '2026-11-02',
  // The browser's legacy name, and the name Postgres knows it by.
  timezone: 'Asia/Calcutta', databaseTimezone: 'Asia/Kolkata',
  start: new Date('2026-10-31T18:30:00Z'), end: new Date('2026-11-02T18:30:00Z'),
  agentIds: ['a1'],
};

beforeEach(() => { calls.zones.length = 0; });

describe('the day statements get the database\'s zone name, the answer the request\'s', () => {
  it('an outcome set\'s trend: its days and the logged-in days cut in Asia/Kolkata', async () => {
    const r = resolved({ kind: 'outcomes', codes: ['will_pay'], better: 'higher', label: 'Will pay' } as AgencyCompareMetricRef);
    const out = await reads().query({ ...SCOPE, metrics: r.metrics, trend: r.trend });
    expect(out.kind).toBe('ok');
    expect(calls.zones).toEqual([
      { statement: 'rollupCodeDays', timezone: 'Asia/Kolkata' },
      { statement: 'loggedInDays', timezone: 'Asia/Kolkata' },
    ]);
    if (out.kind === 'ok') expect(out.response.timezone).toBe('Asia/Calcutta');
  });

  it('the promises trend: its days and the logged-in days cut in Asia/Kolkata', async () => {
    const r = resolved({ kind: 'builtin', key: 'promises_rate' } as AgencyCompareMetricRef);
    const out = await reads().query({ ...SCOPE, metrics: r.metrics, trend: r.trend });
    expect(out.kind).toBe('ok');
    expect(calls.zones).toEqual([
      { statement: 'promiseDays', timezone: 'Asia/Kolkata' },
      { statement: 'loggedInDays', timezone: 'Asia/Kolkata' },
    ]);
    if (out.kind === 'ok') expect(out.response.timezone).toBe('Asia/Calcutta');
  });
});
