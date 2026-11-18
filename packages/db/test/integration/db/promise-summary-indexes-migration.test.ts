// Real Postgres: migrations/0050_promise_summary_indexes.sql (decision B28b): the promises summary
// walks an account's promises by when their outcome was written, on each call table. globalSetup
// has applied every migration. Pins the three indexes by their definitions, the invalid-index
// refusal, and down then up. The plan that reads them (the summary's own statement on seeded data)
// is pinned beside the statement, in
// apps/server/test/integration/agency/promise-summary-repository.test.ts.
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

const FILE = '0050_promise_summary_indexes.sql';
const DEFINITIONS: Record<string, string> = {
  idx_agency_attempts_promise_written:
    'CREATE INDEX idx_agency_attempts_promise_written ON public.agency_call_attempts '
    + 'USING btree (tenant_id, account_id, dispositioned_at) WHERE (promise_date IS NOT NULL)',
  idx_agency_manual_calls_promise_written:
    'CREATE INDEX idx_agency_manual_calls_promise_written ON public.agency_manual_calls '
    + 'USING btree (tenant_id, account_id, dispositioned_at) WHERE (promise_date IS NOT NULL)',
  idx_agency_inbound_calls_promise_written:
    'CREATE INDEX idx_agency_inbound_calls_promise_written ON public.agency_inbound_calls '
    + 'USING btree (tenant_id, account_id, dispositioned_at) WHERE (promise_date IS NOT NULL)',
};
const NAMES = Object.keys(DEFINITIONS);

async function indexDefs(): Promise<Record<string, string>> {
  const { rows } = await getTestPool().query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])`, [NAMES]);
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
}

function stepsDownTo(file: string): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.length - files.indexOf(file);
}

describe('0050 — the promises summary\'s indexes of promises by when they were written', () => {
  it('defines the three indexes exactly', async () => {
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });

  it('fails on an invalid index left under one of its names by a failed CREATE INDEX CONCURRENTLY', async () => {
    const pool = getTestPool();
    const name = 'idx_agency_manual_calls_promise_written';
    await migrate('down', stepsDownTo(FILE));
    try {
      await pool.query(`CREATE INDEX ${name} ON agency_manual_calls (tenant_id, account_id, dispositioned_at) WHERE promise_date IS NOT NULL`);
      await pool.query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${name}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${name}`));
      const { rows } = await pool.query(`SELECT name FROM pgmigrations WHERE name = $1`, [FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool.query(`DROP INDEX IF EXISTS ${name}`);
      await migrate('up');
    }
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });

  it('down drops them; up restores them', async () => {
    await migrate('down', stepsDownTo(FILE));
    try {
      expect(await indexDefs()).toEqual({});
    } finally {
      await migrate('up');
    }
    expect(await indexDefs()).toEqual(DEFINITIONS);
  });
});
