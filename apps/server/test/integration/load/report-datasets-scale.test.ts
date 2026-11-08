// Real Postgres: the three report dataset builders on a large floor's month, end to end below the
// pipeline (docs/reports.md "Datasets", "Cost"): one campaign, 50,000 × LOAD_SCALE attempts over
// 31 days by 50 agents (20 = 1,000,000), a state change every ten minutes per agent, ~20% of
// connects booking a callback. Each builder is timed cold for a 30-day window (best of two),
// then every detail sheet is drained and timed, with the peak heap the drain reached.
//
// MEASUREMENT ONLY, opt-in: `REPORT_DATASETS_SCALE=1` (skipped otherwise), like
// `insights-range-routes-scale.test.ts`, whose seed this follows. It asserts only that each
// dataset is whole (the days and the sheets' row counts), never a time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 20 });

const RUN = process.env['REPORT_DATASETS_SCALE'] === '1';
const { agencyInsightsRollupRepository: rollup } = await import('../../../src/db/repositories/agency.repository.js');
const { REPORT_DATASET_BUILDERS } = await import('../../../src/agency/reports/datasets/index.js');
const { insightsCache } = await import('../../../src/agency/insights/cache.js');
const { localDateOf, localDayBounds } = await import('../../../src/agency/reports/schedule.js');

const ATTEMPTS = scaled(50_000);
const PER_CONTACT = 5;
const AGENTS = 50;
const DAYS = 31;
const ZONE = 'Asia/Kolkata';
const NOW = new Date();
const BASE = new Date(Math.floor((NOW.getTime() - DAYS * 86_400_000) / 900_000) * 900_000);
const TENANT = randomUUID();
const ACCOUNT = randomUUID();
const pool = () => getTestPool();
let campaignId = '';
let agentId = '';
const timings: Record<string, number> = {};

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const TO = shiftDate(localDateOf(NOW, ZONE), -1);
const FROM = shiftDate(TO, -29);

async function seed(): Promise<void> {
  await pool().query(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'Scale', $2, '{}', 'active')`, [TENANT, `scale-${TENANT.slice(0, 8)}`]);
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'Scale floor', $3, '{}', 'active')`, [ACCOUNT, TENANT, `scale-a-${ACCOUNT.slice(0, 8)}`]);
  const { rows: [c] } = await pool().query<{ id: string }>(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, status, default_timezone, assignment_mode, created_at, disposition_catalog)
     VALUES ($1, $2, 'report-scale', ARRAY['+919000000001','+919000000002','+919000000003','+919000000004'], 'running', $4, 'strict', $3,
             '[{"code":"sale","label":"Sale","is_success":true},{"code":"callback","label":"Call back","requires_datetime":true},{"code":"not_interested","label":"No","override":{"extra_attempts":1}}]'::jsonb)
     RETURNING id`, [TENANT, ACCOUNT, BASE, ZONE]);
  campaignId = c!.id;
  await pool().query(
    `WITH u AS (
       INSERT INTO users (id, firebase_uid, email, display_name, status)
       SELECT gen_random_uuid(), 'scale-' || g, 'scale-' || g || '@scale.example.com', 'Agent ' || g, 'active' FROM generate_series(1, $4) g
       RETURNING id)
     , m AS (INSERT INTO memberships (user_id, tenant_id, account_id, role, status) SELECT id, $2, $3, 'agent', 'active' FROM u RETURNING user_id)
     INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     SELECT $2, $3, $1, user_id, 'offline', $5::timestamptz, $6::timestamptz FROM m`,
    [campaignId, TENANT, ACCOUNT, AGENTS, BASE, NOW]);
  await pool().query(
    `WITH s AS (SELECT array_agg(agent_user_id ORDER BY id) AS users FROM agency_agent_sessions WHERE campaign_id = $1)
     INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state, timezone, assigned_user_id, assigned_at, next_attempt_at)
     SELECT $1, $2, $3, '+91' || (8000000000 + g)::text,
            (ARRAY['pending','completed','exhausted'])[1 + g % 3], (ARRAY[NULL,'Asia/Kolkata','Asia/Kathmandu'])[1 + g % 3],
            s.users[1 + g % ${AGENTS}], now(), now() + make_interval(mins => (g % 600) - 300)
       FROM generate_series(1, $4) g, s`,
    [campaignId, TENANT, ACCOUNT, Math.ceil(ATTEMPTS / PER_CONTACT)]);
  await pool().query('ALTER TABLE agency_call_attempts DISABLE TRIGGER USER');
  try {
    await pool().query(
      `WITH s AS (SELECT agent_user_id, id FROM agency_agent_sessions WHERE campaign_id = $1),
            x AS (
              SELECT ct.id AS contact_id, ct.assigned_user_id, n, row_number() OVER () AS i, random() AS r1, random() AS r2, random() AS r3,
                     $4::timestamptz + random() * make_interval(days => $5::int) AS dialed
                FROM agency_contacts ct CROSS JOIN generate_series(1, $6::int) n
               WHERE ct.campaign_id = $1)
       INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, reserved_agent_id, state, outcome,
          disposition_code, callback_at, dialed_at, answered_at, bridged_at, ended_at,
          wrapup_started_at, wrapup_ended_at, wrapup_resolution, agent_manual, agent_reopened, redial_number, override_applied)
       SELECT $1, x.contact_id, $2, $3, x.n, (ARRAY['+919000000001','+919000000002','+919000000003','+919000000004'])[1 + (x.i % 4)::int],
              s.id, 'ended',
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
              x.r3 < 0.02, x.r3 >= 0.02 AND x.r3 < 0.04, CASE WHEN x.r3 >= 0.04 AND x.r3 < 0.07 THEN 1 ELSE 0 END,
              CASE WHEN x.r3 > 0.99 THEN ARRAY['extra_attempts'] ELSE '{}'::text[] END
         FROM x JOIN s ON s.agent_user_id = x.assigned_user_id
        ORDER BY x.dialed`,
      [campaignId, TENANT, ACCOUNT, BASE, DAYS, PER_CONTACT]);
  } finally {
    await pool().query('ALTER TABLE agency_call_attempts ENABLE TRIGGER USER');
  }
  await pool().query(
    `INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, campaign_id, agent_user_id, to_state, break_reason, at)
     SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
            (ARRAY['available','on_call','wrapup','break'])[1 + (k % 4)], CASE WHEN k % 4 = 3 THEN 'lunch' END,
            $2::timestamptz + make_interval(mins => k * 10) + make_interval(secs => (abs(hashtext(s.id::text)) % 300))
       FROM agency_agent_sessions s CROSS JOIN generate_series(0, $3::int * 144 - 1) k
      WHERE s.campaign_id = $1`, [campaignId, BASE, DAYS]);
  await pool().query(
    `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
     SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at) FROM agency_call_attempts WHERE dialed_at IS NOT NULL ORDER BY 2, 1`);
  for (;;) if ((await rollup.recomputeBatch(200)).claimed === 0) break;
  for (const t of ['agency_call_attempts', 'agency_contacts', 'agency_agent_sessions', 'agency_agent_session_events', 'memberships', 'users',
    'agency_insights_rollup_buckets', 'agency_insights_rollup_agents', 'agency_insights_rollup_codes', 'agency_insights_rollup_facets']) {
    await pool().query(`ANALYZE ${t}`);
  }
  const { rows: [a] } = await pool().query<{ id: string }>('SELECT agent_user_id AS id FROM agency_agent_sessions WHERE campaign_id = $1 LIMIT 1', [campaignId]);
  agentId = a!.id;
}

function run(kind: 'agent' | 'campaign' | 'account', subject: string) {
  const zone = ZONE;
  const { start, end } = localDayBounds(FROM, TO, zone);
  return {
    id: randomUUID(), tenant_id: TENANT, account_id: ACCOUNT, kind, subject_id: subject, campaign_ids: null,
    range_from: start, range_to: end, local_from: FROM, local_to: TO, timezone: zone, formats: ['pdf' as const],
    audience: 'supervisor' as const, requested_by: null, email_me: false, subscription_id: null, period_start: null,
    status: 'assembling' as const, claim_generation: 1, claimed_at: new Date(), render_attempt: 0, sent_at: null, dataset_key: null,
    detail_files: [], files: [], truncated: false, renderer_version: null, error_code: null, error_message: null,
    notified_at: null, created_at: new Date(), finished_at: null, expires_at: null,
  };
}

beforeAll(async () => {
  if (!RUN) return;
  await truncateAll();
  const t0 = performance.now();
  await seed();
  console.log(`seeded and rolled up ${ATTEMPTS} attempts in ${Math.round(performance.now() - t0)} ms`);
}, 3_600_000);

afterAll(async () => {
  if (RUN) {
    console.log(`report dataset builders at scale (${ATTEMPTS} attempts, 30-day window): ${JSON.stringify(timings)}`);
    // TRUNCATE first: a DELETE of a million attempts fires the rollup's marking triggers.
    await pool().query(
      `TRUNCATE agency_call_attempts, agency_contacts, agency_agent_session_events, agency_agent_sessions,
                agency_insights_rollup_dirty, agency_insights_rollup_buckets, agency_campaigns CASCADE`);
    await truncateAll();
  }
  await closeTestPool();
  await closePool();
}, 600_000);

describe.skipIf(!RUN)(`report dataset builders at scale (${ATTEMPTS} attempts)`, () => {
  it('times each builder and drains every detail sheet', async () => {
    for (const [kind, subject] of [['agent', agentId], ['campaign', campaignId], ['account', ACCOUNT]] as const) {
      let built!: Awaited<ReturnType<(typeof REPORT_DATASET_BUILDERS)['agent']>>;
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        insightsCache.clear();
        const t0 = performance.now();
        built = await REPORT_DATASET_BUILDERS[kind]({ run: run(kind, subject), now: new Date() });
        best = Math.min(best, performance.now() - t0);
      }
      timings[`${kind}_build_ms`] = Math.round(best);
      expect(built.dataset.range.days).toBe(30);
      for (const src of built.details) {
        const t0 = performance.now();
        let rows = 0;
        let peak = process.memoryUsage().heapUsed;
        for await (const _row of src.rows()) {
          rows += 1;
          if (rows % 10_000 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed);
        }
        timings[`${kind}_${src.sheet}_rows`] = rows;
        timings[`${kind}_${src.sheet}_drain_ms`] = Math.round(performance.now() - t0);
        timings[`${kind}_${src.sheet}_peak_heap_mb`] = Math.round(peak / 1048576);
        expect(getPool().totalCount - getPool().idleCount).toBe(0);
      }
    }
  }, 3_600_000);
});
