// Real Postgres: migrations/0077_credential_concurrency_cap.sql (docs/carriers.md CR13; wire shape
// `max_concurrent_calls` on TelephonyCredential in packages/contracts/src/api/platform/
// super-admin-telephony-credentials.ts). globalSetup has applied every migration. Pins the
// column (nullable, no default: an existing credential has no cap of its own), its CHECK both
// ways, the lock timeout on Up and Down, then down and up again.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../fixtures.js';

const pool = () => getTestPool();
const FILE = '0077_credential_concurrency_cap.sql';

let tenantId: string;
beforeEach(async () => {
  await truncateAll();
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') ON CONFLICT (name) DO NOTHING`);
  tenantId = (await insertTenant()).id as string;
});
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

function statements(part: 'up' | 'down'): string[] {
  const text = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8');
  const body = part === 'up'
    ? text.split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!
    : text.split(/^-- Down Migration/m)[1]!;
  return body.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

async function column(): Promise<{ data_type: string; is_nullable: string; column_default: string | null } | undefined> {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'telephony_credentials' AND column_name = 'max_concurrent_calls'`);
  return rows[0];
}

async function credential(cap: number | null): Promise<void> {
  await pool().query(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, max_concurrent_calls)
     VALUES ($1, 'plivo', $2, $3, $4)`,
    [tenantId, `cred-${randomUUID().slice(0, 6)}`, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`, cap],
  );
}

describe('0077 — a concurrency cap per carrier account (CR13)', () => {
  it('Up and Down start with the lock timeout (every tenant dial reads the table)', () => {
    expect(statements('up')[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements('down')[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });

  it('max_concurrent_calls: an integer, nullable, no default', async () => {
    expect(await column()).toEqual({ data_type: 'integer', is_nullable: 'YES', column_default: null });
  });

  it('accepts no cap and a positive cap; refuses zero and a negative one', async () => {
    await credential(null);
    await credential(1);
    await credential(1000);
    for (const cap of [0, -3]) {
      await expect(credential(cap)).rejects.toMatchObject({ code: '23514', constraint: 'chk_telephony_credentials_max_concurrent_calls' });
    }
  });

  it('down drops the column and its CHECK; up brings them back, an existing row with no cap', async () => {
    await credential(null);
    await migrate('down', 1);
    expect(await column()).toBeUndefined();
    const { rowCount } = await pool().query(`SELECT 1 FROM pg_constraint WHERE conname = 'chk_telephony_credentials_max_concurrent_calls'`);
    expect(rowCount).toBe(0);
    await migrate('up');
    expect(await column()).toBeDefined();
    const { rows } = await pool().query<{ max_concurrent_calls: number | null }>(`SELECT max_concurrent_calls FROM telephony_credentials`);
    expect(rows).toEqual([{ max_concurrent_calls: null }]);
  });
});
