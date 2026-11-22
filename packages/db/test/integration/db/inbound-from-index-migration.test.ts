// Real Postgres: migrations/0071_inbound_calls_from_index.sql (docs/customer-history.md,
// docs/call-log.md §8): an account's inbound calls from one number, newest first, which the
// customer history reads. globalSetup has applied every migration. Pins the index by its
// definition, that a number's keyset page in an account is planned on it with no sort (missed
// calls included, which 0033's answered-only index cannot serve), the invalid-index refusal,
// and down then up. That the server's own statements are planned on it is held in
// apps/server/test/integration/api/customer-history-inbound.test.ts (this package cannot
// import the server).
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

const FILE = '0071_inbound_calls_from_index.sql';
const NAME = 'idx_agency_inbound_calls_from';
const DEFINITION =
  'CREATE INDEX idx_agency_inbound_calls_from ON public.agency_inbound_calls USING btree '
  + '(tenant_id, account_id, from_e164, arrived_at DESC, id DESC) WHERE (from_e164 IS NOT NULL)';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0071 — an account\'s inbound calls from one number, newest first', () => {
  it('defines the index exactly', async () => {
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('serves a number\'s keyset page in an account, missed calls included', async () => {
    const pool = getTestPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL session_replication_role = replica`);
      const tenant = randomUUID();
      const account = randomUUID();
      // 20,000 missed calls of one account from 2,000 numbers: none is in 0033's answered index.
      await client.query(
        `INSERT INTO agency_inbound_calls
           (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome, arrived_at, ended_at,
            follow_up_status, follow_up_reason)
         SELECT $1, $2, 'p71-' || g, '+9198' || lpad((g % 2000)::text, 8, '0'), '+918000000000', 'ended', 'overflow',
                now() - (g || ' seconds')::interval, now() - (g || ' seconds')::interval, 'open', 'overflow'
           FROM generate_series(1, 20000) g`,
        [tenant, account],
      );
      await client.query('ANALYZE agency_inbound_calls');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT i.id FROM agency_inbound_calls i
          WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid AND i.from_e164 = $3::text
            AND i.state = 'ended' AND i.outcome IS DISTINCT FROM 'rejected'
            AND (i.arrived_at, i.id) < (now() - interval '10 minutes', $4::uuid)
          ORDER BY i.arrived_at DESC, i.id DESC LIMIT 51`, [tenant, account, '+919800000007', randomUUID()]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain(NAME);
      expect(plan).not.toMatch(/Sort/);
      expect(plan).not.toMatch(/Seq Scan/);
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
      await pool.query(
        `CREATE INDEX ${NAME} ON agency_inbound_calls (tenant_id, account_id, from_e164, arrived_at DESC, id DESC)
          WHERE from_e164 IS NOT NULL`);
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
