// Real Postgres: migrations/0049_listen_history_index.sql (docs/listening.md LS22 t, §12): the
// account's listening history walks an account's live sessions newest first. globalSetup has
// applied every migration. Pins the index by its definition, the invalid-index refusal, and down
// then up. The plan that reads it (the history's own statement on seeded data) is pinned beside the
// statement, in apps/server/test/integration/agency/listen-history-plan.test.ts.
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

const FILE = '0049_listen_history_index.sql';
const NAME = 'idx_agency_listen_sessions_account_started';
const DEFINITION =
  'CREATE INDEX idx_agency_listen_sessions_account_started ON public.agency_listen_sessions '
  + 'USING btree (tenant_id, account_id, started_at DESC, id DESC) WHERE (live_at IS NOT NULL)';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

describe('0049 — the listening history\'s index of an account\'s live sessions', () => {
  it('defines the index exactly', async () => {
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pool = getTestPool();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      await pool.query(`CREATE INDEX ${NAME} ON agency_listen_sessions (tenant_id, account_id, started_at DESC, id DESC) WHERE live_at IS NOT NULL`);
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
