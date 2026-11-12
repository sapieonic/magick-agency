// Real Postgres: migrations/0012_insights_rollup.sql. globalSetup has applied every migration.
// Pins the bucket function, the rollup and dirty-mark tables, and that every write which can
// change what a bucket holds marks exactly the buckets it touched (and that writes which cannot
// mark nothing), the backfill, and down then up. The recompute and the reads are the server's
// (apps/server/test/integration/agency/insights-rollup-*.test.ts).
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAttempt, insertCall, insertCampaign, insertContact } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

/** The marks, as `campaign|bucket ISO`, sorted (duplicates kept). */
async function marks(): Promise<string[]> {
  const { rows } = await pool().query<{ campaign_id: string; bucket_start: Date }>(
    'SELECT campaign_id, bucket_start FROM agency_insights_rollup_dirty ORDER BY id');
  return rows.map((r) => `${r.campaign_id}|${r.bucket_start.toISOString()}`).sort();
}
const clearMarks = () => pool().query('DELETE FROM agency_insights_rollup_dirty');
const key = (campaignId: string, iso: string) => `${campaignId}|${new Date(iso).toISOString()}`;

describe('0012 — insights rollup', () => {
  it('agency_insights_bucket bins on 15-minute UTC boundaries, immutable', async () => {
    const { rows } = await pool().query<{ a: Date; b: Date; c: Date; d: Date; v: string }>(
      `SELECT agency_insights_bucket('2026-11-04T10:52:13+05:45') AS a,
              agency_insights_bucket('2026-11-04T05:15:00Z') AS b,
              agency_insights_bucket('2026-11-04T05:14:59.999999Z') AS c,
              agency_insights_bucket('1999-12-31T23:59:00Z') AS d,
              (SELECT provolatile::text FROM pg_proc WHERE proname = 'agency_insights_bucket') AS v`);
    expect(rows[0]!.a.toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(rows[0]!.b.toISOString()).toBe('2026-11-04T05:15:00.000Z');
    expect(rows[0]!.c.toISOString()).toBe('2026-11-04T05:00:00.000Z');
    expect(rows[0]!.d.toISOString()).toBe('1999-12-31T23:45:00.000Z');
    expect(rows[0]!.v).toBe('i');
  });

  it('creates the rollup tables with their keys, and refuses an unaligned bucket', async () => {
    const { rows } = await pool().query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'agency_insights_rollup%' ORDER BY indexname`);
    expect(Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef.replace(/^.* USING btree /, '')]))).toEqual({
      agency_insights_rollup_buckets_pkey: '(campaign_id, bucket_start)',
      agency_insights_rollup_dirty_pkey: '(id)',
      idx_agency_insights_rollup_dirty_bucket: '(campaign_id, bucket_start)',
      uq_agency_insights_rollup_agents: '(campaign_id, bucket_start, agent_user_id) NULLS NOT DISTINCT',
      uq_agency_insights_rollup_codes: '(campaign_id, bucket_start, agent_user_id, disposition_code) NULLS NOT DISTINCT',
      uq_agency_insights_rollup_facets: '(campaign_id, facet, bucket_start, key, agent_user_id) NULLS NOT DISTINCT',
    });
    const campaign = await insertCampaign();
    await expect(pool().query(
      `INSERT INTO agency_insights_rollup_dirty (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:07:00Z')`, [campaign['id']],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(pool().query(
      `INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:07:00Z')`, [campaign['id']],
    )).rejects.toMatchObject({ code: '23514' });
    await pool().query(`INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:00:00Z')`, [campaign['id']]);
    await expect(pool().query(
      `INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet) VALUES ($1, '2026-11-04T05:00:00Z', 'nope')`, [campaign['id']],
    )).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_insights_rollup_facet' });
    // A breakdown row needs its header.
    await expect(pool().query(
      `INSERT INTO agency_insights_rollup_agents (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:15:00Z')`, [campaign['id']],
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('an attempt marks its bucket when placed, and never while it has no dialed_at', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign['id'] as string);
    const queued = await insertAttempt(campaign['id'] as string, contact['id'] as string, { state: 'queued' });
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_call_attempts SET state = 'ringing' WHERE id = $1`, [queued['id']]);
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_call_attempts SET state = 'dialing', dialed_at = '2026-11-04T05:29:59Z' WHERE id = $1`, [queued['id']]);
    expect(await marks()).toEqual([key(campaign['id'] as string, '2026-11-04T05:15:00Z')]);
    await clearMarks();
    // Any later write marks the same bucket again (a late disposition, an outcome rewrite).
    await pool().query(`UPDATE agency_call_attempts SET disposition_code = 'sale' WHERE id = $1`, [queued['id']]);
    expect(await marks()).toEqual([key(campaign['id'] as string, '2026-11-04T05:15:00Z')]);
    await clearMarks();
    // Inserted placed: its bucket.
    await insertAttempt(campaign['id'] as string, contact['id'] as string, { attempt_number: 2, state: 'ended', dialed_at: new Date('2026-11-04T06:00:00Z') });
    expect(await marks()).toEqual([key(campaign['id'] as string, '2026-11-04T06:00:00Z')]);
  });

  it('moving dialed_at marks the OLD and the NEW bucket; a statement marks each bucket once', async () => {
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const contact = await insertContact(c, { phone_e164: `+1415555020${i}` });
      ids.push((await insertAttempt(c, contact['id'] as string, { state: 'ended', dialed_at: new Date(`2026-11-04T05:0${i}:00Z`) }))['id'] as string);
    }
    await clearMarks();
    await pool().query(`UPDATE agency_call_attempts SET dialed_at = dialed_at + interval '20 minutes' WHERE id = $1`, [ids[0]]);
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z'), key(c, '2026-11-04T05:15:00Z')]);
    await clearMarks();
    // Six rows in one bucket, one statement: one mark.
    await pool().query(`UPDATE agency_call_attempts SET outcome = 'orphaned' WHERE campaign_id = $1 AND dialed_at < '2026-11-04T05:15:00Z'`, [c]);
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z')]);
    await clearMarks();
    await pool().query('DELETE FROM agency_call_attempts WHERE id = $1', [ids[1]]);
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z')]);
  });

  it('a recording arriving marks its attempt\'s bucket; other call writes mark nothing', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign['id'] as string);
    const call = await insertCall({ campaign_id: campaign['id'] });
    await insertAttempt(campaign['id'] as string, contact['id'] as string, {
      state: 'ended', dialed_at: new Date('2026-11-04T07:44:00Z'), webrtc_call_id: call['id'],
    });
    await clearMarks();
    await pool().query(`UPDATE agency_calls SET status = 'completed' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_calls SET recording_url = 'https://r.example/1.mp3' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([key(campaign['id'] as string, '2026-11-04T07:30:00Z')]);
    await clearMarks();
    await pool().query(`UPDATE agency_calls SET recording_url = 'https://r.example/1.mp3' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([]);
  });

  it('a contact\'s zone marks its attempts\' buckets; a campaign\'s zone marks its rolled-up buckets', async () => {
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    const contact = await insertContact(c);
    await insertAttempt(c, contact['id'] as string, { attempt_number: 1, state: 'ended', dialed_at: new Date('2026-11-04T05:01:00Z') });
    await insertAttempt(c, contact['id'] as string, { attempt_number: 2, state: 'ended', dialed_at: new Date('2026-11-04T09:01:00Z') });
    await insertAttempt(c, contact['id'] as string, { attempt_number: 3, state: 'queued' });
    await clearMarks();
    await pool().query(`UPDATE agency_contacts SET context = '{"a":1}' WHERE id = $1`, [contact['id']]);
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_contacts SET timezone = 'Asia/Kolkata' WHERE id = $1`, [contact['id']]);
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z'), key(c, '2026-11-04T09:00:00Z')]);
    await clearMarks();

    await pool().query(
      `INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start)
       VALUES ($1, '2026-11-04T05:00:00Z'), ($1, '2026-11-03T05:00:00Z')`, [c]);
    await pool().query(`UPDATE agency_campaigns SET name = 'renamed' WHERE id = $1`, [c]);
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_campaigns SET default_timezone = 'Asia/Kathmandu' WHERE id = $1`, [c]);
    expect(await marks()).toEqual([key(c, '2026-11-03T05:00:00Z'), key(c, '2026-11-04T05:00:00Z')]);
  });

  it('deleting a campaign cascades its rollup and leaves marks the job will drop', async () => {
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    const contact = await insertContact(c);
    await insertAttempt(c, contact['id'] as string, { state: 'ended', dialed_at: new Date('2026-11-04T05:01:00Z') });
    await pool().query(`INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:00:00Z')`, [c]);
    await pool().query(`INSERT INTO agency_insights_rollup_agents (campaign_id, bucket_start) VALUES ($1, '2026-11-04T05:00:00Z')`, [c]);
    await clearMarks();
    await pool().query('DELETE FROM agency_campaigns WHERE id = $1', [c]);
    const left = await pool().query(
      `SELECT (SELECT count(*) FROM agency_insights_rollup_buckets)::int AS b, (SELECT count(*) FROM agency_insights_rollup_agents)::int AS a`);
    expect(left.rows[0]).toEqual({ b: 0, a: 0 });
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z')]);
  });

  it('down drops everything; up re-applies and backfills a mark per bucket with a placed attempt', async () => {
    // Down through 0012, whatever migrations came after it (each later one's down first).
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf('0012_insights_rollup.sql'));
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    const a = await insertContact(c);
    const b = await insertContact(c, { phone_e164: '+14155550102' });
    try {
      await insertAttempt(c, a['id'] as string, { attempt_number: 1, state: 'ended', dialed_at: new Date('2026-11-04T05:01:00Z') });
      await insertAttempt(c, a['id'] as string, { attempt_number: 2, state: 'ended', dialed_at: new Date('2026-11-04T05:14:00Z') });
      await insertAttempt(c, a['id'] as string, { attempt_number: 3, state: 'queued' });
      await insertAttempt(c, b['id'] as string, { attempt_number: 1, state: 'ended', dialed_at: new Date('2026-11-04T06:20:00Z') });

      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0011_insights_foundation');
      const left = await pool().query(
        `SELECT 'tbl' AS k, tablename AS n FROM pg_tables WHERE tablename LIKE 'agency_insights%'
         UNION ALL SELECT 'trg', tgname FROM pg_trigger WHERE tgname LIKE '%insights%'
         UNION ALL SELECT 'fn', proname FROM pg_proc WHERE proname LIKE 'agency_insights%'`);
      expect(left.rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect(await marks()).toEqual([key(c, '2026-11-04T05:00:00Z'), key(c, '2026-11-04T06:15:00Z')]);
  });
});
