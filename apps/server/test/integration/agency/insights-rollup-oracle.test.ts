// Real Postgres: the insights rollup (migrations 0012 and 0014) against an oracle computed straight from
// agency_call_attempts with /stats' definitions (insights-rollup-oracle-sql.ts). A seeded random
// history across campaigns in UTC, Asia/Kolkata (+05:30), Asia/Kathmandu (+05:45) and
// America/New_York, contacts in five zones (one unresolvable), every attempt shape the rollup
// reads; then the writes that make a rollup drift (late dispositions, the reaper's outcome
// rewrite, a recording or a carrier error code arriving, dialed_at moving bucket, a contact's and a campaign's zone, a
// deleted attempt), checked stale before the job and equal after it.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { OVERRIDE_CODES, SUCCESS_CODES, WORLD_BASE, seedWorld, type WorldCampaign } from './insights-rollup-world.js';
import { oracleAgents, oracleFacets, oracleTotals, oracleTrend, type OracleRange } from './insights-rollup-oracle-sql.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInsightsRollupRepository: repo, agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');

const pool = () => getTestPool();
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const HOUR = 3_600_000;

let campaigns: WorldCampaign[] = [];

async function drain(): Promise<number> {
  let buckets = 0;
  for (;;) {
    const r = await repo.recomputeBatch(50);
    if (r.claimed === 0) return buckets;
    buckets += r.buckets;
  }
}

/** Lifetime, and a bucket-aligned 7-hour slice that starts mid-day. */
function ranges(campaignId: string): OracleRange[] {
  return [
    { campaignId, from: new Date(WORLD_BASE.getTime() - 24 * HOUR), to: new Date(WORLD_BASE.getTime() + 96 * HOUR) },
    { campaignId, from: new Date(WORLD_BASE.getTime() + 13.25 * HOUR), to: new Date(WORLD_BASE.getTime() + 20.25 * HOUR) },
  ];
}

/** Expected trend labels for a zone with a fixed offset (no DST in the world's window). */
function expectedLabels(bucket: 'quarter_hour' | 'hour' | 'day', from: Date, to: Date, offsetMinutes: number): string[] {
  const out: string[] = [];
  if (bucket === 'day') {
    const day = (t: number) => new Date(t + offsetMinutes * 60_000).toISOString().slice(0, 10);
    for (let t = from.getTime(); t < to.getTime(); t += 15 * 60_000) if (out.at(-1) !== day(t)) out.push(day(t));
    return out;
  }
  const step = bucket === 'hour' ? HOUR : 15 * 60_000;
  const shift = bucket === 'hour' ? offsetMinutes * 60_000 : 0;
  let t = Math.floor((from.getTime() + shift) / step) * step - shift;
  for (; t < to.getTime(); t += step) out.push(new Date(t).toISOString());
  return out;
}
const OFFSETS: Record<string, number> = { UTC: 0, 'Asia/Kolkata': 330, 'Asia/Kathmandu': 345, 'America/New_York': -240 };

async function assertMatchesOracle(): Promise<void> {
  for (const campaign of campaigns) {
    for (const r of ranges(campaign.id)) {
      const scope = { campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from: r.from, to: r.to };
      const tag = `${campaign.zone} ${r.from.toISOString()}`;
      const oracle = await oracleTotals(pool(), r, OVERRIDE_CODES);
      const activity = (await repo.activity({ ...scope, successCodes: SUCCESS_CODES, overrideCodes: OVERRIDE_CODES }))!;

      const { by_outcome: byOutcome, ...calls } = activity.calls;
      expect({ ...calls, talk_seconds: round6(calls.talk_seconds), wrapup_seconds: round6(calls.wrapup_seconds) }, tag)
        .toEqual(oracle.calls);
      const nonZero = Object.fromEntries(Object.entries(byOutcome).filter(([, n]) => n > 0));
      expect(nonZero, tag).toEqual(oracle.by_outcome);
      expect(Object.fromEntries(activity.outcomes.map((o) => [String(o.code), o.count])), tag).toEqual(oracle.outcomes);
      expect(activity.no_outcome.by_resolution, tag).toEqual(oracle.no_outcome);
      expect(Object.fromEntries(activity.overrides.map((o) => [o.code, {
        granted: o.granted, used: o.used,
        by_agent: Object.fromEntries(o.by_agent.map((a) => [String(a.agent_user_id), { granted: a.granted, used: a.used }])),
      }])), tag).toEqual(oracle.overrides);
      expect(activity.reconciliation.filter((c) => !c.ok), tag).toEqual([]);

      const agents = await oracleAgents(pool(), r);
      expect(Object.fromEntries(activity.agents.map(({ agent_user_id: id, ...rest }) => [String(id), {
        ...rest, talk_seconds: round6(rest.talk_seconds), wrapup_seconds: round6(rest.wrapup_seconds),
      }])), tag).toEqual(agents);

      const facets = await oracleFacets(pool(), r);
      const ids = (await repo.callerIds(scope))!;
      expect(Object.fromEntries(ids.map((i) => [i.caller_id, {
        dials: i.dials, first_dials: i.first_dials, human_connects: i.human_connects, connected: i.connected,
      }])), tag).toEqual(facets.caller_ids);
      const failures = (await repo.carrierFailures(scope))!;
      expect(failures.failed, tag).toBe(oracle.failed);
      expect(Object.fromEntries(failures.by_code.map((c) => [String(c.error_code), c.count])), tag).toEqual(oracle.failed_by_code);
      expect(failures.by_code.reduce((sum, c) => sum + c.count, 0), tag).toBe(failures.failed);
      expect(await repo.recording(scope), tag).toEqual({ connected: oracle.calls.connected, recorded: oracle.calls.recorded_connected });

      for (const bucket of ['quarter_hour', 'hour', 'day'] as const) {
        const trends = (await repo.trends({ ...scope, bucket, timezone: campaign.zone, successCodes: SUCCESS_CODES }))!;
        expect(trends.timezone).toBe(campaign.zone);
        expect(trends.best_hours, `${tag} best hours`).toEqual(facets.best_hours);
        const expected = await oracleTrend(pool(), r, bucket, campaign.zone);
        const got = Object.fromEntries(trends.buckets.filter((b) => b.dials > 0)
          .map(({ bucket_start: label, ...rest }) => [label, rest]));
        expect(got, `${tag} ${bucket}`).toEqual(expected);
        // Zero-filled: every bucket of the range, in order, none twice.
        expect(trends.buckets.map((b) => b.bucket_start), `${tag} ${bucket} spine`)
          .toEqual(expectedLabels(bucket, r.from, r.to, OFFSETS[campaign.zone]!));
      }
    }
    // Freshness: the newest attempt change folded in, nothing pending.
    const lifetime = ranges(campaign.id)[0]!;
    expect(await repo.asOf({ campaignId: campaign.id, tenantId: DEFAULTS.tenantId }))
      .toEqual({ as_of: (await oracleTotals(pool(), lifetime, OVERRIDE_CODES)).as_of, pending_buckets: 0 });
  }
}

beforeAll(async () => {
  await truncateAll();
  ({ campaigns } = await seedWorld(pool(), { campaigns: 4, contactsPer: 220 }));
});
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

describe('insights rollup — every read equals the attempts table', () => {
  it('seeds a varied history (the oracle is not vacuous)', async () => {
    const { rows } = await pool().query<Record<string, string>>(
      `SELECT count(*)::text AS n,
              count(*) FILTER (WHERE redial_number = 2)::text AS at_limit,
              count(*) FILTER (WHERE state <> 'ended')::text AS live,
              count(*) FILTER (WHERE cardinality(override_applied) > 0)::text AS overrides,
              count(*) FILTER (WHERE callback_at IS NOT NULL)::text AS callbacks,
              count(*) FILTER (WHERE dialed_at = agency_insights_bucket(dialed_at))::text AS on_boundary
         FROM agency_call_attempts`);
    const n = rows[0]!;
    expect(Number(n['n'])).toBeGreaterThan(2500);
    for (const k of ['at_limit', 'live', 'overrides', 'callbacks', 'on_boundary']) expect(Number(n[k]), k).toBeGreaterThan(0);
  });

  it('after the backfill job, every read matches', async () => {
    expect(await drain()).toBeGreaterThan(100);
    expect((await repo.backlog()).buckets).toBe(0);
    await assertMatchesOracle();
  });

  it('each rollup table is read for one campaign and range through its own index', async () => {
    // Sequential scans priced out, so the near-empty tables do not make a scan cheaper than any
    // index; what remains is whether an index serves the read (one campaign among many).
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = async (sql: string) => (await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) ${sql}`, [campaigns[0]!.id, WORLD_BASE, new Date(WORLD_BASE.getTime() + 48 * HOUR)]))
        .rows.map((r) => r['QUERY PLAN']).join('\n');
      const range = 'r.campaign_id = $1 AND r.bucket_start >= $2 AND r.bucket_start < $3';
      expect(await plan(`SELECT SUM(r.dials) FROM agency_insights_rollup_buckets r WHERE ${range}`)).toMatch(/agency_insights_rollup_buckets_pkey/);
      expect(await plan(`SELECT r.agent_user_id, SUM(r.dials) FROM agency_insights_rollup_agents r WHERE ${range} GROUP BY 1`)).toMatch(/uq_agency_insights_rollup_agents/);
      expect(await plan(`SELECT r.disposition_code, SUM(r.conversations) FROM agency_insights_rollup_codes r WHERE ${range} GROUP BY 1`)).toMatch(/uq_agency_insights_rollup_codes/);
      expect(await plan(`SELECT r.key, SUM(r.n) FROM agency_insights_rollup_facets r WHERE ${range} AND r.facet = 'caller_id' GROUP BY 1`)).toMatch(/uq_agency_insights_rollup_facets/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the day trend agrees with the supervisor series (/stats/series) in the campaign zone', async () => {
    for (const campaign of campaigns) {
      const from = new Date('2026-09-30T00:00:00Z');
      const to = new Date('2026-10-05T00:00:00Z');
      const series = (await agencyCampaignRepository.statsSeries(
        { tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId }, campaign.id, { from, to, bucket: 'day' }))!;
      const trends = (await repo.trends({ campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from, to, bucket: 'day', timezone: campaign.zone, successCodes: SUCCESS_CODES }))!;
      expect(trends.buckets.map((b) => ({ bucket_start: b.bucket_start, attempts: b.dials, connected: b.conversations, successes: b.successes })))
        .toEqual(series.buckets.map((b) => ({ bucket_start: b.bucket_start, attempts: b.attempts, connected: b.connected, successes: b.successes })));
    }
  });

  it('after the writes that make a rollup drift, it is stale until the job runs, then matches again', async () => {
    const c0 = campaigns[0]!;
    const c1 = campaigns[1]!;
    // Late dispositions on connected calls that had none.
    await pool().query(
      `UPDATE agency_call_attempts SET disposition_code = 'sale', wrapup_resolution = 'disposition_submitted',
              wrapup_started_at = ended_at, wrapup_ended_at = ended_at + interval '17 seconds'
        WHERE id IN (SELECT id FROM agency_call_attempts WHERE campaign_id = $1 AND bridged_at IS NOT NULL
                       AND disposition_code IS NULL AND state = 'ended' ORDER BY id LIMIT 40)`, [c0.id]);
    // The reaper rewrites outcomes (orphaned, ended at sweep time).
    await pool().query(
      `UPDATE agency_call_attempts SET outcome = 'orphaned', state = 'ended', ended_at = COALESCE(ended_at, dialed_at + interval '2 hours')
        WHERE campaign_id = $1 AND state <> 'ended'`, [c1.id]);
    // A recording arrives after the call.
    await pool().query(
      `UPDATE agency_calls SET recording_url = 'https://recording.example/late.mp3'
        WHERE recording_url IS NULL AND id IN (SELECT webrtc_call_id FROM agency_call_attempts WHERE campaign_id = $1 AND outcome = 'connected')`, [c0.id]);
    // A carrier error code lands on a failed call's row after the attempt settled (0014's trigger).
    await pool().query(
      `UPDATE agency_calls SET error_code = 'LATE_CARRIER_CODE'
        WHERE error_code IS NULL AND id IN (SELECT webrtc_call_id FROM agency_call_attempts WHERE campaign_id = $1 AND outcome = 'failed')`, [c0.id]);
    // dialed_at moves bucket (20 minutes later, across a boundary).
    await pool().query(
      `UPDATE agency_call_attempts SET dialed_at = dialed_at + interval '20 minutes'
        WHERE id IN (SELECT id FROM agency_call_attempts WHERE campaign_id = $1 AND redial_number = 0 ORDER BY id LIMIT 60)`, [c1.id]);
    // A contact's zone, and a campaign's.
    await pool().query(`UPDATE agency_contacts SET timezone = 'Asia/Kathmandu' WHERE id = ANY($1::uuid[])`, [c0.contactIds.slice(0, 30)]);
    await pool().query(`UPDATE agency_campaigns SET default_timezone = 'Asia/Kolkata' WHERE id = $1`, [c0.id]);
    c0.zone = 'Asia/Kolkata';
    // A deleted attempt (one no redial points at).
    await pool().query(
      `DELETE FROM agency_call_attempts WHERE id = (SELECT a.id FROM agency_call_attempts a WHERE a.campaign_id = $1
          AND NOT EXISTS (SELECT 1 FROM agency_call_attempts r WHERE r.redial_of_attempt_id = a.id) ORDER BY a.id LIMIT 1)`, [c1.id]);

    // Stale before the job: the rollup still says what it said.
    const before = (await repo.activity({ ...{ campaignId: c0.id, tenantId: DEFAULTS.tenantId }, from: ranges(c0.id)[0]!.from, to: ranges(c0.id)[0]!.to, successCodes: SUCCESS_CODES, overrideCodes: OVERRIDE_CODES }))!;
    const truth = await oracleTotals(pool(), ranges(c0.id)[0]!, OVERRIDE_CODES);
    expect(before.calls.successes).toBeLessThan(truth.calls.successes);
    expect((await repo.asOf({ campaignId: c0.id, tenantId: DEFAULTS.tenantId }))!.pending_buckets).toBeGreaterThan(0);

    await drain();
    await assertMatchesOracle();
  });

  it('a campaign outside the tenant reads as nothing', async () => {
    const other = { campaignId: campaigns[0]!.id, tenantId: '00000000-0000-0000-0000-00000000dead', from: WORLD_BASE, to: new Date(WORLD_BASE.getTime() + 48 * HOUR) };
    expect(await repo.activity({ ...other, successCodes: [], overrideCodes: [] })).toBeNull();
    expect(await repo.trends({ ...other, bucket: 'hour', timezone: 'UTC', successCodes: [] })).toBeNull();
    expect(await repo.callerIds(other)).toBeNull();
    expect(await repo.recording(other)).toBeNull();
    expect(await repo.carrierFailures(other)).toBeNull();
    expect(await repo.asOf(other)).toBeNull();
  });

  it('hour and day buckets across a DST change keep every count (America/New_York, 2026-11-01)', async () => {
    const c = campaigns[3]!;
    // Move this campaign's history onto the fall-back weekend.
    await pool().query(`UPDATE agency_call_attempts SET dialed_at = dialed_at + interval '30 days' WHERE campaign_id = $1`, [c.id]);
    await drain();
    const r = { campaignId: c.id, from: new Date('2026-10-30T00:00:00Z'), to: new Date('2026-11-04T00:00:00Z') };
    const total = (await oracleTotals(pool(), r, [])).calls.dials;
    expect(total).toBeGreaterThan(500);
    for (const bucket of ['quarter_hour', 'hour', 'day'] as const) {
      const trends = (await repo.trends({ ...r, tenantId: DEFAULTS.tenantId, bucket, timezone: 'America/New_York', successCodes: SUCCESS_CODES }))!;
      const labels = trends.buckets.map((b) => b.bucket_start);
      expect(new Set(labels).size, bucket).toBe(labels.length);
      expect(trends.buckets.reduce((s, b) => s + b.dials, 0), bucket).toBe(total);
      expect(Object.fromEntries(trends.buckets.filter((b) => b.dials > 0).map(({ bucket_start: l, ...rest }) => [l, rest])), bucket)
        .toEqual(await oracleTrend(pool(), r, bucket, 'America/New_York'));
    }
    const days = (await repo.trends({ ...r, tenantId: DEFAULTS.tenantId, bucket: 'day', timezone: 'America/New_York', successCodes: [] }))!;
    expect(days.buckets.map((b) => b.bucket_start)).toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });
});
