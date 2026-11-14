import { afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { closePool, initDbPool } from '../../../src/connection.js';
import { withTransaction } from '../../../src/utils/transaction.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';

/**
 * The pool's per-connection settings on real Postgres (`db-hygiene.md`): `application_name`,
 * and the session timeouts set by the connect hook before a connection's first caller runs a
 * statement. A mocked pool would prove nothing here: the point is what the server applies.
 */

afterEach(closePool);

async function settings(pool: pg.Pool): Promise<Record<string, string>> {
  const { rows } = await pool.query<{ name: string; setting: string }>(
    `SELECT name, current_setting(name) AS setting FROM unnest(ARRAY[
       'application_name', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout']) AS name`);
  return Object.fromEntries(rows.map((r) => [r.name, r.setting]));
}

/** The database's own defaults for the three timeouts, as a connection without the hook sees them. */
async function serverDefaults(): Promise<Record<string, string>> {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  try {
    const { rows } = await client.query<{ s: string; l: string; i: string }>(
      `SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l,
              current_setting('idle_in_transaction_session_timeout') AS i`);
    return { statement_timeout: rows[0]!.s, lock_timeout: rows[0]!.l, idle_in_transaction_session_timeout: rows[0]!.i };
  } finally {
    await client.end();
  }
}

describe('pool session settings (real Postgres)', () => {
  it('names every connection with application_name', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2, applicationName: 'magick-agency-test' });
    expect((await settings(pool)).application_name).toBe('magick-agency-test');
  });

  it('leaves every timeout as the database defines it when none is configured', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 });
    const { application_name: _, ...timeouts } = await settings(pool);
    expect(timeouts).toEqual(await serverDefaults());
  });

  it('applies each configured timeout on every connection, before its first statement', async () => {
    const pool = initDbPool({
      url: TEST_DB_URL, poolMin: 0, poolMax: 2,
      sessionTimeouts: { statementTimeoutMs: 45_000, lockTimeoutMs: 7_000, idleInTransactionTimeoutMs: 90_000 },
    });
    // Two connections held at once, so both are new ones that went through the hook.
    const [a, b] = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of [a, b]) {
        const { rows } = await client.query<{ s: string; l: string; i: string }>(
          `SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l,
                  current_setting('idle_in_transaction_session_timeout') AS i`);
        expect(rows[0]).toEqual({ s: '45s', l: '7s', i: '90s' });
      }
    } finally {
      a.release();
      b.release();
    }
  });

  it('statement_timeout cancels a long statement; SET LOCAL lifts it for one transaction only', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1, sessionTimeouts: { statementTimeoutMs: 200 } });
    await expect(pool.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });

    // The opt-out a long job uses: its own transaction, then the session value again.
    await withTransaction(async (client) => {
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query('SELECT pg_sleep(0.4)');
    }, { pool });
    expect((await settings(pool)).statement_timeout).toBe('200ms');
  });

  it('idle_in_transaction_session_timeout ends a session left idle inside a transaction', async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1, sessionTimeouts: { idleInTransactionTimeoutMs: 200 } });
    const client = await pool.connect();
    client.on('error', () => { /* the server ends the session; the next query reports it */ });
    try {
      await client.query('BEGIN');
      await new Promise((r) => setTimeout(r, 600));
      await expect(client.query('SELECT 1')).rejects.toThrow();
    } finally {
      client.release(true);
    }
    // The pool replaces the ended connection; the setting is applied to the new one too.
    expect((await settings(pool)).idle_in_transaction_session_timeout).toBe('200ms');
  });
});
