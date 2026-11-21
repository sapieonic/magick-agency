import { describe, expect, it } from 'vitest';
import type { AgencyCompareMetricInfo, CompareBuiltinMetricKey } from '@magick-agency/contracts/api/agency/compare';
import { resolveCompareMetric } from '@magick-agency/domain/agent-compare';
import { CompareReads, type CompareQueryRead } from '../../../../src/agency/compare/read.js';

/**
 * Compare agents' snapshot cache (docs/compare-agents.md §7 "The caches"): the cache holds the
 * cohort's sources, keyed by what the SQL reads, and every request is answered from it for its own
 * picks and metrics. So within the TTL a pick change (with calls per hour on screen, when the whole
 * cohort's occupancy is read) or a reorder of the picks or the metrics sends no SQL and takes no
 * slot; a change of what is read (another source, picks whose occupancy is read for them alone) is a
 * new snapshot. The connection is a fake that counts every statement; the answers' figures are held
 * on Postgres in `test/integration/api/compare-agents.test.ts`.
 */

const AGENTS = ['u1', 'u2', 'u3'];
const roster = (id: string, connected: number) => ({
  agent_user_id: id, attempts: String(connected * 2), connected: String(connected), successes: '1', talk_seconds: String(connected * 60),
  wrapup_seconds: '0', human_connects: String(connected), first_dials: String(connected * 2), measured_wrapups: '0', campaigns: '1', last_dialed_at: null,
});

function counted() {
  let statements = 0;
  let connects = 0;
  let nameReads = 0;
  let first = false;
  const client = {
    processID: 1,
    query(text: string, values?: unknown[]) {
      statements += 1;
      const t = text.trim();
      if (/^BEGIN/.test(t)) { first = true; return Promise.resolve({ rows: [] }); }
      if (/pg_backend_pid/.test(t)) return Promise.resolve({ rows: [{ pid: 7, ceiling_ms: '0', applied_ms: String(values?.[0]) }] });
      if (/set_config/.test(t) || t === 'ROLLBACK') return Promise.resolve({ rows: [] });
      // The read's first statement is the roster's attempts: the cohort.
      if (first) { first = false; return Promise.resolve({ rows: AGENTS.map((id, i) => roster(id, 30 + i)) }); }
      return Promise.resolve({ rows: [] });
    },
    release() { /* pooled */ },
  };
  const reads = new CompareReads({
    timeoutMs: 5_000,
    deps: {
      pool: { connect: async () => { connects += 1; return client as never; } },
      cancelBackend: async () => true,
      poolMax: () => 30,
      memberships: async (ids) => ids.map((user_id) => ({ user_id, status: 'active', account_id: 'acc' })),
      names: async (ids) => { nameReads += 1; return new Map(ids.map((id) => [id, `Agent ${id}`])); },
      now: () => new Date('2026-11-21T10:00:00Z'),
    },
  });
  return { reads, sql: () => ({ statements, connects, nameReads }) };
}

const info = (key: CompareBuiltinMetricKey): AgencyCompareMetricInfo => {
  const r = resolveCompareMetric({ kind: 'builtin', key }, []);
  if (!r.ok) throw new Error(key);
  return r.metric;
};

const Q: CompareQueryRead = {
  tenantId: 't', accountId: 'acc', campaignId: '00000000-0000-4000-8000-0000000000c1',
  from: '2026-11-01', to: '2026-11-02', timezone: 'UTC', databaseTimezone: 'UTC',
  start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-03T00:00:00Z'),
  agentIds: ['u1'], metrics: [info('calls_per_hour'), info('success_rate')], trend: null,
};

describe('the snapshot cache', () => {
  it('a pick change with calls per hour on screen, and a reorder of picks or metrics, send no SQL', async () => {
    const c = counted();
    const first = await c.reads.query(Q);
    const after = c.sql();
    expect(after.connects).toBe(1);

    const picked = await c.reads.query({ ...Q, agentIds: ['u3', 'u2'] });
    const reordered = await c.reads.query({ ...Q, agentIds: ['u2', 'u3'], metrics: [info('success_rate'), info('calls_per_hour')] });
    const sameSources = await c.reads.query({ ...Q, metrics: [info('calls_per_hour'), info('connect_rate'), info('avg_call')] });
    expect(c.sql()).toEqual(after);
    expect(c.reads.inFlight('t')).toBe(0);

    // Each answer is the request's own: its picks in its order, its metrics in its order, one as_of.
    if (first.kind !== 'ok' || picked.kind !== 'ok' || reordered.kind !== 'ok' || sameSources.kind !== 'ok') throw new Error('not ok');
    expect(picked.response.agents.map((a) => a.agent_user_id)).toEqual(['u3', 'u2']);
    expect(picked.response.agents.map((a) => a.agent_name)).toEqual(['Agent u3', 'Agent u2']);
    expect(reordered.response.agents.map((a) => a.agent_user_id)).toEqual(['u2', 'u3']);
    expect(reordered.response.metrics.map((m) => m.id)).toEqual(['success_rate', 'calls_per_hour']);
    expect(Object.keys(reordered.response.agents[0]!.values)).toEqual(['success_rate', 'calls_per_hour']);
    expect(sameSources.response.metrics.map((m) => m.id)).toEqual(['calls_per_hour', 'connect_rate', 'avg_call']);
    expect(new Set([first, picked, reordered, sameSources].map((o) => (o.kind === 'ok' ? o.response.as_of : null))).size).toBe(1);
    // The figures are the cohort's whichever picks asked: the same band.
    expect(picked.response.cohort).toEqual(first.response.cohort);
  });

  it('a picked agent outside the cached cohort is refused from the cache, with no SQL', async () => {
    const c = counted();
    await c.reads.query(Q);
    const after = c.sql();
    expect(await c.reads.query({ ...Q, agentIds: ['u1', 'nobody'] })).toEqual({ kind: 'not_in_cohort' });
    expect(c.sql()).toEqual(after);
  });

  it('a change of what is read is a new snapshot: another source, or new picks whose occupancy is read for them alone', async () => {
    const c = counted();
    await c.reads.query(Q);
    await c.reads.query({ ...Q, metrics: [info('calls_per_hour'), info('breaks_over_limit')] });
    expect(c.sql().connects).toBe(2);
    const noPerHour = { ...Q, metrics: [info('success_rate')] };
    await c.reads.query(noPerHour);
    expect(c.sql().connects).toBe(3);
    // Their order is not what is read.
    await c.reads.query({ ...noPerHour, agentIds: ['u2', 'u1'] });
    await c.reads.query({ ...noPerHour, agentIds: ['u1', 'u2'] });
    expect(c.sql().connects).toBe(4);
  });
});
