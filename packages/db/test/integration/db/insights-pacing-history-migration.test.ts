// Real Postgres: migrations/0013_insights_pacing_history.sql. globalSetup has applied every
// migration. Pins the pacing-minutes table (key, columns, the two CHECKs, the cascade, the
// additive upsert the writers rely on, the plans of its two reads) and the reopen marker on
// agency_contacts, then down and up again.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { TENANT, insertCampaign, insertContact } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const COUNTERS = [
  'ticks', 'outside_hours_ticks',
  'idle_no_agents', 'idle_no_slots', 'idle_no_contacts', 'idle_no_reservations', 'idle_no_caller_ids', 'idle_nothing_due',
  'calling_hours_deferrals', 'dnc_unavailable_halts', 'dials_placed',
  'predial_dnc_suppressed', 'predial_invalid_suppressed', 'our_fault_retired', 'redials_refused_at_limit',
];

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

async function columns(table: string) {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table]);
  return rows;
}

async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const UPSERT = `INSERT INTO agency_campaign_pacing_minutes (campaign_id, minute_start, tenant_id, ticks, idle_no_agents)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (campaign_id, minute_start) DO UPDATE
    SET ticks = agency_campaign_pacing_minutes.ticks + EXCLUDED.ticks,
        idle_no_agents = agency_campaign_pacing_minutes.idle_no_agents + EXCLUDED.idle_no_agents`;

describe('0013 — pacing history', () => {
  it('agency_campaign_pacing_minutes: the key, tenant, and every counter NOT NULL DEFAULT 0', async () => {
    const cols = await columns('agency_campaign_pacing_minutes');
    expect(cols.map((c) => c.column_name)).toEqual(['campaign_id', 'minute_start', 'tenant_id', ...COUNTERS]);
    for (const c of cols.slice(3)) {
      expect(c, c.column_name).toMatchObject({ data_type: 'integer', is_nullable: 'NO', column_default: '0' });
    }
    expect(cols.slice(0, 3).map((c) => [c.data_type, c.is_nullable])).toEqual([
      ['uuid', 'NO'], ['timestamp with time zone', 'NO'], ['uuid', 'NO'],
    ]);
    const { rows } = await pool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'agency_campaign_pacing_minutes_pkey'`);
    expect(rows[0]!.def).toBe('PRIMARY KEY (campaign_id, minute_start)');
  });

  it('accepts only whole UTC minutes, and never a negative counter', async () => {
    const campaign = await insertCampaign();
    await expect(pool().query(UPSERT, [campaign.id, '2026-11-04T10:15:30Z', TENANT, 1, 0]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_pacing_minute_whole' });
    await expect(pool().query(UPSERT, [campaign.id, '2026-11-04T10:15:00Z', TENANT, -1, 0]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_pacing_minute_counts' });
    // A whole minute in a zone off the hour (UTC+05:45) is still a whole UTC minute.
    await pool().query(UPSERT, [campaign.id, '2026-11-04T16:00:00+05:45', TENANT, 1, 0]);
  });

  it('the additive upsert adds, one row per minute, and a campaign delete cascades', async () => {
    const campaign = await insertCampaign();
    const minute = '2026-11-04T10:15:00Z';
    await pool().query(UPSERT, [campaign.id, minute, TENANT, 4, 1]);
    await pool().query(UPSERT, [campaign.id, minute, TENANT, 3, 2]);
    const { rows } = await pool().query<{ ticks: number; idle_no_agents: number }>(
      'SELECT ticks, idle_no_agents FROM agency_campaign_pacing_minutes WHERE campaign_id = $1', [campaign.id]);
    expect(rows).toEqual([{ ticks: 7, idle_no_agents: 3 }]);
    await pool().query('DELETE FROM agency_campaigns WHERE id = $1', [campaign.id]);
    const { rows: left } = await pool().query('SELECT 1 FROM agency_campaign_pacing_minutes');
    expect(left).toEqual([]);
  });

  it('both reads (a range of one campaign, and its first minute) are served by the primary key', async () => {
    const id = '00000000-0000-0000-0000-000000000001';
    const range = await planOf(
      `SELECT * FROM agency_campaign_pacing_minutes
        WHERE campaign_id = $1::uuid AND tenant_id = $2::uuid AND minute_start >= $3::timestamptz AND minute_start < $4::timestamptz
        ORDER BY minute_start`,
      [id, TENANT, '2026-11-01T00:00:00Z', '2026-11-04T00:00:00Z']);
    expect(range).toMatch(/Index Scan using agency_campaign_pacing_minutes_pkey/);
    expect(range).not.toMatch(/Sort/);
    const first = await planOf(
      'SELECT min(minute_start) FROM agency_campaign_pacing_minutes WHERE campaign_id = $1::uuid',
      [id]);
    expect(first).toMatch(/Index Only Scan using agency_campaign_pacing_minutes_pkey/);
  });

  it('agency_contacts.agent_reopen_pending is NOT NULL DEFAULT false', async () => {
    const cols = await columns('agency_contacts');
    expect(cols.find((c) => c.column_name === 'agent_reopen_pending')).toMatchObject({
      data_type: 'boolean', is_nullable: 'NO', column_default: 'false',
    });
    const campaign = await insertCampaign();
    expect((await insertContact(campaign.id))['agent_reopen_pending']).toBe(false);
  });

  it('down drops the table and the column; up re-applies', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf('0013_insights_pacing_history.sql'));
    try {
      const { rows } = await pool().query(
        `SELECT 'tbl' FROM pg_tables WHERE tablename = 'agency_campaign_pacing_minutes'
         UNION ALL SELECT 'col' FROM information_schema.columns
          WHERE table_name = 'agency_contacts' AND column_name = 'agent_reopen_pending'`);
      expect(rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect((await columns('agency_campaign_pacing_minutes')).length).toBe(3 + COUNTERS.length);
  });
});
