// Real Postgres: migrations/0033_inbound_answered_from_index.sql (IQ49, docs/inbound.md §4.1).
// globalSetup has applied every migration. Pins the index by its definition (key order and the
// partial predicate the identification read repeats) and down then up.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0033_inbound_answered_from_index.sql';
const INDEX = 'idx_agency_inbound_calls_answered_from';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [INDEX]);
  return rows[0]?.indexdef;
}

describe('0033 — the answered inbound calls by caller (IQ49)', () => {
  it('keyed (tenant, account, caller, newest first), over answered calls with a number only', async () => {
    expect(await indexDef()).toBe(
      'CREATE INDEX idx_agency_inbound_calls_answered_from ON public.agency_inbound_calls USING btree '
      + '(tenant_id, account_id, from_e164, arrived_at DESC, id DESC) '
      + 'WHERE ((bridged_at IS NOT NULL) AND (from_e164 IS NOT NULL))');
  });

  it('down drops it; up restores it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const after = files.length - files.indexOf(FILE);
    await migrate('down', after);
    try {
      expect(await indexDef()).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBeDefined();
  });
});
