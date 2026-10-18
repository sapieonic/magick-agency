import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
import { assertReRunningPlan, freshTables, withReRunningPlan } from '../../helpers/rerun-plan.js';

// The repositories' queries go to `pinned.client` while a case holds one, so they
// run with that connection's planner settings.
const pinned = vi.hoisted(() => ({ client: null as null | pg.PoolClient }));
vi.mock('../../../src/connection.js', () => ({
  getPool: () => pinned.client ?? getTestPool(),
  healthCheck: async () => true,
}));

const { webrtcCallRepository: calls } = await import('../../../src/repositories/agency-call.repository.js');
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

/*
 * Every batch claim and sweep takes at most `limit` rows, under the plan that made
 * `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` take every eligible row
 * (the recipe and the mechanism: `test/helpers/rerun-plan.ts`). The OLD_* statements
 * are those claims as they were, reduced to the shape that matters; each case
 * asserts that shape gets the re-running plan before it runs the repository.
 */
const OLD_FAIL_STALE = `UPDATE agency_calls SET status = 'failed' WHERE id IN (
  SELECT id FROM agency_calls WHERE status IN ('initiating','ringing','in_progress') AND created_at < $1
   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`;
const OLD_CLAIM = `UPDATE dialer_analysis_jobs SET status = 'transcribing' WHERE id IN (
  SELECT id FROM dialer_analysis_jobs WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
   ORDER BY next_attempt_at NULLS FIRST, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`;
const OLD_RECOVER = `UPDATE dialer_analysis_jobs SET status = 'queued' WHERE id IN (
  SELECT id FROM dialer_analysis_jobs WHERE status IN ('transcribing','analyzing')
     AND (heartbeat_at IS NULL OR heartbeat_at < $1)
   ORDER BY heartbeat_at NULLS FIRST LIMIT 1 FOR UPDATE SKIP LOCKED)`;
const OLD_PROMOTE = `UPDATE dialer_analysis_jobs j SET status = 'queued' FROM agency_calls c
  WHERE j.call_id = c.id AND j.status = 'awaiting_recording' AND c.recording_url IS NOT NULL
    AND j.id IN (SELECT id FROM dialer_analysis_jobs WHERE status = 'awaiting_recording'
                  ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)`;

async function pinnedRun<T>(
  precondition: { table: string; sql: string; params: unknown[] }, fn: () => Promise<T>,
): Promise<T> {
  return withReRunningPlan(getTestPool(), async (client) => {
    await assertReRunningPlan(client, precondition.table, precondition.sql, precondition.params);
    pinned.client = client;
    try {
      return await fn();
    } finally {
      pinned.client = null;
    }
  });
}

const ago = (seconds: number) => new Date(Date.now() - seconds * 1_000);
const analyze = (...tables: string[]) => getTestPool().query(`ANALYZE ${tables.join(', ')}`);

async function jobStates(): Promise<Record<string, number>> {
  const { rows } = await getTestPool().query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM dialer_analysis_jobs GROUP BY status',
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * `n` calls oldest first, each with its analysis job enqueued in the same order:
 * one pair, then ANALYZE, then the rest (the recipe's step 2).
 */
async function callsWithJobs(n: number, recording: boolean) {
  await freshTables(getTestPool(), ['agency_calls', 'dialer_analysis_jobs']);
  const out = [];
  for (let i = 0; i < n; i++) {
    const call = await insertWebrtcCall({
      status: 'completed',
      recording_url: recording ? `https://recording.example/${i}.wav` : null,
    });
    const job = await jobs.enqueueFromCall({ call_id: call.id, profile_snapshot: { custom_dimensions: [] } });
    out.push({ call, job: job! });
    if (i === 0) await analyze('agency_calls', 'dialer_analysis_jobs');
  }
  return out;
}

describe('batch claims take at most `limit` rows (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('failStaleActive fails at most `limit` stuck calls', async () => {
    await freshTables(getTestPool(), ['agency_calls']);
    for (let i = 0; i < 5; i++) {
      await insertWebrtcCall({ status: 'in_progress', created_at: ago(3_600 - i) });
      if (i === 0) await analyze('agency_calls');
    }
    const failed = await pinnedRun(
      { table: 'agency_calls', sql: OLD_FAIL_STALE, params: [ago(60)] },
      () => calls.failStaleActive(ago(60), [], 1),
    );
    expect(failed).toHaveLength(1);
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_calls WHERE status = 'failed'`,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('claimRunnable claims at most `limit` queued jobs', async () => {
    await callsWithJobs(5, true);
    const claimed = await pinnedRun(
      { table: 'dialer_analysis_jobs', sql: OLD_CLAIM, params: [] },
      () => jobs.claimRunnable(1),
    );
    expect(claimed).toHaveLength(1);
    expect(await jobStates()).toEqual({ queued: 4, transcribing: 1 });
  });

  it('recoverStale recovers at most `limit` stale jobs', async () => {
    await freshTables(getTestPool(), ['agency_calls', 'dialer_analysis_jobs']);
    // Inserted straight into their stale state, oldest heartbeat first, so the
    // heap holds them in the subquery's order.
    for (let i = 0; i < 5; i++) {
      const call = await insertWebrtcCall({ status: 'completed' });
      await getTestPool().query(
        `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status, claimed_at, heartbeat_at, claim_generation)
         SELECT id, tenant_id, account_id, 'transcribing', $2, $2, 1 FROM agency_calls WHERE id = $1`,
        [call.id, ago(3_600 - i)],
      );
      if (i === 0) await analyze('agency_calls', 'dialer_analysis_jobs');
    }
    const recovered = await pinnedRun(
      { table: 'dialer_analysis_jobs', sql: OLD_RECOVER, params: [ago(60)] },
      () => jobs.recoverStale(ago(60), 100, 1),
    );
    expect(recovered).toHaveLength(1);
    expect(await jobStates()).toEqual({ queued: 1, transcribing: 4 });
  });

  it('promoteRecordingReady promotes at most `limit` jobs', async () => {
    const made = await callsWithJobs(5, false);
    // The recordings arrive. `agency_calls` rows move in the heap; the jobs do not.
    for (const { call } of made) {
      await getTestPool().query(
        `UPDATE agency_calls SET recording_url = 'https://recording.example/late.wav' WHERE id = $1`, [call.id],
      );
    }
    const promoted = await pinnedRun(
      { table: 'dialer_analysis_jobs', sql: OLD_PROMOTE, params: [] },
      () => jobs.promoteRecordingReady(0, 1),
    );
    expect(promoted).toBe(1);
    expect(await jobStates()).toEqual({ awaiting_recording: 4, queued: 1 });
  });

  it('expireAwaitingRecording expires at most `limit` jobs (its locking CTE is scanned, not re-run)', async () => {
    // Already a CTE before the IN: Postgres materialises a CTE that locks rows, so
    // this one was never exposed. Pinned so a rewrite into the IN form shows up.
    await callsWithJobs(5, false);
    const future = new Date(Date.now() + 60_000);
    const expired = await withReRunningPlan(getTestPool(), async (client) => {
      pinned.client = client;
      try {
        return await jobs.expireAwaitingRecording(future, 1);
      } finally {
        pinned.client = null;
      }
    });
    expect(expired).toHaveLength(1);
    expect(await jobStates()).toEqual({ awaiting_recording: 4, expired: 1 });
  });
});
