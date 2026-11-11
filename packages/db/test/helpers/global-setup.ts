import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { MIGRATIONS_DIR } from '../../src/migrations-dir.js';
import { testWorkers, workerDbName } from '../../../../tooling/test-env.js';
import { TEST_DB_NAME_RE, TEST_DB_URL, assertSafeTestDbUrl } from './test-db.js';

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
 * One database per integration worker: `<base>_w1` .. `<base>_w<workers>`, each a
 * `CREATE DATABASE … TEMPLATE <base>` copy of the freshly migrated base (about a quarter
 * of a second each, against re-running every migration). `worker-env.ts` points worker N
 * at `<base>_wN`. Run from the `postgres` maintenance database: a template cannot be
 * copied while anything is connected to it, and neither database may be dropped from
 * inside itself. Every name issued is checked against the test-database pattern first.
 */
async function cloneWorkerDatabases(workers: number): Promise<void> {
  const baseUrl = new URL(TEST_DB_URL);
  const baseName = baseUrl.pathname.replace(/^\//, '');
  const maintenance = new URL(TEST_DB_URL);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    for (let worker = 1; worker <= workers; worker++) {
      const name = workerDbName(baseName, worker);
      if (!TEST_DB_NAME_RE.test(name)) throw new Error(`REFUSING TO RUN: worker database "${name}" is not a test database`);
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      try {
        await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(baseName)}`);
      } catch (err) {
        // 55006: something (a psql, a dev server) is connected to the base database.
        if ((err as { code?: string }).code === '55006') {
          throw new Error(`cannot copy "${baseName}" for the integration workers: another session is connected to it. Close it and run again.`);
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Fresh schema, then every migration, once per integration run. This is the
 * "baseline migrates on a throwaway Postgres" check: the schema is dropped
 * first, so a migration that only works against leftover state fails here.
 * Then one copy of it per worker: the suites themselves never touch the base.
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
  await cloneWorkerDatabases(testWorkers());
}
