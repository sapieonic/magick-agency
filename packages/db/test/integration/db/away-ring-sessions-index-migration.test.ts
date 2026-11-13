// Real Postgres: migrations/0037_away_ring_sessions_index.sql (Mode B: the sessions on an away
// break whose phone rings). globalSetup has applied every migration. Pins the partial index by its
// definition (the predicate the ring search and the reconcile repeat), that the account's search
// uses it, and down then up.
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

const FILE = '0037_away_ring_sessions_index.sql';
const INDEX = 'idx_agency_agent_sessions_away_ring';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [INDEX]);
  return rows[0]?.indexdef;
}

describe('0037 — the sessions on an away break whose phone rings', () => {
  it('keyed (tenant, account), partial on a live session on an absence', async () => {
    expect(await indexDef()).toBe(
      'CREATE INDEX idx_agency_agent_sessions_away_ring ON public.agency_agent_sessions USING btree (tenant_id, account_id) '
      + 'WHERE ((away_ring_since IS NOT NULL) AND (left_at IS NULL))');
  });

  it("the account's ring search can use it", async () => {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM agency_agent_sessions s
          WHERE s.tenant_id = '00000000-0000-0000-0000-000000000001' AND s.account_id = '00000000-0000-0000-0000-000000000002'
            AND s.away_ring_since IS NOT NULL AND s.left_at IS NULL`);
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toContain(INDEX);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
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
