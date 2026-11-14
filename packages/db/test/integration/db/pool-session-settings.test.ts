import { afterEach, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { logger } from '@magick-agency/observability';
import { closePool, initDbPool, sessionSettingsSql } from '../../../src/connection.js';
import { withTransaction } from '../../../src/utils/transaction.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';

/**
 * The pool's per-connection settings on real Postgres (`db-hygiene.md`): `application_name`,
 * and the session timeouts set by the connect hook before a connection's first caller runs a
 * statement. A mocked pool would prove nothing here: the point is what the server applies.
 */

afterEach(async () => {
  vi.restoreAllMocks();
  await closePool();
});

const POOL_ERROR = 'Unexpected database pool error';
const HELD_WARNING = 'Database connection ended under its client';

/** Spies on the two logs a connection ended by the server can produce, and silences them. */
function spyConnectionLogs() {
  const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const messages = (spy: typeof error) => spy.mock.calls.map((call) => call[1]);
  return { poolErrors: () => messages(error).filter((m) => m === POOL_ERROR), heldWarnings: () => messages(warn).filter((m) => m === HELD_WARNING) };
}

/** Ends the backend `pid` from a connection of its own, as an operator or a pooler restart would. */
async function terminateBackend(pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]);
    expect(rows[0]!.ok).toBe(true);
  } finally {
    await admin.end();
  }
}

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

  it('the settings SQL replaces what an earlier client left on a reused session (a pooler that does not reset)', async () => {
    // One Postgres session standing in for a pooled connection: an earlier client's name and
    // timeouts are still on it when the next client's connect hook runs.
    const client = new pg.Client({ connectionString: TEST_DB_URL, application_name: 'earlier-client' });
    await client.connect();
    try {
      await client.query(`SET statement_timeout = '5s'; SET lock_timeout = '6s'; SET idle_in_transaction_session_timeout = '7s'`);
      await client.query(sessionSettingsSql('magick-agency-test', { lockTimeoutMs: 60_000 }));
      const { rows } = await client.query<{ a: string; s: string; l: string; i: string }>(
        `SELECT current_setting('application_name') AS a, current_setting('statement_timeout') AS s,
                current_setting('lock_timeout') AS l, current_setting('idle_in_transaction_session_timeout') AS i`);
      const defaults = await serverDefaults();
      expect(rows[0]).toEqual({
        a: 'magick-agency-test', s: defaults.statement_timeout, l: '1min', i: defaults.idle_in_transaction_session_timeout,
      });
    } finally {
      await client.end();
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
    const logs = spyConnectionLogs();
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1, sessionTimeouts: { idleInTransactionTimeoutMs: 200 } });
    // No 'error' listener of the test's own: the pool's (initDbPool) must catch the server ending
    // a checked-out session, or the unhandled 'error' fails this file (in the server, the process).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await new Promise((r) => setTimeout(r, 600));
      await expect(client.query('SELECT 1')).rejects.toThrow();
    } finally {
      // A plain release, as withTransaction does: pg-pool drops the ended client itself.
      client.release();
    }
    // Ended under its holder: the warning says so; the pool's own 'error' never saw it.
    expect(logs.heldWarnings()).toHaveLength(1);
    expect(logs.poolErrors()).toEqual([]);
    expect(pool.totalCount).toBe(0);
    // The pool replaces the ended connection; the setting is applied to the new one too.
    expect((await settings(pool)).idle_in_transaction_session_timeout).toBe('200ms');
  });

  it('an idle pooled connection ended by the server is logged once, as a pool error, not as a held one', async () => {
    const logs = spyConnectionLogs();
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 1 });
    // One connection, back in the pool and idle once this query returns.
    const { rows } = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(pool.idleCount).toBe(1);

    const poolError = new Promise((resolve) => pool.once('error', resolve));
    await terminateBackend(rows[0]!.pid);
    await poolError;
    // pg reports an ended backend twice (the server's FATAL, then the socket's end): let the
    // second arrive before counting.
    await new Promise((r) => setTimeout(r, 100));

    expect(logs.poolErrors()).toHaveLength(1);
    expect(logs.heldWarnings()).toEqual([]);
    expect(pool.totalCount).toBe(0);
    // The pool replaces it on the next acquire.
    expect((await pool.query<{ one: number }>('SELECT 1 AS one')).rows[0]!.one).toBe(1);
  });
});
