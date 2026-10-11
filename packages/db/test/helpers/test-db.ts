import pg from 'pg';
import { DEFAULT_TEST_DB_URL } from '../../../../tooling/test-env.js';

/**
 * The ONLY database integration tests may touch. The guard below refuses
 * anything else, explicit env override or not: every other port on this
 * machine belongs to another local stack (the 5432-5434 and 6379-6381 ranges),
 * and a reset here is `DROP SCHEMA public CASCADE`.
 */
export const TEST_DB_URL = process.env['TEST_DB_URL'] ?? DEFAULT_TEST_DB_URL;

/** `magick_agency_test`, or a per-worktree `magick_agency_test_<suffix>` (tooling/test-env.ts). */
export const TEST_DB_NAME_RE = /^magick_agency_test(_[a-z0-9_]+)?$/;

export function assertSafeTestDbUrl(url: string = TEST_DB_URL): void {
  const parsed = new URL(url);
  const db = parsed.pathname.replace(/^\//, '');
  const port = parsed.port || '5432';
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  // CI runs Postgres as a service container on the same port; anything else is refused.
  if (!TEST_DB_NAME_RE.test(db) || (local && port !== '5436')) {
    throw new Error(
      `REFUSING TO RUN: test database must be magick_agency_test[_<suffix>] on port 5436, got "${db}" on ${parsed.hostname}:${port}. ` +
        'Start agency infra with `pnpm infra:up`.',
    );
  }
}

let pool: pg.Pool | null = null;

export function getTestPool(): pg.Pool {
  assertSafeTestDbUrl();
  if (!pool) pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  return pool;
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Empty every table in `public` except the migrations ledger, in one
 * statement. Partitioned parents delete from their partitions with them.
 *
 * DELETE, not TRUNCATE. Suites call this before every test, and TRUNCATE gives
 * every table, partition and index a new file (~280 ms locally, ~550 ms on a CI
 * runner, for tables holding a handful of rows); DELETE on these tables is ~10 ms.
 * The end state is the same: the schema has no sequences or identity columns to
 * restart and no DELETE triggers. Every DELETE is a CTE of one statement, so the
 * FK checks run once at its end, against empty tables, and table order does not
 * matter.
 */
export async function truncateAll(client: pg.Pool | pg.PoolClient = getTestPool()): Promise<void> {
  const { rows } = await client.query<{ t: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS t
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'pgmigrations'
        AND tablename NOT IN (SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid)`,
  );
  if (rows.length === 0) return;
  const sql = `WITH ${rows.map((r, i) => `d${i} AS (DELETE FROM ${r.t})`).join(', ')} SELECT 1`;
  // A previous test's fire-and-forget write (e.g. the server's un-awaited super-admin
  // audit INSERT) can still be in flight. If it commits after our snapshot, its row
  // survives our DELETE and fails the FK check at the end (23503); the two can also
  // deadlock on row locks (40P01). Either way, retry ours: the retry sees the row.
  for (let attempt = 1; ; attempt++) {
    try {
      await client.query(sql);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if ((code !== '40P01' && code !== '23503') || attempt >= TRUNCATE_RETRIES) throw err;
    }
  }
}

const TRUNCATE_RETRIES = 3;
