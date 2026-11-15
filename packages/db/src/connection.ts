import pg from 'pg';
import { logger } from '@magick-agency/observability';
import { bindPoolConnectContext } from '@magick-agency/observability/trace-context';
import { observeDbPoolAcquire, setDbPoolStatsProvider } from '@magick-agency/observability/metrics/shared';

/**
 * Takes its settings as an argument instead of importing the app config, because
 * this package must not depend on apps/server; and (decision Q1) TLS
 * verifies the server certificate by default (`buildSslOption`). The singleton shape
 * (initDbPool / getPool / closePool) means repositories just call `getPool()`.
 */
const { Pool } = pg;

/**
 * Pool size when the caller passes none. The server passes `DB_POOL_MAX` (the base config
 * block's default is the same 30, with the sizing); the migration CLI and scripts take this.
 */
export const DEFAULT_DB_POOL_MAX = 30;

export interface DbPoolOptions {
  url: string;
  poolMin?: number;
  poolMax?: number;
  ssl?: boolean;
  /**
   * Decision Q1: verify the server certificate when `ssl` is on. Absent means
   * `true`; only an explicit `false` (`DB_SSL_REJECT_UNAUTHORIZED=false`) turns it off.
   */
  sslRejectUnauthorized?: boolean;
  /** PEM text of the CA that signed the server certificate (`DB_SSL_CA`); absent = Node's roots. */
  sslCa?: string;
  /**
   * Postgres `application_name` for every connection of this pool (1-63 plain characters), so
   * `pg_stat_activity` and the server log (`%a` in `log_line_prefix`) can tell the server, each
   * worker process, the migrations and scripts apart. Sent in the startup packet, as psql sends
   * its own, and set again by the connect hook (`sessionSettingsSql`).
   */
  applicationName?: string;
  /**
   * Session timeouts set on every new connection of this pool; see {@link DbSessionTimeouts}.
   * Those left out are RESET on connect, to the role's and database's values.
   */
  sessionTimeouts?: DbSessionTimeouts;
}

/**
 * Postgres session timeouts, in milliseconds; `0` or absent leaves the setting as the database
 * and role define it (`db-hygiene.md`, "5. Timeouts"). Set on each new connection before the
 * pool hands it out (pg-pool's `onConnect`), as plain SQL, so they hold through a session-mode
 * pooler that would not forward startup options. A transaction that needs more overrides one for
 * itself with `SET LOCAL`.
 *  - `statementTimeoutMs`: `statement_timeout`, a statement running longer is cancelled (57014);
 *  - `lockTimeoutMs`: `lock_timeout`, a lock not granted in time fails the statement (55P03);
 *  - `idleInTransactionTimeoutMs`: `idle_in_transaction_session_timeout`, a session idle inside an
 *    open transaction for longer is terminated, its locks released.
 */
export interface DbSessionTimeouts {
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

const SESSION_TIMEOUT_SETTINGS = [
  ['statement_timeout', 'statementTimeoutMs'],
  ['lock_timeout', 'lockTimeoutMs'],
  ['idle_in_transaction_session_timeout', 'idleInTransactionTimeoutMs'],
] as const satisfies ReadonlyArray<readonly [string, keyof DbSessionTimeouts]>;

/**
 * The SQL that puts `timeouts` on a session: `SET` for each one given, `RESET` for each left at 0
 * or absent. `RESET` returns a setting to what the role and database define, so 0 means exactly
 * "as the database defines it" even on a pooled Postgres connection that an earlier client left
 * a value on (a session-mode pooler is not known to clear session state between its clients).
 * Values are validated integers before they are written into the SQL.
 */
export function sessionTimeoutsSql(timeouts: DbSessionTimeouts | undefined): string {
  return SESSION_TIMEOUT_SETTINGS.map(([name, key]) => {
    const ms = timeouts?.[key];
    if (ms === undefined || ms === 0) return `RESET ${name}`;
    if (!Number.isInteger(ms) || ms < 0) throw new Error(`${key} must be a non-negative integer of milliseconds, got ${ms}`);
    return `SET ${name} = '${ms}ms'`;
  }).join('; ');
}

/** An `application_name` the settings SQL may carry: plain characters, at most 63 (Postgres's limit). */
const APPLICATION_NAME = /^[A-Za-z0-9_.:-]{1,63}$/;

/**
 * Everything a new connection of this pool gets before its first caller: `application_name`
 * again as SQL (it is also in the startup packet, but a session-mode pooler is not known to
 * forward that onto the Postgres connection it hands out), then `sessionTimeoutsSql`.
 */
export function sessionSettingsSql(applicationName: string | undefined, timeouts: DbSessionTimeouts | undefined): string {
  if (applicationName !== undefined && !APPLICATION_NAME.test(applicationName)) {
    throw new Error(`applicationName must be 1-63 letters, digits or _ . : -, got ${JSON.stringify(applicationName)}`);
  }
  const name = applicationName ? `SET application_name = '${applicationName}'; ` : '';
  return `${name}${sessionTimeoutsSql(timeouts)}`;
}

/**
 * The `onConnect` hook (`sessionSettingsSql`), one round trip per new connection. pg-pool awaits
 * it before handing the connection to its first caller, so the settings are in place for that
 * caller's first statement; a hook that fails ends the connection and fails that acquire, as a
 * failed connect does.
 */
export function sessionSettingsHook(
  applicationName: string | undefined,
  timeouts: DbSessionTimeouts | undefined,
): (client: pg.ClientBase) => Promise<void> {
  const sql = sessionSettingsSql(applicationName, timeouts);
  return async (client) => {
    await client.query(sql);
  };
}

/**
 * The `pg` `ssl` option for these settings.
 *
 * Decision Q1: the pool previously connected with
 * `{ rejectUnauthorized: false }`, so TLS encrypted the link but accepted ANY certificate:
 * anyone able to sit on the path to Postgres could present their own and read or rewrite
 * every query. The safe default is now to verify; a private CA is supplied with `sslCa`,
 * and the old behaviour needs an explicit `sslRejectUnauthorized: false`.
 *
 * Note: `pg` lets `sslmode` / `ssl*` parameters in the connection string REPLACE this
 * object (`connection-parameters.js`: the parsed URL is assigned over the config), so keep
 * TLS settings out of `DATABASE_URL`.
 */
export function buildSslOption(opts: Pick<DbPoolOptions, 'ssl' | 'sslRejectUnauthorized' | 'sslCa'>): pg.PoolConfig['ssl'] {
  if (!opts.ssl) return undefined;
  return {
    rejectUnauthorized: opts.sslRejectUnauthorized !== false,
    ...(opts.sslCa ? { ca: opts.sslCa } : {}),
  };
}

let pool: pg.Pool | null = null;

export function initDbPool(opts: DbPoolOptions): pg.Pool {
  if (pool) return pool;

  pool = new Pool({
    connectionString: opts.url,
    min: opts.poolMin ?? 2,
    max: opts.poolMax ?? DEFAULT_DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Decision Q1: verified by default; see `buildSslOption`.
    ssl: buildSslOption(opts),
    // TCP keepalive, first probe after 30 s idle, so a connection silently dropped on the network
    // path (a NAT or load balancer idle timeout) is found dead in minutes rather than after the
    // OS default of two hours (the probe interval and count stay the OS's).
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    ...(opts.applicationName ? { application_name: opts.applicationName } : {}),
    onConnect: sessionSettingsHook(opts.applicationName, opts.sessionTimeouts),
  });
  // Keeps a query that waited for a connection in its own trace; see bindPoolConnectContext.
  bindPoolConnectContext(pool);
  timePoolAcquire(pool);
  const max = pool.options.max ?? DEFAULT_DB_POOL_MAX;
  const p = pool;
  setDbPoolStatsProvider(() => ({ total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, max }));

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  // The clients a caller holds right now, from pg-pool's public 'acquire' and 'release' events.
  // 'connect' fires just before a new client's first 'acquire', so the listener below is in
  // place by then.
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('acquire', (client) => { checkedOut.add(client); });
  pool.on('release', (_err, client) => { checkedOut.delete(client); });

  pool.on('connect', (client) => {
    logger.debug('New database connection established');
    // pg-pool listens for a client's 'error' only while the client is idle and removes that
    // listener on checkout. A backend that ends under a checked-out client with no query in flight
    // (idle_in_transaction_session_timeout, pg_terminate_backend, a pooler restart) then emits
    // 'error' with no listener, which ends the process. With this one, the error is logged, the
    // holder's next query fails ("not queryable"), and pg-pool discards the client on release.
    // The listener stays for the client's life, so an 'error' never goes unheard, but it logs
    // only for a checked-out client: an idle one's error is pg-pool's idle listener's, which
    // removes the client and re-emits it on the pool ('Unexpected database pool error' above),
    // so a pooler restart that drops idle connections logs each one once, as a pool error.
    // Only a client's first error counts: pg reports an ended backend twice (the server's FATAL,
    // then the socket's end), and a client that errored is never used again.
    let ended = false;
    client.on('error', (err) => {
      if (ended) return;
      ended = true;
      if (checkedOut.has(client)) logger.warn({ err }, 'Database connection ended under its client');
    });
  });

  return pool;
}

/**
 * Time every acquire (`db_pool_acquire_seconds`): `pool.query` and `withTransaction` both go
 * through `pool.connect`, so wrapping the instance's `connect` (already the trace-binding
 * wrapper above) sees them all. Callback and promise forms, as pg calls both.
 */
function timePoolAcquire(target: pg.Pool): void {
  type Connect = (this: pg.Pool, cb?: (err: Error | undefined, client?: pg.PoolClient, done?: unknown) => void) => unknown;
  const inner = (target as unknown as { connect: Connect }).connect;
  const timed: Connect = function connect(this: pg.Pool, cb) {
    const startedAt = performance.now();
    const seconds = () => (performance.now() - startedAt) / 1000;
    if (typeof cb === 'function') {
      return inner.call(this, (err, client, done) => {
        observeDbPoolAcquire(seconds(), err ? 'error' : 'ok');
        cb(err, client, done);
      });
    }
    return (inner.call(this) as Promise<pg.PoolClient>).then(
      (client) => { observeDbPoolAcquire(seconds(), 'ok'); return client; },
      (err: unknown) => { observeDbPoolAcquire(seconds(), 'error'); throw err; },
    );
  };
  (target as unknown as { connect: Connect }).connect = timed;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialized. Call initDbPool first.');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    setDbPoolStatsProvider(null);
    await pool.end();
    pool = null;
    logger.info('Database pool closed');
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    try {
      await client.query('SELECT 1');
      return true;
    } finally {
      client.release();
    }
  } catch {
    return false;
  }
}
