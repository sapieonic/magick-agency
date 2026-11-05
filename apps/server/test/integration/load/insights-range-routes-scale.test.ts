// Real Postgres: the insights range routes' assembly (activity, trends, health) and the
// allocation, end to end below the guards, on one campaign's month of dialling: 1,000,000
// attempts, 200,000 contacts owned by 50 agents, ~60,000 callbacks, a state change every ten
// minutes per agent. Each read is timed cold (the insights cache cleared), best of three, for the
// lifetime and for the last seven days, and the slow parts' plans are printed (EXPLAIN ANALYZE):
// the evidence for docs/insights.md "API (range reads)", "Cost".
//
// MEASUREMENT ONLY, opt-in: `INSIGHTS_RANGE_SCALE=1` (skipped otherwise). The tables are ANALYZEd
// for real, as autovacuum would leave them in production, so the plans are the ones a normally
// analysed table gets; the statistics outlive the file, which is why it never runs in the lanes
// (the next run's global setup re-creates the database). It also asserts nothing about time:
// it reports. `LOAD_SCALE` multiplies the size from its 50,000-attempt base (20 = 1M).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { scaled } from '../../helpers/load-scale.js';

// The real pool, as the app's (the assembly reads repositories in packages/db and here alike).
initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 20 });

const RUN = process.env['INSIGHTS_RANGE_SCALE'] === '1';
const { agencyCampaignRepository, agencyInsightsRollupRepository: rollup } = await import('../../../src/db/repositories/agency.repository.js');
const { computeActivity } = await import('../../../src/agency/insights/activity.js');
const { computeTrends } = await import('../../../src/agency/insights/trends.js');
const { computeHealth } = await import('../../../src/agency/insights/health.js');
const { computeAllocation } = await import('../../../src/agency/insights/allocation.js');
const { insightsCache } = await import('../../../src/agency/insights/cache.js');
const { parseInsightsRange } = await import('../../../src/agency/insights/range.js');

const ATTEMPTS = scaled(50_000);
const PER_CONTACT = 5;
const AGENTS = 50;
const DAYS = 30;
const NOW = new Date();
const BASE = new Date(Math.floor((NOW.getTime() - DAYS * 86_400_000) / 900_000) * 900_000);
const pool = () => getTestPool();
let campaignId = '';
const timings: Record<string, number> = {};

function report(line: string): void {
  console.log(line);
  const out = process.env['INSIGHTS_SCALE_OUT'];
  if (out) appendFileSync(out, `${line}\n`);
}

async function seed(): Promise<void> {
  const { rows: [c] } = await pool().query<{ id: string }>(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, status, default_timezone, assignment_mode, created_at, disposition_catalog)
     VALUES ($1, $2, 'insights-range-scale', ARRAY['+919000000001','+919000000002','+919000000003','+919000000004'], 'running', 'Asia/Kolkata', 'strict', $3,
             '[{"code":"sale","label":"Sale","is_success":true},{"code":"callback","label":"Call back","requires_datetime":true},{"code":"not_interested","label":"No","override":{"extra_attempts":1}}]'::jsonb)
     RETURNING id`, [DEFAULTS.tenantId, DEFAULTS.accountId, BASE]);
  campaignId = c!.id;
  await pool().query(
    `INSERT INTO agency_agent_sessions (tenant_id, account_id, campaign_id, agent_user_id, state, joined_at, left_at)
     SELECT $2, $3, $1, gen_random_uuid(), 'offline', $4::timestamptz, $5::timestamptz FROM generate_series(1, $6)`,
    [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, BASE, NOW, AGENTS]);
  // Contacts owned by the agents (strict: an owner's contacts are dialled by the owner's session).
  await pool().query(
    `WITH s AS (SELECT array_agg(agent_user_id ORDER BY id) AS users FROM agency_agent_sessions WHERE campaign_id = $1)
     INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state, timezone, assigned_user_id, assigned_at, next_attempt_at)
     SELECT $1, $2, $3, '+91' || (8000000000 + g)::text,
            (ARRAY['pending','completed','exhausted'])[1 + g % 3], (ARRAY[NULL,'Asia/Kolkata','Asia/Kathmandu'])[1 + g % 3],
            s.users[1 + g % ${AGENTS}], now(), now() + make_interval(mins => (g % 600) - 300)
       FROM generate_series(1, $4) g, s`,
    [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, Math.ceil(ATTEMPTS / PER_CONTACT)]);
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
      [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, BASE, DAYS, PER_CONTACT]);
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
  // The migration's backfill, then the job until the backlog is empty.
  await pool().query(
    `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start)
     SELECT DISTINCT campaign_id, agency_insights_bucket(dialed_at) FROM agency_call_attempts WHERE dialed_at IS NOT NULL ORDER BY 2, 1`);
  for (;;) if ((await rollup.recomputeBatch(200)).claimed === 0) break;
  for (const t of ['agency_call_attempts', 'agency_contacts', 'agency_agent_sessions', 'agency_agent_session_events',
    'agency_insights_rollup_buckets', 'agency_insights_rollup_agents', 'agency_insights_rollup_codes', 'agency_insights_rollup_facets']) {
    await pool().query(`ANALYZE ${t}`);
  }
}

async function bestOf3<T>(name: string, fn: () => Promise<T>): Promise<T> {
  let best = Infinity;
  let out!: T;
  for (let i = 0; i < 3; i++) {
    insightsCache.clear();
    const t0 = performance.now();
    out = await fn();
    best = Math.min(best, performance.now() - t0);
  }
  timings[name] = Math.round(best);
  return out;
}

async function explain(name: string, sql: string, values: unknown[]): Promise<void> {
  const { rows } = await pool().query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF) ${sql}`, values);
  report(`plan: ${name}\n${rows.map((r) => `  ${r['QUERY PLAN']}`).join('\n')}`);
}

beforeAll(async () => {
  if (!RUN) return;
  await truncateAll();
  const t0 = performance.now();
  await seed();
  report(`seeded and rolled up ${ATTEMPTS} attempts in ${Math.round(performance.now() - t0)} ms`);
}, 1_800_000);

afterAll(async () => {
  if (RUN) {
    report(`insights range routes at scale (${ATTEMPTS} attempts): ${JSON.stringify(timings)}`);
    await pool().query(
      `TRUNCATE agency_call_attempts, agency_contacts, agency_agent_session_events, agency_agent_sessions,
                agency_insights_rollup_dirty, agency_insights_rollup_buckets, agency_campaigns CASCADE`);
    await truncateAll();
  }
  await closeTestPool();
  await closePool();
}, 600_000);

describe.skipIf(!RUN)(`insights range routes at scale (${ATTEMPTS} attempts, one campaign)`, () => {
  it('times activity, trends, health and the allocation, lifetime and last 7 days', async () => {
    const campaign = (await agencyCampaignRepository.findById(campaignId))!;
    const now = new Date();
    const ranges = {
      lifetime: {},
      last7: { from: new Date(now.getTime() - 7 * 86_400_000).toISOString() },
    };
    for (const [label, query] of Object.entries(ranges)) {
      const parsed = parseInsightsRange({ ...query }, { createdAt: new Date(campaign.created_at), now, bucket: true });
      if (!parsed.ok) throw new Error(parsed.message);
      const range = parsed.range;
      const plain = { ...range, bucket: null };
      const activity = await bestOf3(`activity_${label}_ms`, () => computeActivity(campaign, plain));
      expect(activity.reconciliation.every((r) => r.ok)).toBe(true);
      await bestOf3(`trends_${label}_${range.bucket}_ms`, () => computeTrends(campaign, { ...range, bucket: range.bucket! }));
      await bestOf3(`trends_${label}_day_ms`, () => computeTrends(campaign, { ...range, bucket: 'day' }));
      await bestOf3(`health_${label}_ms`, () => computeHealth(campaign, plain));
      const q = { campaignId, tenantId: campaign.tenant_id, from: range.from, to: range.to };
      await bestOf3(`part_rollup_activity_${label}_ms`, () => rollup.activity({ ...q, successCodes: ['sale'], overrideCodes: ['not_interested'] }));
      await bestOf3(`part_callback_timing_${label}_ms`, () => rollup.callbackTiming({ ...q, now }));
      await bestOf3(`part_agent_state_seconds_${label}_ms`, () => rollup.agentStateSeconds(q));
      await bestOf3(`part_online_peak_day_${label}_ms`, () => rollup.agentsOnlinePeak({ ...q, bucket: 'day', timezone: 'Asia/Kolkata' }));
    }
    await bestOf3('allocation_ms', () => computeAllocation(campaign));

    // The occupancy intervals' plan on normally analysed tables (the nested-loop risk), and the
    // allocation counters' plan.
    const { occupancyIntervalsCtes, allocationCountersStatement } = await import('../../../src/db/repositories/agency.repository.js');
    await explain('agent state seconds (lifetime)',
      `${occupancyIntervalsCtes('campaign', '')} SELECT i.agent_user_id, i.state, SUM(EXTRACT(EPOCH FROM (i.ended - i.started))) FROM intervals i WHERE i.ended > i.started GROUP BY 1, 2`,
      [campaignId, BASE, now, campaign.tenant_id]);
    const counters = allocationCountersStatement(campaignId);
    await explain('allocation counters', counters.text, counters.values);
  }, 1_800_000);
});
