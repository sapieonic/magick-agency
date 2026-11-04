// Real Postgres: the insights rollup job's batch (claim, lock, recompute, commit) and the job
// loop over the real repository. The claim takes at most N buckets under the plan that re-runs
// a LIMIT subquery (packages/db/test/helpers/rerun-plan.ts); concurrent batches, racing fresh
// marks for the same buckets, never double count; a failed batch keeps its marks; a deleted
// campaign's marks are dropped; the job drains a backlog and stops cleanly.
import type pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import {
  assertReRunningPlan, freshTables, withReRunningPlan,
} from '../../../../../packages/db/test/helpers/rerun-plan.js';
import { insertAgencyCampaign } from './agency-factories.js';
import { OVERRIDE_CODES, SUCCESS_CODES, WORLD_BASE, seedWorld } from './insights-rollup-world.js';
import { oracleAgents, oracleTotals } from './insights-rollup-oracle-sql.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInsightsRollupRepository: repo, INSIGHTS_BUCKET_MINUTES } = await import('../../../src/db/repositories/agency.repository.js');
const { startInsightsRollupJob } = await import('../../../src/agency/insights-rollup-job.js');

const pool = () => getTestPool();
const HOUR = 3_600_000;
const LIFETIME = { from: new Date(WORLD_BASE.getTime() - 24 * HOUR), to: new Date(WORLD_BASE.getTime() + 96 * HOUR) };
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** The statement shape `packages/db/CLAUDE.md` forbids, as the precondition's witness. */
const OLD_CLAIM = `DELETE FROM agency_insights_rollup_dirty
                    WHERE id IN (SELECT id FROM agency_insights_rollup_dirty ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
                   RETURNING campaign_id, bucket_start`;

async function markCount(): Promise<number> {
  const { rows } = await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_insights_rollup_dirty');
  return rows[0]!.n;
}

beforeEach(truncateAll);
afterAll(closeTestPool);

describe('insights rollup batch', () => {
  it('the bucket width in TypeScript is the SQL function\'s', async () => {
    const { rows } = await pool().query<{ m: number }>(
      `SELECT (EXTRACT(EPOCH FROM agency_insights_bucket('2026-01-01T00:00:00Z'::timestamptz + interval '1 second' * (60 * $1::int) - interval '1 microsecond')
                                - agency_insights_bucket('2026-01-01T00:00:00Z')) / 60)::int AS m`, [INSIGHTS_BUCKET_MINUTES]);
    // The last instant of the first bucket still bins to the first boundary...
    expect(rows[0]!.m).toBe(0);
    const next = await pool().query<{ b: Date }>(
      `SELECT agency_insights_bucket('2026-01-01T00:00:00Z'::timestamptz + make_interval(mins => $1::int)) AS b`, [INSIGHTS_BUCKET_MINUTES]);
    // ...and the width itself is the next one.
    expect(next.rows[0]!.b.toISOString()).toBe(new Date(Date.UTC(2026, 0, 1, 0, INSIGHTS_BUCKET_MINUTES)).toISOString());
  });

  it('claims at most N buckets under the plan that re-runs a LIMIT subquery', async () => {
    const campaign = await insertAgencyCampaign();
    await freshTables(pool(), ['agency_insights_rollup_dirty']);
    const mark = (i: number) => pool().query(
      `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start) VALUES ($1, $2)`,
      [campaign.id, new Date(WORLD_BASE.getTime() + i * 15 * 60_000)]);
    await mark(0);
    // Statistics from one row, on the job's own table (nothing shared is analysed).
    await pool().query('ANALYZE agency_insights_rollup_dirty');
    for (let i = 1; i < 10; i++) await mark(i);

    const result = await withReRunningPlan(pool(), async (client: pg.PoolClient) => {
      await assertReRunningPlan(client, 'agency_insights_rollup_dirty', OLD_CLAIM, [3]);
      await client.query('BEGIN');
      try {
        const batch = await repo.recomputeBatch(3, client);
        const left = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM agency_insights_rollup_dirty');
        return { batch, left: left.rows[0]!.n };
      } finally {
        await client.query('ROLLBACK');
      }
    });
    expect(result.batch).toMatchObject({ claimed: 3, marks: 3, buckets: 3 });
    expect(result.left).toBe(7);
    // Rolled back with the transaction: every mark is back.
    expect(await markCount()).toBe(10);
  });

  it('collapses every mark of a claimed bucket, and leaves marks of other buckets', async () => {
    const campaign = await insertAgencyCampaign();
    for (let i = 0; i < 5; i++) {
      await pool().query(`INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start) VALUES ($1, $2)`, [campaign.id, WORLD_BASE]);
    }
    await pool().query(`INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start) VALUES ($1, $2)`,
      [campaign.id, new Date(WORLD_BASE.getTime() + HOUR)]);
    expect(await repo.recomputeBatch(1)).toMatchObject({ claimed: 1, marks: 5, buckets: 1 });
    expect(await markCount()).toBe(1);
    expect(await repo.backlog()).toMatchObject({ buckets: 1 });
  });

  it('a failed batch rolls back: its marks stay, nothing is written, the next batch succeeds', async () => {
    const { campaigns } = await seedWorld(pool(), { campaigns: 1, contactsPer: 30 });
    const before = await markCount();
    expect(before).toBeGreaterThan(0);
    await pool().query(`CREATE FUNCTION pg_temp.fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`).catch(() => undefined);
    await pool().query(`CREATE OR REPLACE FUNCTION insights_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`);
    await pool().query(`CREATE TRIGGER insights_test_fail BEFORE INSERT ON agency_insights_rollup_codes FOR EACH ROW EXECUTE FUNCTION insights_test_fail()`);
    try {
      await expect(repo.recomputeBatch(1000)).rejects.toThrow(/boom/);
      expect(await markCount()).toBe(before);
      const headers = await pool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_insights_rollup_buckets');
      expect(headers.rows[0]!.n).toBe(0);
    } finally {
      await pool().query('DROP TRIGGER insights_test_fail ON agency_insights_rollup_codes');
      await pool().query('DROP FUNCTION insights_test_fail()');
    }
    while ((await repo.recomputeBatch(1000)).claimed > 0) { /* drain */ }
    expect(await markCount()).toBe(0);
    const totals = await oracleTotals(pool(), { campaignId: campaigns[0]!.id, ...LIFETIME }, OVERRIDE_CODES);
    const got = (await repo.activity({ campaignId: campaigns[0]!.id, tenantId: DEFAULTS.tenantId, ...LIFETIME, successCodes: SUCCESS_CODES, overrideCodes: OVERRIDE_CODES }))!;
    expect(got.calls.dials).toBe(totals.calls.dials);
  });

  it('drops the marks of a campaign that no longer exists', async () => {
    await pool().query(`INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start) VALUES ('00000000-0000-0000-0000-0000000000ab', $1)`, [WORLD_BASE]);
    expect(await repo.recomputeBatch(10)).toEqual({ picked: 1, claimed: 1, marks: 1, buckets: 0, attempts: 0 });
    expect(await markCount()).toBe(0);
  });

  it('two concurrent job runs, racing attempt writes and fresh marks for the same buckets, never double count or lose a write', async () => {
    const { campaigns } = await seedWorld(pool(), { campaigns: 2, contactsPer: 150, seed: 77 });
    // For two seconds while four workers run: rewrite random attempts (their triggers mark the
    // buckets, so a batch that skipped a bucket would leave it stale) and re-mark random buckets
    // outright, so batches overlap on the same buckets (a claim skips marks another holds; both
    // then recompute the bucket, serialized on its header).
    const until = Date.now() + 2000;
    const remarker = (async () => {
      for (let i = 0; Date.now() < until; i++) {
        await pool().query(
          `UPDATE agency_call_attempts SET disposition_code = $1
            WHERE id IN (SELECT id FROM agency_call_attempts WHERE bridged_at IS NOT NULL AND state = 'ended'
                          ORDER BY random() LIMIT 10)`, [i % 2 ? 'sale' : 'not_interested']);
        await pool().query(
          `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
           SELECT campaign_id, agency_insights_bucket(dialed_at) FROM agency_call_attempts
            WHERE dialed_at IS NOT NULL ORDER BY random() LIMIT 20`);
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const worker = async (): Promise<number> => {
      let batches = 0;
      while (Date.now() < until || (await repo.backlog()).buckets > 0) {
        const r = await repo.recomputeBatch(7);
        if (r.claimed > 0) batches += 1;
      }
      return batches;
    };
    const workers = await Promise.all([worker(), worker(), worker(), worker()]);
    await remarker;
    expect(workers.filter((n) => n > 0).length).toBeGreaterThan(1);
    while ((await repo.recomputeBatch(500)).claimed > 0) { /* drain the remarker's tail */ }

    for (const campaign of campaigns) {
      const r = { campaignId: campaign.id, ...LIFETIME };
      const got = (await repo.activity({ ...r, tenantId: DEFAULTS.tenantId, successCodes: SUCCESS_CODES, overrideCodes: OVERRIDE_CODES }))!;
      const want = await oracleTotals(pool(), r, OVERRIDE_CODES);
      const { by_outcome: _byOutcome, ...calls } = got.calls;
      expect({ ...calls, talk_seconds: round6(calls.talk_seconds), wrapup_seconds: round6(calls.wrapup_seconds) }).toEqual(want.calls);
      const agents = await oracleAgents(pool(), r);
      expect(Object.fromEntries(got.agents.map(({ agent_user_id: id, ...rest }) => [String(id), {
        ...rest, talk_seconds: round6(rest.talk_seconds), wrapup_seconds: round6(rest.wrapup_seconds),
      }]))).toEqual(agents);
      // One row per key, whatever raced: the unique indexes would have refused a second, and the
      // header count is the distinct buckets with a placed attempt.
      const { rows } = await pool().query<{ headers: number; buckets: number }>(
        `SELECT (SELECT count(*) FROM agency_insights_rollup_buckets WHERE campaign_id = $1)::int AS headers,
                (SELECT count(DISTINCT agency_insights_bucket(dialed_at)) FROM agency_call_attempts
                  WHERE campaign_id = $1 AND dialed_at IS NOT NULL)::int AS buckets`, [campaign.id]);
      expect(rows[0]!.headers).toBe(rows[0]!.buckets);
    }
  });
});

describe('insights rollup job', () => {
  it('drains a backlog in full batches within a pass, publishes it, and stops cleanly', async () => {
    await seedWorld(pool(), { campaigns: 1, contactsPer: 120, seed: 9 });
    const backlog = (await repo.backlog()).buckets;
    expect(backlog).toBeGreaterThan(20);
    const job = startInsightsRollupJob({ intervalMs: 600_000, batchSize: 10 });
    try {
      // The start ran a pass already; a second while it runs is refused, and the next drains what is left.
      let pass = await job.runPass();
      while (pass === null) {
        await new Promise((r) => setTimeout(r, 20));
        pass = await job.runPass();
      }
      expect((await repo.backlog()).buckets).toBe(0);
    } finally {
      await job.stop();
    }
    expect(await job.runPass()).toBeNull();
  });
});
