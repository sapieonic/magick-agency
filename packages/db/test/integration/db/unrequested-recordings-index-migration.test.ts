// Real Postgres: migrations/0046_unrequested_recordings_index.sql (RC5, the retention purge's
// recording step). globalSetup has applied every migration. Pins the index by its definition, that
// the purge's batch pick reads it in its keyset order and that the dry-run count reads it, the
// invalid-index refusal, and down then up.
//
// The reads below repeat the server's SQL (apps/server/src/maintenance/retention-purge.ts:
// CLEAR_UNREQUESTED_RECORDINGS_SQL's pick and the dry-run count) word for word in their WHERE
// and ORDER BY: a partial index is only usable when the planner can prove the read implies its
// predicate, so a change to either side must keep them matching.
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

const FILE = '0046_unrequested_recordings_index.sql';
const NAME = 'idx_agency_calls_recording_unrequested';
const DEFINITION =
  'CREATE INDEX idx_agency_calls_recording_unrequested ON public.agency_calls USING btree (id) '
  + 'WHERE ((recording_url IS NOT NULL) AND (NOT recording_requested))';

async function indexDef(): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
  return rows[0]?.indexdef;
}

/**
 * The plan of `sql` with sequential and bitmap scans priced out, so an index the read can use is
 * chosen, and a plain index scan whose order matches the ORDER BY needs no Sort above it.
 */
async function plan(sql: string, params: unknown[]): Promise<string> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/** The purge's batch pick (CLEAR_UNREQUESTED_RECORDINGS_SQL's `picked`). */
const PICK = `SELECT id FROM agency_calls
          WHERE recording_url IS NOT NULL AND NOT recording_requested AND id > $2::uuid
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`;

describe('0046 — the retention purge\'s index of calls holding a recording they did not ask for', () => {
  it('defines the index exactly', async () => {
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('the batch pick walks it in id order from the keyset, with no Sort', async () => {
    const p = await plan(PICK, [5000, '00000000-0000-0000-0000-000000000000']);
    expect(p).toContain(NAME);
    expect(p).toContain('Index Cond: (id >');
    expect(p).not.toContain('Sort');
  });

  it('the dry-run count reads it', async () => {
    const p = await plan(`SELECT count(*)::int AS n FROM agency_calls WHERE recording_url IS NOT NULL AND NOT recording_requested`, []);
    expect(p).toContain(NAME);
  });

  it('fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pool = getTestPool();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      // What a failed concurrent build leaves: the index exists, marked not valid.
      await pool.query(`CREATE INDEX ${NAME} ON agency_calls (id) WHERE recording_url IS NOT NULL AND NOT recording_requested`);
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
