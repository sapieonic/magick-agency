// Real Postgres: migrations/0014_insights_rollup_first_dials_carrier_errors.sql. globalSetup has
// applied every migration. Pins the connect rate's columns (human_connects on the headers, agents
// and facets; first_dials on the facets), the carrier_error facet in the CHECK, that a carrier
// error code arriving on a call row marks its attempt's bucket (and that other call writes mark
// nothing), the backfill re-marking every rolled-up bucket, and down then up. The recompute that
// fills them is the server's (insights-rollup-oracle.test.ts).
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

async function marks(): Promise<string[]> {
  const { rows } = await pool().query<{ campaign_id: string; bucket_start: Date }>(
    'SELECT campaign_id, bucket_start FROM agency_insights_rollup_dirty ORDER BY id');
  return rows.map((r) => `${r.campaign_id}|${r.bucket_start.toISOString()}`).sort();
}
const clearMarks = () => pool().query('DELETE FROM agency_insights_rollup_dirty');
const key = (campaignId: string, iso: string) => `${campaignId}|${new Date(iso).toISOString()}`;

async function facetCheck(): Promise<string> {
  const { rows } = await pool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_agency_insights_rollup_facet'`);
  return rows[0]!.def;
}

async function header(campaignId: string, bucket: string): Promise<void> {
  await pool().query(`INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start) VALUES ($1, $2)`, [campaignId, bucket]);
}

describe('0014 — insights rollup first dials and carrier errors', () => {
  it('the connect rate\'s counts (NOT NULL DEFAULT 0): human_connects on headers, agents and facets, first_dials on facets; the carrier_error facet', async () => {
    const { rows } = await pool().query<{ table_name: string; column_name: string; data_type: string; is_nullable: string; column_default: string }>(
      `SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name LIKE 'agency_insights_rollup_%' AND column_name IN ('first_dials', 'human_connects')
        ORDER BY table_name, column_name`);
    expect(rows).toEqual([
      { table_name: 'agency_insights_rollup_agents', column_name: 'human_connects', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      { table_name: 'agency_insights_rollup_buckets', column_name: 'human_connects', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      { table_name: 'agency_insights_rollup_facets', column_name: 'first_dials', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
      { table_name: 'agency_insights_rollup_facets', column_name: 'human_connects', data_type: 'bigint', is_nullable: 'NO', column_default: '0' },
    ]);
    expect(await facetCheck()).toContain("'carrier_error'");

    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    await header(c, '2026-11-04T05:00:00Z');
    await pool().query(
      `INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet, key, n) VALUES ($1, '2026-11-04T05:00:00Z', 'carrier_error', 'TELEPHONY_ERROR', 2)`, [c]);
    await expect(pool().query(
      `INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet, key, n) VALUES ($1, '2026-11-04T05:00:00Z', 'nope', 'x', 1)`, [c],
    )).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_insights_rollup_facet' });
  });

  it('a carrier error code arriving on a call marks its attempt\'s bucket; other call writes mark nothing', async () => {
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    const contact = await insertContact(c);
    const call = await insertCall({ campaign_id: c });
    await insertAttempt(c, contact['id'] as string, {
      state: 'ended', outcome: 'failed', dialed_at: new Date('2026-11-04T07:44:00Z'), webrtc_call_id: call['id'],
    });
    await clearMarks();
    await pool().query(`UPDATE agency_calls SET status = 'failed' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([]);
    await pool().query(`UPDATE agency_calls SET error_code = 'TELEPHONY_ERROR' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([key(c, '2026-11-04T07:30:00Z')]);
    await clearMarks();
    // The same code again: unchanged, no mark.
    await pool().query(`UPDATE agency_calls SET error_code = 'TELEPHONY_ERROR' WHERE id = $1`, [call['id']]);
    expect(await marks()).toEqual([]);
    // A call row inserted with a code (its attempt already placed) marks too; one without, nothing.
    const late = await insertContact(c, { phone_e164: '+14155550199' });
    const lateCallId = '5b0c1d9e-0000-4000-8000-00000000c001';
    await insertAttempt(c, late['id'] as string, { state: 'ended', outcome: 'failed', dialed_at: new Date('2026-11-04T09:02:00Z'), webrtc_call_id: lateCallId });
    await clearMarks();
    await insertCall({ id: lateCallId, campaign_id: c, error_code: 'TELEPHONY_INIT_FAILED' });
    expect(await marks()).toEqual([key(c, '2026-11-04T09:00:00Z')]);
    await clearMarks();
    await insertCall({ campaign_id: c });
    expect(await marks()).toEqual([]);
  });

  it('down restores 0012\'s facets (carrier rows dropped); up re-applies and re-marks every rolled-up bucket', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const campaign = await insertCampaign();
    const c = campaign['id'] as string;
    await header(c, '2026-11-04T05:00:00Z');
    await header(c, '2026-11-03T05:00:00Z');
    await pool().query(
      `INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet, key, n, first_dials)
       VALUES ($1, '2026-11-04T05:00:00Z', 'carrier_error', 'TELEPHONY_ERROR', 2, 0),
              ($1, '2026-11-04T05:00:00Z', 'caller_id', '+919000000001', 3, 2)`, [c]);

    await migrate('down', files.length - files.indexOf('0014_insights_rollup_first_dials_carrier_errors.sql'));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0013_insights_pacing_history');
      expect(await facetCheck()).not.toContain('carrier_error');
      const facets = await pool().query<{ facet: string }>('SELECT facet FROM agency_insights_rollup_facets');
      expect(facets.rows.map((r) => r.facet)).toEqual(['caller_id']);
      const col = await pool().query(`SELECT 1 FROM information_schema.columns
        WHERE table_name LIKE 'agency_insights_rollup_%' AND column_name IN ('first_dials', 'human_connects')`);
      expect(col.rowCount).toBe(0);
      const triggers = await pool().query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_agency_calls_insights_error%'`);
      expect(triggers.rowCount).toBe(0);
      await clearMarks();
    } finally {
      await migrate('up');
    }
    // The backfill: one mark per rolled-up bucket, so the job rebuilds each with the new facet.
    expect(await marks()).toEqual([key(c, '2026-11-03T05:00:00Z'), key(c, '2026-11-04T05:00:00Z')]);
    expect(await facetCheck()).toContain("'carrier_error'");
  });
});
