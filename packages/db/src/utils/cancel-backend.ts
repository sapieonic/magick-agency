import pg from 'pg';

/**
 * Cancel the statement running on one backend, over a connection of its own.
 *
 * ── Why not `pool.query('SELECT pg_cancel_backend($1)')` ─────────────────────
 * Through the shared pool the cancel WAITS behind every other borrower when the pool is busy,
 * which is exactly when it matters, so the statement it means to stop runs on. So it goes on a
 * fresh, unpooled connection built from the pool's own settings (its connection string and TLS
 * options: the same server, role and certificate rules). `pg_cancel_backend` has returned once the
 * backend has been signalled. Why the caller awaits it and then destroys its connection:
 * `cancellable-read.ts`, whose readers (Compare agents' read, the report cursor) are its callers.
 *
 * ── Which pid ───────────────────────────────────────────────────────────────
 * The pid MUST be the backend's own, read with `pg_backend_pid()` on the connection whose statement
 * is to be stopped (each reader reads it in a statement it already sends), never `client.processID`. `processID` is what the
 * server sent in BackendKeyData at connect, and behind a pooler that is the POOLER's number: the
 * Supabase session pooler (the deployment default, DEPLOYMENT.md "Which connection string")
 * sends an integer of its own, which is not a Postgres pid, so `pg_cancel_backend` on it signals
 * nothing or, by chance, another backend of the same role. `pg_backend_pid()` is the real pid
 * through a session pooler (each client connection keeps one Postgres connection for its life) and
 * on a direct connection alike, and this connection reaches the same database as the same role, so
 * `pg_cancel_backend` may signal it. The protocol's own CancelRequest (`processID` and the secret
 * key, what `pg`'s `Client#cancel` sends) is not used: it depends on the pooler forwarding cancel
 * requests, and `pg` sends it without TLS.
 *
 * ── Bounds ──────────────────────────────────────────────────────────────────
 * The connect, the statement and the connection's end are each bounded by `timeoutMs`, so a
 * cancel settles within about three times that even when the server does not answer; a cancel
 * that cannot be sent in time resolves `false` rather than hang the caller's release. It never
 * throws and never rejects: building the connection (`options` may be a function, read inside,
 * so a pool that is not there is a `false` too), connecting, the statement and the end are all
 * inside it.
 */
export const CANCEL_BACKEND_TIMEOUT_MS = 2_000;

/** What the cancel's own connection is built from: the pool's options (`pg.Pool#options`). */
export type CancelConnectionOptions = Pick<pg.PoolConfig, 'connectionString' | 'host' | 'port' | 'user' | 'password' | 'database' | 'ssl' | 'application_name'>;

/**
 * `pg_cancel_backend(pid)` on a connection of its own; true when the backend was signalled.
 * `options` is the pool's (`getPool().options`), or a function that returns them.
 */
export async function cancelBackend(
  pid: number,
  options: CancelConnectionOptions | (() => CancelConnectionOptions),
  timeoutMs: number = CANCEL_BACKEND_TIMEOUT_MS,
): Promise<boolean> {
  let client: pg.Client | null = null;
  try {
    const o = typeof options === 'function' ? options() : options;
    client = new pg.Client({
      connectionString: o.connectionString,
      host: o.host,
      port: o.port,
      user: o.user,
      password: o.password,
      database: o.database,
      ssl: o.ssl,
      application_name: 'cancel-backend',
      connectionTimeoutMillis: timeoutMs,
      query_timeout: timeoutMs,
    });
    // An error after the answer (the connection ending under us) must not reach the process.
    client.on('error', () => undefined);
    await client.connect();
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_cancel_backend($1::int) AS ok', [pid]);
    return rows[0]?.ok === true;
  } catch {
    return false;
  } finally {
    if (client !== null) {
      try {
        await endWithin(client, timeoutMs);
      } catch {
        // Never thrown to the caller: the answer above stands.
      }
    }
  }
}

/** `client.end()`, or the socket destroyed when the end does not finish in `ms`. */
async function endWithin(client: pg.Client, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), ms);
    timer.unref();
  });
  try {
    const out = await Promise.race([client.end().then(() => 'ended' as const, () => 'ended' as const), late]);
    if (out === 'late') (client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
  } finally {
    clearTimeout(timer);
  }
}
