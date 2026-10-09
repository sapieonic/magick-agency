import pg from 'pg';
import { logger } from '@magick-agency/observability';

/**
 * Takes its settings as an argument instead of importing the app config, because
 * this package must not depend on apps/server; and (decision Q1) TLS
 * verifies the server certificate by default (`buildSslOption`). The singleton shape
 * (initDbPool / getPool / closePool) means repositories just call `getPool()`.
 */
const { Pool } = pg;

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
    max: opts.poolMax ?? 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Decision Q1: verified by default; see `buildSslOption`.
    ssl: buildSslOption(opts),
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected database pool error');
  });

  pool.on('connect', () => {
    logger.debug('New database connection established');
  });

  return pool;
}

export function getPool(): pg.Pool {
  if (!pool) throw new Error('Database pool not initialized. Call initDbPool first.');
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
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
