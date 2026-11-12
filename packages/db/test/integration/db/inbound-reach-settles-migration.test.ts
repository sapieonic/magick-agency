// Real Postgres: migrations/0029_inbound_reach_settles.sql (docs/inbound.md §6, §7, §9). globalSetup
// has applied every migration. Pins the two columns it adds: agency_contacts.callback_reopened
// (NOT NULL, false by default, so every existing contact reads "not reopened") and
// agency_inbound_calls.carrier_seconds (nullable, never negative); that adding the contacts column
// is catalog-only (a constant default: no table rewrite, the relfilenode is unchanged); and the
// Down and up again. What the server makes of them is pinned in its inbound suites
// (inbound-agent-return, inbound-follow-up) and the usage counts' carrier-seconds test.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertAccount, insertCampaign, insertContact, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();
const FILE = '0029_inbound_reach_settles.sql';

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
  await insertAccount(TENANT, { id: ACCOUNT });
});
// 0024's Down refuses while an inbound call exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, name]);
  return rows[0];
}

describe('0029 — the columns', () => {
  it('agency_contacts.callback_reopened: boolean, NOT NULL, false by default (an existing contact reads not reopened)', async () => {
    expect(await column('agency_contacts', 'callback_reopened')).toEqual({ data_type: 'boolean', is_nullable: 'NO', column_default: 'false' });
    const contact = await insertContact((await insertCampaign()).id as string);
    const { rows } = await pool().query<{ callback_reopened: boolean }>('SELECT callback_reopened FROM agency_contacts WHERE id = $1', [contact.id]);
    expect(rows[0]!.callback_reopened).toBe(false);
  });

  it('agency_inbound_calls.carrier_seconds: integer, nullable, never negative', async () => {
    expect(await column('agency_inbound_calls', 'carrier_seconds')).toEqual({ data_type: 'integer', is_nullable: 'YES', column_default: null });
    const call = (o: Record<string, unknown>) => insertRow('agency_inbound_calls', {
      tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
    });
    await expect(call({})).resolves.toBeTruthy();
    await expect(call({ carrier_seconds: 0 })).resolves.toBeTruthy();
    await expect(call({ carrier_seconds: -1 })).rejects.toThrow(/ck_agency_inbound_calls_carrier_seconds/);
  });
});

describe('0029 — the Down and up again', () => {
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const downToBefore = () => migrate('down', files().length - files().indexOf(FILE));
  const relfilenode = async () => (await pool().query<{ relfilenode: string }>(
    `SELECT relfilenode::text FROM pg_class WHERE relname = 'agency_contacts'`)).rows[0]!.relfilenode;

  it('drops both columns and the CHECK; up adds them again without rewriting agency_contacts', async () => {
    await insertContact((await insertCampaign()).id as string);
    await downToBefore();
    try {
      expect(await column('agency_contacts', 'callback_reopened')).toBeUndefined();
      expect(await column('agency_inbound_calls', 'carrier_seconds')).toBeUndefined();
      const { rows } = await pool().query(`SELECT 1 FROM pg_constraint WHERE conname = 'ck_agency_inbound_calls_carrier_seconds'`);
      expect(rows).toEqual([]);
    } finally {
      const before = await relfilenode();
      await migrate('up');
      // A constant default is catalog-only: the table is not rewritten.
      expect(await relfilenode()).toBe(before);
    }
    expect(await column('agency_contacts', 'callback_reopened')).toMatchObject({ is_nullable: 'NO' });
    expect(await column('agency_inbound_calls', 'carrier_seconds')).toMatchObject({ is_nullable: 'YES' });
  });
});
