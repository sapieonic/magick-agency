// Real Postgres: migrations/0019_plivo_numbers_and_carrier_pause.sql (decisions B18–B22).
// globalSetup has applied every migration. Pins the provider row's activation (read straight
// after a fresh down-up of 0019, since truncateAll empties the seed), the synced-number column
// and its FK, the widened pause_reason CHECK, then down (plivo inactive again, the column gone,
// a carrier_auth pause rewritten to a supervisor pause) and up again.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0019_plivo_numbers_and_carrier_pause.sql';

async function seedProviders(plivoStatus: 'active' | 'inactive' = 'active'): Promise<{ voicelink: string; plivo: string }> {
  const { rows } = await pool().query<{ id: string; name: string }>(
    `INSERT INTO telephony_providers (name, display_name, status)
     VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', $1) RETURNING id, name`, [plivoStatus]);
  return { voicelink: rows.find((r) => r.name === 'voicelink')!.id, plivo: rows.find((r) => r.name === 'plivo')!.id };
}

async function insertCredential(tenantId: string): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref)
     VALUES ($1, 'plivo', $2, $3) RETURNING id`,
    [tenantId, `cred-${randomUUID().slice(0, 6)}`, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`]);
  return rows[0]!.id;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rowCount } = await pool().query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]);
  return rowCount === 1;
}

/** Roll 0019 (and anything after it) back, run `body`, and always re-apply. */
async function whileDown(body: () => Promise<void>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  try {
    await body();
  } finally {
    await migrate('up');
  }
}

describe('0019 — plivo numbers and the carrier_auth pause', () => {
  it('phone_numbers.telephony_credential_id: nullable, a foreign key to telephony_credentials, indexed', async () => {
    const { plivo } = await seedProviders();
    const tenant = (await insertTenant()).id as string;
    const cred = await insertCredential(tenant);
    const own = await pool().query<{ telephony_credential_id: string | null }>(
      `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ('+14155550001', $1) RETURNING telephony_credential_id`, [plivo]);
    expect(own.rows[0]!.telephony_credential_id).toBeNull();
    await pool().query(
      `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id) VALUES ('+14155550002', $1, $2)`, [plivo, cred]);
    await expect(pool().query(
      `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id) VALUES ('+14155550003', $1, $2)`, [plivo, randomUUID()]))
      .rejects.toMatchObject({ code: '23503', constraint: 'fk_phone_numbers_telephony_credential' });
    // RESTRICT: a credential a number is synced from cannot be deleted (they never are; revoked only).
    await expect(pool().query('DELETE FROM telephony_credentials WHERE id = $1', [cred]))
      .rejects.toMatchObject({ code: '23503' });
    const idx = await pool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_phone_numbers_telephony_credential'`);
    expect(idx.rows[0]!.indexdef).toBe(
      'CREATE INDEX idx_phone_numbers_telephony_credential ON public.phone_numbers USING btree (telephony_credential_id) '
      + 'WHERE (telephony_credential_id IS NOT NULL)');
  });

  it('pause_reason accepts carrier_auth beside supervisor and abandonment_ceiling, and nothing else', async () => {
    const campaign = await insertCampaign({ status: 'paused' });
    for (const reason of ['supervisor', 'abandonment_ceiling', 'carrier_auth']) {
      await pool().query('UPDATE agency_campaigns SET pause_reason = $1 WHERE id = $2', [reason, campaign.id]);
    }
    await expect(pool().query(`UPDATE agency_campaigns SET pause_reason = 'carrier' WHERE id = $1`, [campaign.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_pause_reason' });
  });

  it('up activates the plivo provider row; down makes it inactive again, drops the column and rewrites carrier_auth pauses', async () => {
    await seedProviders('active');
    const campaign = await insertCampaign({ status: 'paused', pause_reason: 'carrier_auth', paused_at: new Date() });
    await whileDown(async () => {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0018_agent_caller_ids');
      const status = await pool().query<{ status: string }>(`SELECT status FROM telephony_providers WHERE name = 'plivo'`);
      expect(status.rows[0]!.status).toBe('inactive');
      expect(await columnExists('phone_numbers', 'telephony_credential_id')).toBe(false);
      const row = await pool().query<{ status: string; pause_reason: string }>(
        'SELECT status, pause_reason FROM agency_campaigns WHERE id = $1', [campaign.id]);
      expect(row.rows[0]).toEqual({ status: 'paused', pause_reason: 'supervisor' });
      await expect(pool().query(`UPDATE agency_campaigns SET pause_reason = 'carrier_auth' WHERE id = $1`, [campaign.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_pause_reason' });
    });
    const status = await pool().query<{ status: string }>(`SELECT status FROM telephony_providers WHERE name = 'plivo'`);
    expect(status.rows[0]!.status).toBe('active');
    expect(await columnExists('phone_numbers', 'telephony_credential_id')).toBe(true);
  });
});
