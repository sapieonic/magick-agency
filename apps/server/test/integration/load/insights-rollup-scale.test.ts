// Real Postgres: the insights rollup at campaign scale. One campaign's month of dialling
// (50,000 attempts by default; LOAD_SCALE=20 is the 1M-attempt run), 50 agents with a state
// change every ten minutes each, seeded with generate_series; the migration's backfill
// statement marks every bucket; the job drains the backlog; then every range read for the
// campaign's LIFETIME, best of three, must finish within the page's budget. Prints the timings
// and each read's plan (EXPLAIN ANALYZE) for docs/insights.md and BASELINE.md.
//
// Seeding runs with the user triggers on agency_call_attempts DISABLED (the dials_placed counter
// would otherwise update a contact per attempt), so the backfill is what marks the buckets, as it
// is in production. The rollup tables (this suite's own) are ANALYZEd outright. The shared
// tables the non-rollup reads plan over (attempts, contacts, sessions, events) are ANALYZEd
// INSIDE a transaction the timed reads run in and that is rolled back, so production-like
// statistics (autovacuum keeps them) never outlive this file: pg_statistic is transactional.
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { scaled } from '../../helpers/load-scale.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
});

// The reads go to `pinned.client` while the timed transaction holds one. A read that opens its
// own transaction (`withTransaction` calls `connect()`) gets the same connection, its
// BEGIN / COMMIT / ROLLBACK turned into a savepoint inside the timed transaction.
const pinned = vi.hoisted(() => ({ client: null as null | import('pg').PoolClient }));
function pinnedPool(client: import('pg').PoolClient) {
  const nested = {
    query: (sql: string, params?: unknown[]) => {
      if (/^BEGIN\b/i.test(sql)) return client.query('SAVEPOINT insights_read');
      if (/^COMMIT\b/i.test(sql)) return client.query('RELEASE SAVEPOINT insights_read');
      if (/^ROLLBACK\b/i.test(sql)) return client.query('ROLLBACK TO SAVEPOINT insights_read');
      return client.query(sql, params);
    },
    release: () => undefined,
  };
  return { query: (sql: string, params?: unknown[]) => client.query(sql, params), connect: async () => nested };
}
vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => (pinned.client ? pinnedPool(pinned.client) : getTestPool()),
}));

const { agencyInsightsRollupRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');

const ATTEMPTS = scaled(50_000);
const PER_CONTACT = 5;
const AGENTS = 50;
const DAYS = 30;
const BASE = new Date('2026-09-01T00:00:00Z');
const END = new Date(BASE.getTime() + DAYS * 86_400_000);
/** The page's budget for one lifetime read. */
const BUDGET_MS = 300;

const pool = () => getTestPool();
let campaignId = '';
const timings: Record<string, number> = {};

/** Printed, and appended to `INSIGHTS_SCALE_OUT` when set (the run's evidence for the report). */
function report(line: string): void {
  console.log(line);
  const out = process.env['INSIGHTS_SCALE_OUT'];
  if (out) appendFileSync(out, `${line}\n`);
}

async function seed(): Promise<void> {
  const { rows: [c] } = await pool().query<{ id: string }>(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, status, default_timezone, disposition_catalog)
     VALUES ($1, $2, 'insights-scale', ARRAY['+919000000001','+919000000002','+919000000003','+919000000004'], 'running', 'Asia/Kolkata',
             '[{"code":"sale","label":"Sale","is_success":true},{"code":"callback","label":"Call back"},{"code":"not_interested","label":"No"}]'::jsonb)
     RETURNING id`, [DEFAULTS.tenantId, DEFAULTS.accountId]);
  campaignId = c!.id;
  await pool().query(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     SELECT $2, $3, $1, gen_random_uuid(), 'offline', $4::timestamptz, $5::timestamptz FROM generate_series(1, $6)`,
    [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, BASE, END, AGENTS]);
  await pool().query(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state, timezone)
     SELECT $1, $2, $3, '+91' || (8000000000 + g)::text,
            (ARRAY['pending','completed','exhausted'])[1 + g % 3], (ARRAY[NULL,'Asia/Kolkata','Asia/Kathmandu'])[1 + g % 3]
       FROM generate_series(1, $4) g`,
    [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, Math.ceil(ATTEMPTS / PER_CONTACT)]);
  await pool().query('ALTER TABLE agency_call_attempts DISABLE TRIGGER USER');
  try {
    await pool().query(
      `WITH s AS (SELECT array_agg(id) AS ids FROM agency_agent_sessions WHERE campaign_id = $1),
            x AS (
              SELECT ct.id AS contact_id, n, row_number() OVER () AS i, random() AS r1, random() AS r2, random() AS r3,
                     $4::timestamptz + random() * make_interval(days => $5::int) AS dialed
                FROM agency_contacts ct CROSS JOIN generate_series(1, $6::int) n
               WHERE ct.campaign_id = $1)
       INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id, state, outcome,
          disposition_code, callback_at, dialed_at, answered_at, bridged_at, ended_at,
          wrapup_started_at, wrapup_ended_at, wrapup_resolution, agent_manual, override_applied)
       SELECT $1, x.contact_id, $2, $3, x.n, (ARRAY['+919000000001','+919000000002','+919000000003','+919000000004'])[1 + (x.i % 4)::int],
              s.ids[1 + floor(x.r3 * ${AGENTS})::int], 'ended',
              CASE WHEN x.r1 < 0.30 THEN 'connected' WHEN x.r1 < 0.55 THEN 'no_answer' WHEN x.r1 < 0.70 THEN 'busy'
                   WHEN x.r1 < 0.80 THEN 'failed' WHEN x.r1 < 0.85 THEN 'abandoned' ELSE 'canceled' END,
              CASE WHEN x.r1 < 0.30 THEN (ARRAY['sale','callback','not_interested','voicemail','no_disposition'])[1 + floor(x.r2 * 5)::int] END,
              CASE WHEN x.r1 < 0.30 AND x.r2 >= 0.2 AND x.r2 < 0.4 THEN x.dialed + interval '1 day' END,
              x.dialed,
              CASE WHEN x.r1 < 0.30 OR (x.r1 >= 0.80 AND x.r1 < 0.85) THEN x.dialed + interval '10 seconds' END,
              CASE WHEN x.r1 < 0.30 THEN x.dialed + interval '10.5 seconds' END,
              x.dialed + interval '15 seconds' + x.r2 * interval '300 seconds',
              CASE WHEN x.r1 < 0.30 THEN x.dialed + interval '15 seconds' + x.r2 * interval '300 seconds' END,
              CASE WHEN x.r1 < 0.30 THEN x.dialed + interval '45 seconds' + x.r2 * interval '300 seconds' END,
              CASE WHEN x.r1 < 0.30 THEN 'disposition_submitted' END,
              x.r3 < 0.02,
              CASE WHEN x.r3 > 0.99 THEN ARRAY['extra_attempts'] ELSE '{}'::text[] END
         FROM x, s
        -- In dial order, as the dialler writes them: a bucket's attempts sit on neighbouring pages.
        ORDER BY x.dialed`,
      [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, BASE, DAYS, PER_CONTACT]);
  } finally {
    await pool().query('ALTER TABLE agency_call_attempts ENABLE TRIGGER USER');
  }
  // A state change every ten minutes per agent, cycling available → on_call → wrapup → break.
  await pool().query(
    `INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, campaign_id, agent_user_id, to_state, break_reason, at)
     SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
            (ARRAY['available','on_call','wrapup','break'])[1 + (k % 4)], CASE WHEN k % 4 = 3 THEN 'lunch' END,
            $2::timestamptz + make_interval(mins => k * 10) + make_interval(secs => (abs(hashtext(s.id::text)) % 300))
       FROM agency_agent_sessions s CROSS JOIN generate_series(0, $3::int * 144 - 1) k
      WHERE s.campaign_id = $1`, [campaignId, BASE, DAYS]);
}

async function bestOf3<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    out = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  timings[name] = Math.round(best);
  return out;
}

beforeAll(async () => {
  await truncateAll();
  const t0 = performance.now();
  await seed();
  timings['seed_ms'] = Math.round(performance.now() - t0);
  report(`seeded ${ATTEMPTS} attempts in ${timings['seed_ms']} ms`);
}, 600_000);

afterAll(async () => {
  report(`insights rollup scale (${ATTEMPTS} attempts): ${JSON.stringify(timings)}`);
  // INSIGHTS_SCALE_KEEP=1 leaves the seeded campaign in this worktree's test database, to
  // EXPLAIN by hand; the next integration file's truncate removes it.
  if (process.env['INSIGHTS_SCALE_KEEP'] === '1') {
    await closeTestPool();
    return;
  }
  // TRUNCATE, not truncateAll's DELETE: a row-by-row delete of a million attempts and their
  // cascades runs for longer than any hook timeout.
  const t0 = performance.now();
  await pool().query(
    `TRUNCATE agency_call_attempts, agency_contacts, agency_agent_session_events, agency_agent_sessions,
              agency_insights_rollup_dirty, agency_insights_rollup_buckets, agency_campaigns CASCADE`);
  await truncateAll();
  report(`cleanup ${Math.round(performance.now() - t0)} ms`);
  await closeTestPool();
}, 600_000);

describe(`insights rollup at scale (${ATTEMPTS} attempts, one campaign)`, () => {
  it('backfills, drains, and serves every lifetime read within budget', async () => {
    let t0 = performance.now();
    // The migration's backfill statement, for this campaign.
    await pool().query(
      `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
       SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at)
         FROM agency_call_attempts WHERE dialed_at IS NOT NULL ORDER BY 2, 1`);
    timings['backfill_marks_ms'] = Math.round(performance.now() - t0);
    const backlog = (await repo.backlog()).buckets;
    const { rows: [distinct] } = await pool().query<{ n: number }>(
      `SELECT count(DISTINCT agency_insights_bucket(dialed_at))::int AS n FROM agency_call_attempts WHERE campaign_id = $1`, [campaignId]);
    expect(backlog).toBe(distinct!.n);

    t0 = performance.now();
    let batches = 0;
    let slowest = 0;
    for (;;) {
      const b0 = performance.now();
      const r = await repo.recomputeBatch(200);
      if (r.claimed === 0) break;
      batches += 1;
      slowest = Math.max(slowest, performance.now() - b0);
    }
    timings['drain_ms'] = Math.round(performance.now() - t0);
    timings['batches'] = batches;
    timings['slowest_batch_ms'] = Math.round(slowest);
    report(`drained ${backlog} buckets in ${batches} batches, ${timings['drain_ms']} ms`);
    for (const t of ['buckets', 'agents', 'codes', 'facets']) await pool().query(`ANALYZE agency_insights_rollup_${t}`);
    const { rows: sizes } = await pool().query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM agency_insights_rollup_buckets)::text AS buckets, (SELECT count(*) FROM agency_insights_rollup_agents)::text AS agents,
              (SELECT count(*) FROM agency_insights_rollup_codes)::text AS codes, (SELECT count(*) FROM agency_insights_rollup_facets)::text AS facets`);
    report(`rollup rows ${JSON.stringify(sizes[0])}`);

    const client = await pool().connect();
    try {
      // REPEATABLE READ, as the activity read's own transaction is.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      for (const t of ['agency_call_attempts', 'agency_contacts', 'agency_agent_sessions', 'agency_agent_session_events']) {
        await client.query(`ANALYZE ${t}`);
      }
      pinned.client = client;
      await timedReads();
    } finally {
      pinned.client = null;
      await client.query('ROLLBACK');
      client.release();
    }
  }, 600_000);
});

async function timedReads(): Promise<void> {
  {
    const q = { campaignId, tenantId: DEFAULTS.tenantId, from: BASE, to: END };
    const activity = (await bestOf3('activity_ms', () => repo.activity({ ...q, successCodes: ['sale'], overrideCodes: ['callback'] })))!;
    expect(activity.calls.dials).toBe(Math.ceil(ATTEMPTS / PER_CONTACT) * PER_CONTACT);
    expect(activity.reconciliation.every((r) => r.ok)).toBe(true);
    for (const bucket of ['quarter_hour', 'hour', 'day'] as const) {
      const trends = (await bestOf3(`trends_${bucket}_ms`, () => repo.trends({ ...q, bucket, timezone: 'Asia/Kolkata', successCodes: ['sale'] })))!;
      expect(trends.buckets.reduce((s, b) => s + b.dials, 0)).toBe(activity.calls.dials);
    }
    await bestOf3('caller_ids_ms', () => repo.callerIds(q));
    await bestOf3('recording_ms', () => repo.recording(q));
    await bestOf3('carrier_failures_ms', () => repo.carrierFailures(q));
    await bestOf3('as_of_ms', () => repo.asOf(q));
    const rollupReads = ['activity_ms', 'trends_quarter_hour_ms', 'trends_hour_ms', 'trends_day_ms', 'caller_ids_ms', 'recording_ms', 'carrier_failures_ms', 'as_of_ms'];
    for (const name of rollupReads) expect(timings[name], name).toBeLessThan(BUDGET_MS);

    // Not rollup reads: they scale with the range's events and callbacks. Timed and reported.
    await bestOf3('callback_timing_ms', () => repo.callbackTiming({ ...q, now: END }));
    await bestOf3('agent_state_seconds_ms', () => repo.agentStateSeconds(q));
    await bestOf3('agents_online_peak_day_ms', () => repo.agentsOnlinePeak({ ...q, bucket: 'day', timezone: 'Asia/Kolkata' }));

    // The plans, for the report.
    for (const [name, sql] of [
      ['activity totals', `SELECT SUM(r.dials) FROM agency_insights_rollup_buckets r WHERE r.campaign_id = $1 AND r.bucket_start >= $2 AND r.bucket_start < $3`],
      ['activity agents', `SELECT r.agent_user_id, SUM(r.dials) FROM agency_insights_rollup_agents r WHERE r.campaign_id = $1 AND r.bucket_start >= $2 AND r.bucket_start < $3 GROUP BY 1`],
      ['activity codes', `SELECT r.agent_user_id, r.disposition_code, SUM(r.conversations) FROM agency_insights_rollup_codes r WHERE r.campaign_id = $1 AND r.bucket_start >= $2 AND r.bucket_start < $3 GROUP BY 1, 2`],
      ['caller ids', `SELECT r.key, SUM(r.n) FROM agency_insights_rollup_facets r WHERE r.campaign_id = $1 AND r.facet = 'caller_id' AND r.bucket_start >= $2 AND r.bucket_start < $3 GROUP BY 1`],
      ['recompute src (one bucket)', `SELECT count(*) FROM agency_call_attempts a WHERE a.campaign_id = $1 AND a.dialed_at >= $2 AND a.dialed_at < $2::timestamptz + interval '15 minutes' AND $3::timestamptz IS NOT NULL`],
    ] as const) {
      const { rows } = await pinned.client!.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${sql}`, [campaignId, BASE, END]);
      report(`plan: ${name}\n${rows.map((r) => `  ${r['QUERY PLAN']}`).join('\n')}`);
    }
  }
}
