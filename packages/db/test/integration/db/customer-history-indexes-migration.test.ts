// Real Postgres: migrations/0016_customer_history_indexes.sql (docs/customer-history.md, CH9).
// globalSetup has applied every migration. Pins the soft-phone destination index by definition
// AND by the planner using it for the history's read (account-scoped, newest first, no sort),
// then down (the index is gone) and up again.
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0016_customer_history_indexes.sql';
const INDEX = 'idx_agency_manual_calls_destination';

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/** The plan for `sql` with sequential scans priced out (see attempt-indexes-migration.test.ts). */
async function planOf(sql: string): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0016 — customer history indexes', () => {
  it('the soft-phone destination index: (tenant, account, destination, created_at DESC, id DESC)', async () => {
    expect(await indexDef(INDEX)).toBe(
      'CREATE INDEX idx_agency_manual_calls_destination ON public.agency_manual_calls USING btree '
      + '(tenant_id, account_id, destination_e164, created_at DESC, id DESC)');
  });

  it('the history\'s soft-phone read is served by it, keys bound and no sort', async () => {
    const plan = await planOf(
      `SELECT id FROM agency_manual_calls
        WHERE tenant_id = '${TENANT}'::uuid AND account_id = ANY(ARRAY['${ACCOUNT}']::uuid[])
          AND destination_e164 = '+919876543210'
        ORDER BY created_at DESC, id DESC LIMIT 50`);
    expect(plan).toContain(INDEX);
    expect(plan).toMatch(/Index Cond: .*destination_e164/);
  });

  it('down drops the index; up re-applies it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0015_multiple_running_campaigns');
      expect(await indexDef(INDEX)).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef(INDEX)).toBeDefined();
  });
});
