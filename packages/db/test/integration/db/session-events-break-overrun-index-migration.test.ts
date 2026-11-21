// Real Postgres: migrations/0066_session_events_break_overrun_index.sql (docs/compare-agents.md §7):
// the events that ended a break over its limit, by campaign and time, which Compare agents' breaks
// over their limit read. globalSetup has applied every migration. Pins the index by its definition,
// that a statement repeating its predicate uses it, the invalid-index refusal, and down then up. That
// the read's own statement (`COMPARE_BREAK_OVERRUNS_SQL`) is planned on the index (this package cannot
// import the server) is held in apps/server/test/integration/agency/compare-break-overrun-index.test.ts.
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

const FILE = '0066_session_events_break_overrun_index.sql';
const NAME = 'idx_agency_session_events_break_overrun';
const DEFINITION =
  'CREATE INDEX idx_agency_session_events_break_overrun ON public.agency_agent_session_events USING btree (campaign_id, at) '
  + 'WHERE (break_overrun_seconds IS NOT NULL)';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0066 — breaks over their limit, by campaign and time', () => {
  it('defines the index exactly, with its comment', async () => {
    expect(await indexDef()).toBe(DEFINITION);
    const { rows } = await getTestPool().query<{ c: string | null }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [NAME]);
    expect(rows[0]!.c).toMatch(/break over its limit/);
  });

  it('serves a statement that repeats its predicate for one campaign', async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      const tenant = randomUUID();
      const account = randomUUID();
      const campaign = randomUUID();
      await client.query(`INSERT INTO tenants (id, name, slug, settings, status) VALUES ($1, 'T', $2, '{}', 'active')`, [tenant, `t-${tenant.slice(0, 8)}`]);
      await client.query(
        `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, telephony_provider, status)
         VALUES ($1, $2, $3, 'C', ARRAY['+919000000001'], 'voicelink', 'running')`, [campaign, tenant, account]);
      // Many state changes on the campaign, one overrun in a hundred.
      await client.query(
        `WITH s AS (
           INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, kind, state, joined_at)
           SELECT gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'campaign', 'offline', now() - interval '30 days'
             FROM generate_series(1, 50) RETURNING id, tenant_id, account_id, campaign_id, agent_user_id)
         INSERT INTO agency_agent_session_events (session_id, tenant_id, account_id, campaign_id, agent_user_id, from_state, to_state, at,
                                                  break_limit_minutes, break_overrun_seconds)
         SELECT s.id, s.tenant_id, s.account_id, s.campaign_id, s.agent_user_id,
                CASE WHEN n % 100 = 0 THEN 'break' ELSE 'available' END, 'on_call',
                now() - (n || ' minutes')::interval,
                CASE WHEN n % 100 = 0 THEN 15 END, CASE WHEN n % 100 = 0 THEN 60 END
           FROM s, generate_series(1, 400) n`,
        [tenant, account, campaign],
      );
      await client.query('ANALYZE agency_agent_session_events');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT e.agent_user_id FROM agency_agent_session_events e
          WHERE e.campaign_id = $1::uuid AND e.at >= now() - interval '7 days' AND e.break_overrun_seconds IS NOT NULL`, [campaign]);
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
      await pool.query(`CREATE INDEX ${NAME} ON agency_agent_session_events (campaign_id, at) WHERE break_overrun_seconds IS NOT NULL`);
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
