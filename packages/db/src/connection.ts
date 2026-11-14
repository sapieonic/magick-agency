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
   * Postgres `application_name` for every connection of this pool (at most 63 bytes), so
   * `pg_stat_activity` and `pg_stat_statements` can tell the server, each worker process, the
   * migrations and scripts apart. Sent in the startup packet, as psql sends its own.
   */
  applicationName?: string;
  /** Session timeouts set on every new connection of this pool; see {@link DbSessionTimeouts}. */
  sessionTimeouts?: DbSessionTimeouts;
}

/**
 * Postgres session timeouts, in milliseconds; `0` or absent leaves the setting as the database
 * and role define it (`db-hygiene.md`, "Timeouts"). Set with `set_config` on each new connection
 * before the pool hands it out (pg-pool's `onConnect`), as plain SQL, so they hold through a
 * session-mode pooler that would not forward startup options. A transaction that needs more
 * overrides one for itself with `SET LOCAL`.
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
 * The `onConnect` hook for `timeouts`, or `undefined` when none is set: a pool with no timeouts
 * sends no extra statement on connect. pg-pool awaits the hook before handing the connection to
 * its first caller, so the settings are in place for that caller's first statement; a hook that
 * fails ends the connection and fails that acquire, as a failed connect does.
 */
export function sessionTimeoutsHook(timeouts: DbSessionTimeouts | undefined): ((client: pg.ClientBase) => Promise<void>) | undefined {
  const settings: Array<[string, string]> = [];
  for (const [name, key] of SESSION_TIMEOUT_SETTINGS) {
    const ms = timeouts?.[key];
    if (ms === undefined || ms === 0) continue;
    if (!Number.isInteger(ms) || ms < 0) throw new Error(`${key} must be a non-negative integer of milliseconds, got ${ms}`);
    settings.push([name, `${ms}ms`]);
  }
  if (settings.length === 0) return undefined;
  const sql = `SELECT ${settings.map((_, i) => `set_config($${2 * i + 1}, $${2 * i + 2}, false)`).join(', ')}`;
  const params = settings.flat();
  return async (client) => {
    await client.query(sql, params);
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
    onConnect: sessionTimeoutsHook(opts.sessionTimeouts),
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

  pool.on('connect', () => {
    logger.debug('New database connection established');
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
