import { describe, expect, it } from 'vitest';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import { TEAM_PERFORMANCE_TENANT_CONCURRENT_READS } from '@magick-agency/contracts/api/agency/team-performance';
import {
  TeamAborted,
  TeamPerformanceReads,
  TeamRefusal,
  teamPerformanceCacheKey,
  type TeamPerformanceRead,
} from '../../../../src/agency/team-performance/read.js';
import {
  TEAM_ROLLUP_CODES_SQL,
  TEAM_ROLLUP_DAYS_SQL,
  teamCallbacksSql,
  teamPromiseDaysSql,
  teamPromisesSql,
  teamScopeCampaignsSql,
  type TeamScope,
} from '../../../../src/db/repositories/agency/team-performance-reads.js';

/**
 * Team performance's read guards that need no database (docs/team-performance.md §4): the cache
 * key, the statements of one snapshot in their order (and the promises only for a promise scope),
 * the slot rules (a cached or joined answer takes none; past the tenant's limit `team_busy`), the
 * deadline (`team_timed_out`), a client that goes away, and the membership filter (a departed member
 * kept and flagged, an id with no membership dropped). The connection is a fake that names each
 * statement; the SQL and the figures are held on Postgres in
 * `test/integration/api/team-performance.test.ts`.
 */

const Q: TeamPerformanceRead = {
  tenantId: 't', accountId: 'acc', campaignId: '00000000-0000-4000-8000-0000000000c1',
  from: '2026-11-01', to: '2026-11-07', timezone: 'Asia/Kolkata', databaseTimezone: 'Asia/Kolkata',
};

const roster = (id: string) => ({
  agent_user_id: id, attempts: '40', connected: '30', successes: '6', talk_seconds: '1800', wrapup_seconds: '600',
  human_connects: '28', first_dials: '40', measured_wrapups: '30', campaigns: '1', last_dialed_at: null,
});

/** The statement `text` is, by the builders the repository sends. */
function nameOf(text: string): string {
  const t = text.trim();
  const scopes: TeamScope[] = [{ kind: 'account' }, { kind: 'campaign', campaignId: 'x' }];
  const is = (build: (s: TeamScope) => string) => scopes.some((s) => build(s).trim() === t);
  if (is(teamScopeCampaignsSql)) return 'scope campaigns';
  if (/COUNT\(DISTINCT a\.campaign_id\)/.test(t)) return 'roster attempts';
  if (/intervals/.test(t)) return 'roster occupancy';
  if (t === TEAM_ROLLUP_CODES_SQL.trim()) return 'rollup codes';
  if (t === TEAM_ROLLUP_DAYS_SQL.trim()) return 'rollup days';
  if (is(teamPromisesSql)) return 'promises';
  if (is(teamPromiseDaysSql)) return 'promise days';
  if (is(teamCallbacksSql)) return 'callbacks';
  return `unknown: ${t.slice(0, 40)}`;
}

function fake(o: { catalog?: AgencyDisposition[]; hold?: Promise<void>; agents?: string[]; members?: Array<{ user_id: string; status: string; account_id: string }>; timeoutMs?: number } = {}) {
  const statements: string[] = [];
  let connects = 0;
  const agents = o.agents ?? ['u1', 'u2'];
  const client = {
    processID: 1,
    async query(text: string, values?: unknown[]) {
      const t = text.trim();
      if (/^BEGIN/.test(t)) return { rows: [] };
      if (/pg_backend_pid/.test(t)) return { rows: [{ pid: 7, ceiling_ms: '0', applied_ms: String(values?.[0]) }] };
      if (/set_config/.test(t) || t === 'ROLLBACK') return { rows: [] };
      const name = nameOf(t);
      statements.push(name);
      if (name === 'scope campaigns') {
        await o.hold;
        return { rows: [{ id: Q.campaignId, wrapup_seconds: 30, disposition_catalog: o.catalog ?? [{ code: 'will_pay', label: 'Will pay', requires_promise: true }], rollup_as_of: null }] };
      }
      if (name === 'roster attempts') return { rows: agents.map(roster) };
      return { rows: [] };
    },
    release() { /* pooled */ },
  };
  const reads = new TeamPerformanceReads({
    timeoutMs: o.timeoutMs ?? 5_000,
    deps: {
      pool: { connect: async () => { connects += 1; return client as never; } },
      cancelBackend: async () => true,
      poolMax: () => 30,
      memberships: async (ids) => o.members ?? ids.map((user_id) => ({ user_id, status: 'active', account_id: 'acc' })),
      names: async (ids) => new Map(ids.map((id) => [id, `Agent ${id}`])),
      now: () => new Date('2026-11-07T10:00:00Z'),
    },
  });
  return { reads, statements, connects: () => connects };
}

describe('teamPerformanceCacheKey', () => {
  it('keys by tenant, account, campaign or all, window and zone, and by nothing else', () => {
    const k = teamPerformanceCacheKey(Q);
    for (const o of [{ tenantId: 't2' }, { accountId: 'a2' }, { campaignId: null }, { from: '2026-10-31' }, { to: '2026-11-08' }, { timezone: 'UTC' }] satisfies Array<Partial<TeamPerformanceRead>>) {
      expect(teamPerformanceCacheKey({ ...Q, ...o }), JSON.stringify(o)).not.toBe(k);
    }
    // The zone Postgres cuts the days in follows from the request's zone: not a key of its own.
    expect(teamPerformanceCacheKey({ ...Q, databaseTimezone: 'Asia/Calcutta' })).toBe(k);
  });
});

describe('one snapshot', () => {
  it('sends the statements in the doc\'s order, the promises only for a promise scope', async () => {
    const promise = fake();
    await promise.reads.read(Q);
    expect(promise.statements).toEqual([
      'scope campaigns', 'roster attempts', 'roster occupancy', 'rollup codes', 'rollup days', 'promises', 'promise days', 'callbacks',
    ]);
    const success = fake({ catalog: [{ code: 'sale', label: 'Sale', is_success: true }] });
    await success.reads.read(Q);
    expect(success.statements).toEqual(['scope campaigns', 'roster attempts', 'roster occupancy', 'rollup codes', 'rollup days', 'callbacks']);
  });

  it('keeps a departed member, flagged; drops an id with no membership in the tenant', async () => {
    const f = fake({
      agents: ['u1', 'gone', 'stranger'],
      members: [{ user_id: 'u1', status: 'active', account_id: 'acc' }, { user_id: 'gone', status: 'revoked', account_id: 'acc' }],
    });
    const a = await f.reads.read(Q);
    expect(a.agents.map((r) => [r.agent_user_id, r.departed])).toEqual([['u1', false], ['gone', true]]);
    expect(a.totals.agents).toBe(2);
  });
});

describe('slots and the cache', () => {
  it('a cached answer sends no SQL and takes no slot; an identical read in flight is joined', async () => {
    let open: () => void = () => undefined;
    const f = fake({ hold: new Promise<void>((r) => { open = r; }) });
    const first = f.reads.read(Q);
    const joined = f.reads.read(Q);
    await Promise.resolve();
    expect(f.reads.inFlight('t')).toBe(1);
    open();
    const [a, b] = await Promise.all([first, joined]);
    expect(b).toBe(a);
    expect(f.connects()).toBe(1);
    const sent = f.statements.length;
    expect(await f.reads.read(Q)).toBe(a);
    expect(f.statements).toHaveLength(sent);
    expect(f.reads.inFlight('t')).toBe(0);
  });

  it('past the tenant\'s limit a read is refused team_busy at once; another tenant is not', async () => {
    let open: () => void = () => undefined;
    const f = fake({ hold: new Promise<void>((r) => { open = r; }) });
    const running = Array.from({ length: TEAM_PERFORMANCE_TENANT_CONCURRENT_READS }, (_, i) => f.reads.read({ ...Q, to: `2026-11-0${7 - i}` }));
    await expect(f.reads.read({ ...Q, to: '2026-11-02' })).rejects.toEqual(new TeamRefusal('team_busy'));
    const other = f.reads.read({ ...Q, tenantId: 't2' });
    open();
    await Promise.all([...running, other]);
    expect(f.reads.inFlight('t')).toBe(0);
  });

  it('a read past its deadline is team_timed_out, and its slot comes back', async () => {
    const { reads } = fake({ hold: new Promise<void>(() => undefined), timeoutMs: 100 });
    await expect(reads.read(Q)).rejects.toEqual(new TeamRefusal('team_timed_out'));
    await expect.poll(() => reads.inFlight('t'), { timeout: 3_000 }).toBe(0);
  });

  it('a client that goes away before the answer: TeamAborted, nothing cached', async () => {
    let open: () => void = () => undefined;
    const f = fake({ hold: new Promise<void>((r) => { open = r; }) });
    const gone = new AbortController();
    const pending = f.reads.read(Q, gone.signal);
    gone.abort();
    await expect(pending).rejects.toBeInstanceOf(TeamAborted);
    open();
    await expect.poll(() => f.reads.inFlight('t'), { timeout: 3_000 }).toBe(0);
    await f.reads.read(Q);
    expect(f.connects()).toBe(2);
  });
});
