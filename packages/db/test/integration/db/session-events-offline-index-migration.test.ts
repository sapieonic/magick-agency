// Real Postgres: migrations/0065_session_events_offline_index.sql (docs/compare-agents.md §7): a
// session's offline boundaries by session, which Compare agents' trend days read. globalSetup has
// applied every migration. Pins the index by its definition, that a statement repeating its predicate
// uses it, the invalid-index refusal, and down then up. The trend's own statement on seeded data is
// held in apps/server/test/integration/api/compare-agents.test.ts.
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

const FILE = '0065_session_events_offline_index.sql';
const NAME = 'idx_agency_session_events_offline';
const DEFINITION =
  'CREATE INDEX idx_agency_session_events_offline ON public.agency_agent_session_events USING btree (session_id, at) '
  + "WHERE (((to_state)::text = 'offline'::text) OR ((from_state)::text = 'offline'::text))";

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0065 — a session\'s offline boundaries, by session', () => {
  it('defines the index exactly', async () => {
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('serves a statement that repeats its predicate for one session', async () => {
    const pool = getTestPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tenant = randomUUID();
      const account = randomUUID();
      await client.query(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', $2, '{}', 'active')`, [tenant, `t-${tenant.slice(0, 8)}`]);
      // Many state changes, a few boundaries.
      await client.query(
        `WITH s AS (
           INSERT INTO agency_agent_sessions (id, tenant_id, account_id, agent_user_id, kind, state, joined_at)
           SELECT gen_random_uuid(), $1, $2, gen_random_uuid(), 'softphone', 'offline', now() - interval '30 days'
             FROM generate_series(1, 50) RETURNING id, tenant_id, account_id, agent_user_id)
         INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, agent_user_id, from_state, to_state, at)
         SELECT s.id, s.tenant_id, s.account_id, s.agent_user_id,
                CASE WHEN n % 100 = 0 THEN 'offline' ELSE 'available' END,
                CASE WHEN n % 100 = 1 THEN 'offline' ELSE 'on_call' END,
                now() - (n || ' minutes')::interval
           FROM s, generate_series(1, 400) n`,
        [tenant, account],
      );
      await client.query('ANALYZE agency_agent_session_events');
      const { rows: [one] } = await client.query<{ id: string }>('SELECT session_id AS id FROM agency_agent_session_events LIMIT 1');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT e.at FROM agency_agent_session_events e
          WHERE e.session_id = $1::uuid AND (e.to_state = 'offline' OR e.from_state = 'offline')`, [one!.id]);
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(NAME);
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
      await pool.query(`CREATE INDEX ${NAME} ON agency_agent_session_events (session_id, at) WHERE to_state = 'offline' OR from_state = 'offline'`);
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
