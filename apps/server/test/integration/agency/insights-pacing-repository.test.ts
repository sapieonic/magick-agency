import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { createContentionPool, insertAgencyCampaign } from './agency-factories.js';

/**
 * The pacing history (IN2) on real Postgres: the additive upsert the pacing leader's batch and
 * the single-row writers share (exact sums under concurrent writers, duplicate keys in one batch,
 * a deleted campaign dropped rather than failing the batch), and `pacingHistory`'s stall rule
 * (the header of `insights-pacing.repository.ts`), totals and plan.
 */

let pool = getTestPool();
vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => pool,
}));

const { agencyInsightsPacingRepository: repo, PACING_HISTORY_FIELDS } =
  await import('../../../src/db/repositories/agency.repository.js');

type Field = (typeof PACING_HISTORY_FIELDS)[number];
const MIN = 60_000;
/** Tue 2026-11-03 10:00 UTC. */
const T0 = Date.parse('2026-11-03T10:00:00Z');
const at = (minute: number) => T0 + minute * MIN;

function counts(c: Partial<Record<Field, number>>): number[] {
  return PACING_HISTORY_FIELDS.map((f) => c[f] ?? 0);
}

async function minute(campaign: { id: string; tenant_id: string }, m: number, c: Partial<Record<Field, number>>) {
  await repo.upsertMinutes([{ campaignId: campaign.id, tenantId: campaign.tenant_id, minuteStart: at(m), counts: counts(c) }]);
}

async function rowsOf(campaignId: string) {
  const { rows } = await getTestPool().query<Record<string, number> & { minute_start: Date }>(
    'SELECT * FROM agency_campaign_pacing_minutes WHERE campaign_id = $1 ORDER BY minute_start', [campaignId]);
  return rows;
}

beforeEach(truncateAll);
afterAll(closeTestPool);

describe('the additive upsert', () => {
  it('adds, merges duplicate keys in one batch, and keeps campaigns apart', async () => {
    const a = await insertAgencyCampaign({ status: 'paused' });
    const b = await insertAgencyCampaign({ status: 'paused' });
    await repo.upsertMinutes([
      { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 3, idle_no_agents: 2 }) },
      { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 1, dials_placed: 1 }) },
      { campaignId: b.id, tenantId: b.tenant_id, minuteStart: at(0), counts: counts({ ticks: 5 }) },
      { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(1), counts: counts({ ticks: 2 }) },
    ]);
    await repo.upsertMinutes([
      { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 10, idle_no_agents: 1 }) },
    ]);
    const rows = await rowsOf(a.id);
    expect(rows.map((r) => [r.minute_start.getTime(), r['ticks'], r['idle_no_agents'], r['dials_placed']])).toEqual([
      [at(0), 14, 3, 1],
      [at(1), 2, 0, 0],
    ]);
    expect((await rowsOf(b.id)).map((r) => r['ticks'])).toEqual([5]);
  });

  it('drops a row whose campaign is gone and writes the rest of the batch', async () => {
    const a = await insertAgencyCampaign({ status: 'paused' });
    const written = await repo.upsertMinutes([
      { campaignId: '00000000-0000-4000-8000-00000000dead', tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 1 }) },
      { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 1 }) },
    ]);
    expect(written).toBe(1);
    expect((await rowsOf(a.id)).map((r) => r['ticks'])).toEqual([1]);
    // The single-row form too: nothing written, nothing thrown.
    await repo.addToMinute({ campaignId: '00000000-0000-4000-8000-00000000dead', tenantId: a.tenant_id, field: 'our_fault_retired' });
  });

  it('sums exactly under concurrent batches and single-row writes on the same minutes (no lost update, no deadlock)', async () => {
    const a = await insertAgencyCampaign({ status: 'paused' });
    const b = await insertAgencyCampaign({ status: 'paused' });
    const contention = createContentionPool(16);
    pool = contention;
    try {
      const writers: Promise<unknown>[] = [];
      for (let i = 0; i < 24; i++) {
        // Batches touching both campaigns and two minutes, listed in opposite orders so an
        // unsorted write would lock in opposite orders.
        const rows = [
          { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(0), counts: counts({ ticks: 1 }) },
          { campaignId: b.id, tenantId: b.tenant_id, minuteStart: at(1), counts: counts({ ticks: 1 }) },
          { campaignId: a.id, tenantId: a.tenant_id, minuteStart: at(1), counts: counts({ ticks: 1 }) },
          { campaignId: b.id, tenantId: b.tenant_id, minuteStart: at(0), counts: counts({ ticks: 1 }) },
        ];
        writers.push(repo.upsertMinutes(i % 2 ? rows : [...rows].reverse()));
        writers.push(repo.addToMinute({
          campaignId: a.id, tenantId: a.tenant_id, field: 'redials_refused_at_limit', at: new Date(at(0) + 30_000),
        }));
      }
      await Promise.all(writers);
    } finally {
      pool = getTestPool();
      await contention.end();
    }
    const rowsA = await rowsOf(a.id);
    expect(rowsA.map((r) => [r['ticks'], r['redials_refused_at_limit']])).toEqual([[24, 24], [24, 0]]);
    expect((await rowsOf(b.id)).map((r) => r['ticks'])).toEqual([24, 24]);
  });
});

describe('pacingHistory: the stall rule', () => {
  const range = (fromMinute: number, toMinute: number) => ({ from: new Date(at(fromMinute)), to: new Date(at(toMinute)) });
  /** A "now" long after the fixtures, so nothing reads as ongoing unless a test says so. */
  const later = { now: new Date(at(10_000)) };

  it('a minute is stalled when half its ticks idled; its reason is the dominant one; consecutive same-reason minutes are one episode', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    await minute(c, 0, { ticks: 240, idle_no_agents: 240 });
    await minute(c, 1, { ticks: 240, idle_no_agents: 120 }); // exactly half: stalled
    await minute(c, 2, { ticks: 240, idle_no_agents: 119 }); // under half: dialling
    await minute(c, 3, { ticks: 240, idle_no_agents: 60, idle_no_slots: 100 }); // mixed, no_slots dominant
    await minute(c, 4, { ticks: 240, idle_no_slots: 200 });
    await minute(c, 5, { ticks: 0, redials_refused_at_limit: 1 }); // no ticks: never stalled
    await minute(c, 6, { ticks: 240, idle_no_contacts: 120, idle_no_slots: 120 }); // tie: list order (no_slots first)

    const h = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), later);
    expect(h.minutes_by_reason).toEqual({
      no_agents: 2, no_slots: 3, no_contacts: 0, no_reservations: 0, no_caller_ids: 0, nothing_due: 0, outside_calling_hours: 0,
    });
    expect(h.episodes).toEqual([
      { reason: 'no_agents', started_at: new Date(at(0)).toISOString(), ended_at: new Date(at(2)).toISOString(), minutes: 2 },
      { reason: 'no_slots', started_at: new Date(at(3)).toISOString(), ended_at: new Date(at(5)).toISOString(), minutes: 2 },
      // Minute 5 (no ticks) breaks the run, so minute 6 is an episode of its own.
      { reason: 'no_slots', started_at: new Date(at(6)).toISOString(), ended_at: new Date(at(7)).toISOString(), minutes: 1 },
    ]);
    expect(h.episodes_truncated).toBe(false);
    // Any minute with a no_slots tick, stalled or not.
    expect(h.concurrency_limit_minutes).toBe(3);
    expect(h.redials_refused_at_limit).toBe(1);
    expect(h.ticks).toBe(240 * 6);
  });

  it('a missing minute (no row) breaks an episode', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    await minute(c, 0, { ticks: 4, idle_no_contacts: 4 });
    await minute(c, 2, { ticks: 4, idle_no_contacts: 4 });
    const h = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), later);
    expect(h.episodes.map((e) => [e.started_at, e.minutes])).toEqual([
      [new Date(at(0)).toISOString(), 1],
      [new Date(at(2)).toISOString(), 1],
    ]);
  });

  it('outside calling hours wins over the idle reason it causes, but only on a stalled minute', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    await minute(c, 0, { ticks: 240, outside_hours_ticks: 240, idle_no_contacts: 240 });
    await minute(c, 1, { ticks: 240, outside_hours_ticks: 120, idle_nothing_due: 200 });
    await minute(c, 2, { ticks: 240, outside_hours_ticks: 100, idle_no_contacts: 200 }); // window mostly open
    await minute(c, 3, { ticks: 240, outside_hours_ticks: 240, dials_placed: 12 }); // dialling anyway (other zones)
    const h = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), later);
    expect(h.minutes_by_reason.outside_calling_hours).toBe(2);
    expect(h.minutes_by_reason.no_contacts).toBe(1);
    expect(h.episodes.map((e) => [e.reason, e.minutes])).toEqual([['outside_calling_hours', 2], ['no_contacts', 1]]);
    expect(h.dials_placed).toBe(12);
  });

  it('cuts episodes at the range edges and reads only minutes starting in range', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    for (let m = 0; m < 10; m++) await minute(c, m, { ticks: 4, idle_no_agents: 4, calling_hours_deferrals: 1 });
    // from = minute 2 + 30 s: minute 2 starts before `from` but is the minute `from` falls in.
    const from = new Date(at(2) + 30_000);
    const to = new Date(at(7) + 30_000);
    const h = await repo.pacingHistory(c.id, c.tenant_id, { from, to }, later);
    expect(h.episodes).toEqual([
      { reason: 'no_agents', started_at: from.toISOString(), ended_at: to.toISOString(), minutes: 6 },
    ]);
    expect(h.outside_calling_hours_deferrals).toBe(6);
    expect(h.history_since).toBe(new Date(at(0)).toISOString());
  });

  it('an episode still going has no end: its last minute is the newest, and now or the minute before', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    await minute(c, 0, { ticks: 4, idle_no_agents: 4 });
    await minute(c, 1, { ticks: 4, idle_no_agents: 4 });
    const ongoing = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), { now: new Date(at(2) + 10_000) });
    expect(ongoing.episodes).toEqual([
      { reason: 'no_agents', started_at: new Date(at(0)).toISOString(), ended_at: null, minutes: 2 },
    ]);
    // Two minutes on with nothing written: it ended.
    const stale = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), { now: new Date(at(3) + 10_000) });
    expect(stale.episodes[0]!.ended_at).toBe(new Date(at(2)).toISOString());
    // A range that ends before now is history: ended at the range's end.
    const past = await repo.pacingHistory(c.id, c.tenant_id, { from: new Date(at(0)), to: new Date(at(2)) }, { now: new Date(at(2) + 10_000) });
    expect(past.episodes[0]!.ended_at).toBe(new Date(at(2)).toISOString());
    // A newer minute that is not stalled ends it.
    await minute(c, 2, { ticks: 4, dials_placed: 4 });
    const ended = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), { now: new Date(at(2) + 20_000) });
    expect(ended.episodes[0]!.ended_at).toBe(new Date(at(2)).toISOString());
  });

  it('keeps the newest episodes when there are more than the cap, oldest first, and says so', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    for (let m = 0; m < 10; m += 2) await minute(c, m, { ticks: 4, idle_no_agents: 4 });
    const h = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), { ...later, maxEpisodes: 3 });
    expect(h.episodes.map((e) => e.started_at)).toEqual([at(4), at(6), at(8)].map((t) => new Date(t).toISOString()));
    expect(h.episodes_truncated).toBe(true);
    expect(h.minutes_by_reason.no_agents).toBe(5);
  });

  it('nothing recorded: zeros, no episodes, history_since null; another tenant reads nothing', async () => {
    const c = await insertAgencyCampaign({ status: 'paused' });
    const empty = await repo.pacingHistory(c.id, c.tenant_id, range(0, 60), later);
    expect(empty.history_since).toBeNull();
    expect(empty.episodes).toEqual([]);
    expect(empty.ticks).toBe(0);
    expect(Object.values(empty.minutes_by_reason).every((n) => n === 0)).toBe(true);
    await minute(c, 0, { ticks: 4, idle_no_agents: 4 });
    const other = await repo.pacingHistory(c.id, '00000000-0000-4000-8000-0000000000ff', range(0, 60), later);
    expect(other.ticks).toBe(0);
    expect(other.history_since).toBeNull();
  });
});

describe('pacingHistory: the plan', () => {
  it('reads one campaign\'s range through the primary key on a seeded table (92 days x 3 campaigns)', async () => {
    const target = await insertAgencyCampaign({ status: 'paused' });
    const others = [await insertAgencyCampaign({ status: 'paused' }), await insertAgencyCampaign({ status: 'paused' })];
    for (const c of [target, ...others]) {
      await getTestPool().query(
        `INSERT INTO agency_campaign_pacing_minutes (campaign_id, minute_start, tenant_id, ticks, idle_no_agents, idle_no_slots)
         SELECT $1::uuid, g, $2::uuid, 240, CASE WHEN extract(hour FROM g) < 9 THEN 240 ELSE 0 END, (extract(minute FROM g)::int % 7)
           FROM generate_series($3::timestamptz, $3::timestamptz + interval '92 days' - interval '1 minute', interval '1 minute') g`,
        [c.id, c.tenant_id, new Date(at(0))]);
    }
    const started = Date.now();
    const h = await repo.pacingHistory(target.id, target.tenant_id,
      { from: new Date(at(0)), to: new Date(at(0) + 92 * 24 * 60 * MIN) }, later());
    const elapsedMs = Date.now() - started;
    expect(h.ticks).toBe(240 * 92 * 24 * 60);
    expect(h.minutes_by_reason.no_agents).toBe(92 * 9 * 60);
    // One episode per night (00:00–09:00 UTC): the range starts at 10:00 on day 1 and ends at 10:00 on day 93.
    expect(h.episodes.length).toBe(92);
    expect(elapsedMs, 'a 92-day health read of one campaign').toBeLessThan(5_000);

    const client: PoolClient = await getTestPool().connect();
    try {
      // The range CTE, as the statement runs it (sequential scans priced out: what remains is
      // whether the primary key serves the read without a sort).
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_bitmapscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT * FROM agency_campaign_pacing_minutes m
          WHERE m.campaign_id = $1::uuid AND m.tenant_id = $2::uuid
            AND m.minute_start >= $3::timestamptz AND m.minute_start < $4::timestamptz`,
        [target.id, target.tenant_id, new Date(at(0)), new Date(at(60))]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index Scan using agency_campaign_pacing_minutes_pkey/);
      expect(plan).toMatch(/Index Cond: \(\(campaign_id = .*minute_start >= .*minute_start < /s);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  function later() {
    return { now: new Date(at(0) + 200 * 24 * 60 * MIN) };
  }
});
