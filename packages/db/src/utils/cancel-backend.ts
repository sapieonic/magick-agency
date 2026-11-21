import pg from 'pg';

/**
 * Cancel the statement running on one backend, over a connection of its own.
 *
 * ── Why not `pool.query('SELECT pg_cancel_backend($1)')` ─────────────────────
 * Two readers stop a statement when their caller goes away (Compare agents' read,
 * `apps/server/src/agency/compare/read.ts`; the report cursor, `report-dataset-reads.ts`), and
 * both used to send the cancel through the shared pool, fire and forget. That is wrong twice
 * over when the pool is busy, which is exactly when it matters:
 *
 *  - the cancel WAITS in the pool's queue behind every other borrower, so the statement it means
 *    to stop runs on, and may finish, before the cancel is sent;
 *  - a cancel that lands late finds the backend serving whoever borrowed the connection next (the
 *    reader rolled back and released it meanwhile), and cancels THEIR statement: a dialler write.
 *
 * So the cancel goes on a fresh, unpooled connection built from the pool's own settings (its
 * connection string and TLS options: the same server, role and certificate rules), and the
 * caller AWAITS it. `pg_cancel_backend` has returned once the backend has been signalled, so a
 * caller that awaits this before giving its connection up knows no cancel is still in flight;
 * a caller that sent one destroys its connection rather than return it to the pool (the
 * backend's cancel is processed at its next interrupt check, which may still be pending).
 *
 * Bounded by `timeoutMs` (connect and statement both): a cancel that cannot be sent in time
 * resolves `false` rather than hang the caller's release. Never throws.
 */
export const CANCEL_BACKEND_TIMEOUT_MS = 2_000;

/** What the cancel's own connection is built from: the pool's options (`pg.Pool#options`). */
export type CancelConnectionOptions = Pick<pg.PoolConfig, 'connectionString' | 'host' | 'port' | 'user' | 'password' | 'database' | 'ssl' | 'application_name'>;

/**
 * `pg_cancel_backend(pid)` on a connection of its own; true when the backend was signalled.
 * `options` is the pool's (`getPool().options`).
 */
export async function cancelBackend(pid: number, options: CancelConnectionOptions, timeoutMs: number = CANCEL_BACKEND_TIMEOUT_MS): Promise<boolean> {
  const client = new pg.Client({
    connectionString: options.connectionString,
    host: options.host,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    ssl: options.ssl,
    application_name: 'cancel-backend',
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
  });
  // An error after the answer (the connection ending under us) must not reach the process.
  client.on('error', () => undefined);
  try {
    await client.connect();
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_cancel_backend($1::int) AS ok', [pid]);
    return rows[0]?.ok === true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
