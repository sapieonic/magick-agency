// Real Postgres: migrations/0072_attempts_account_created_index.sql (docs/call-log.md §7): an
// account's dialler attempts, newest first, which the account's All calls and the agent's My
// calls read. globalSetup has applied every migration. Pins the index by its definition, that
// an account's keyset page is planned on it, the invalid-index refusal, and down then up. That
// the server's own statement (`listCallLog`) is planned on it is held in
// apps/server/test/integration/api/agency-all-calls.test.ts (this package cannot import the server).
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0072_attempts_account_created_index.sql';
const NAME = 'idx_agency_attempts_account_created';
const DEFINITION =
  'CREATE INDEX idx_agency_attempts_account_created ON public.agency_call_attempts USING btree '
  + '(tenant_id, account_id, created_at DESC, id DESC)';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0072 — an account\'s dialler attempts, newest first', () => {
  it('defines the index exactly', async () => {
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('serves an account\'s keyset page', async () => {
    const pool = getTestPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The triggers count dials and mark Insights buckets: not what this plan is about.
      await client.query(`SET LOCAL session_replication_role = replica`);
      const tenant = randomUUID();
      const account = randomUUID();
      const other = randomUUID();
      await client.query(
        `WITH camp AS (
           INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids)
           SELECT $1, CASE WHEN n <= 4 THEN $2::uuid ELSE $3::uuid END, 'C' || n, ARRAY['+912200000000']
             FROM generate_series(1, 8) n RETURNING id, account_id),
         con AS (
           INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164)
           SELECT camp.id, $1, camp.account_id, '+91' || (7000000000 + row_number() OVER ())::text
             FROM camp, generate_series(1, 2500) g RETURNING id, campaign_id, account_id)
         INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, created_at)
         SELECT con.campaign_id, con.id, $1, con.account_id, 1, '+912200000000', 'ended',
                now() - (row_number() OVER () || ' seconds')::interval
           FROM con`,
        [tenant, account, other],
      );
      await client.query('ANALYZE agency_call_attempts');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT a.id FROM agency_call_attempts a
          WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid
            AND (a.created_at, a.id) < (now() - interval '10 minutes', $3::uuid)
          ORDER BY a.created_at DESC, a.id DESC LIMIT 51`, [tenant, account, randomUUID()]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain(NAME);
      expect(plan).not.toMatch(/Sort/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pool = getTestPool();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      await pool.query(`CREATE INDEX ${NAME} ON agency_call_attempts (tenant_id, account_id, created_at DESC, id DESC)`);
      await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${NAME}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${NAME}`));
      const { rows } = await pool.query(`SELECT name FROM pgmigrations WHERE name = $1`, [FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool.query(`DROP INDEX IF EXISTS ${NAME}`);
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('down drops it; up restores it', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect(await indexDef()).toBeUndefined();
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });
});
