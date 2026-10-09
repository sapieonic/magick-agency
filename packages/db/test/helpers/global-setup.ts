import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { TEST_DB_URL, assertSafeTestDbUrl } from './test-db.js';

async function waitForPostgres(maxAttempts = 30, delayMs = 1000): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pool = new pg.Pool({ connectionString: TEST_DB_URL });
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      await pool.end().catch(() => {});
    }
  }
  throw new Error(`Postgres not ready after ${maxAttempts} attempts: ${(lastErr as Error)?.message ?? lastErr}`);
}

/**
 * Fresh schema, then every migration, once per integration run. This is the
 * "baseline migrates on a throwaway Postgres" check: the schema is dropped
 * first, so a migration that only works against leftover state fails here.
 */
export default async function setup(): Promise<void> {
  assertSafeTestDbUrl();
  await waitForPostgres();
  const pool = new pg.Pool({ connectionString: TEST_DB_URL });
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
  } finally {
    await pool.end();
  }
  await runner({
    databaseUrl: TEST_DB_URL,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    log: () => {},
  });
}
