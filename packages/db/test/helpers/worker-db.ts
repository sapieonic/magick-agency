import pg from 'pg';
import { workerDbName } from '../../../../tooling/test-env.js';
import { TEST_DB_NAME_RE, assertSafeTestDbUrl } from './test-db.js';

/**
 * The integration workers' databases (`tooling/test-env.ts`). Every statement runs from the
 * `postgres` maintenance database on the same server: a template cannot be copied while
 * anything is connected to it, and no database can be dropped from inside itself. Every
 * name issued is checked against the test-database pattern first.
 */
function maintenanceClient(baseUrl: string): pg.Client {
  const url = new URL(baseUrl);
  url.pathname = '/postgres';
  return new pg.Client({ connectionString: url.toString() });
}

function baseNameOf(baseUrl: string): string {
  assertSafeTestDbUrl(baseUrl);
  return new URL(baseUrl).pathname.replace(/^\//, '');
}

/**
 * `<base>_w<worker>` made afresh: dropped (WITH FORCE, ending whatever a previous file left
 * connected) and copied from the migrated base, about a quarter of a second. Run before each
 * test file, so a file never sees the rows, dead pages, index bloat or statistics an earlier
 * file left: which files a worker ran earlier changes from run to run, and a plan test would
 * otherwise depend on it.
 */
export async function recreateWorkerDatabase(baseUrl: string, worker: number): Promise<void> {
  const base = baseNameOf(baseUrl);
  const name = workerDbName(base, worker);
  if (!TEST_DB_NAME_RE.test(name)) throw new Error(`REFUSING TO RUN: worker database "${name}" is not a test database`);
  const client = maintenanceClient(baseUrl);
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
    try {
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(name)} TEMPLATE ${pg.escapeIdentifier(base)}`);
    } catch (err) {
      // 55006: something (a psql, a dev server) is connected to the base database.
      if ((err as { code?: string }).code === '55006') {
        throw new Error(`cannot copy "${base}" for integration worker ${worker}: another session is connected to it. Close it and run again.`);
      }
      throw err;
    }
  } finally {
    await client.end();
  }
}

/** Drops every `<base>_w<N>` left by an earlier run (a larger worker count leaves more). */
export async function dropWorkerDatabases(baseUrl: string): Promise<void> {
  const base = baseNameOf(baseUrl);
  const client = maintenanceClient(baseUrl);
  await client.connect();
  try {
    const { rows } = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname ~ ('^' || $1 || '_w[0-9]+$')`, [base]);
    for (const { datname } of rows) {
      if (!TEST_DB_NAME_RE.test(datname)) throw new Error(`REFUSING TO RUN: "${datname}" is not a test database`);
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(datname)} WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
}
