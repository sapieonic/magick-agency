/**
 * Metric declarations owned by the shared infrastructure —
 * metrics emitted by a module that more than one area uses.
 */
import { meter } from '../meter.js';
import { counter, histogram, observableGauge } from '../metric-instruments.js';

// Written by `FeatureFlagService.recordEval`.
export const featureFlagEvaluationsTotal = counter<
  'flag' | 'result' | 'source'
>(meter, 'feature_flag_evaluations_total', {
  description: 'Feature flag evaluations by flag, result, and resolution source',
});

// ── Postgres pool (`packages/db/src/connection.ts`) ──────────────────────
// Every area queries through one pg pool (`DB_POOL_MAX`). Its saturation is invisible in
// any per-area series: a query that waited for a connection only shows as a slower handler.
// So the pool reports its own state: the acquire wait (every connection handed out, which
// catches bursts a sampled gauge misses), and the clients waiting, in use and idle at each
// export. Sustained `db_pool_clients_waiting > 0`, or an acquire p99 near the 5 s connect
// timeout, means `DB_POOL_MAX` binds.

/** Wired by `initDbPool`; cleared by `closePool`. */
let _dbPoolStatsProvider: (() => { total: number; idle: number; waiting: number; max: number }) | null = null;

export function setDbPoolStatsProvider(fn: (() => { total: number; idle: number; waiting: number; max: number }) | null): void {
  _dbPoolStatsProvider = fn;
}

observableGauge(meter, 'db_pool_clients_waiting', {
  description: 'Queries waiting for a Postgres pool connection (pg waitingCount)',
}, (observe) => {
  if (_dbPoolStatsProvider) observe(_dbPoolStatsProvider().waiting);
});
observableGauge(meter, 'db_pool_clients_total', {
  description: 'Postgres pool connections open, in use or idle (pg totalCount)',
}, (observe) => {
  if (_dbPoolStatsProvider) observe(_dbPoolStatsProvider().total);
});
observableGauge(meter, 'db_pool_clients_idle', {
  description: 'Postgres pool connections open and idle (pg idleCount)',
}, (observe) => {
  if (_dbPoolStatsProvider) observe(_dbPoolStatsProvider().idle);
});
observableGauge(meter, 'db_pool_clients_max', {
  description: 'Configured Postgres pool size (DB_POOL_MAX)',
}, (observe) => {
  if (_dbPoolStatsProvider) observe(_dbPoolStatsProvider().max);
});

const dbPoolAcquireSeconds = histogram<'result'>(meter, 'db_pool_acquire_seconds', {
  description: 'Seconds from asking the Postgres pool for a connection to getting one (or failing), by result',
  unit: 's',
  // Healthy is sub-millisecond; the top bucket is the pool's 5 s connect timeout.
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

/**
 * Record one pool acquire: `ok`, or `error` (the connect timeout, or a failed connect).
 * Guarded: it runs inside every query's connect, where a throw would fail the query.
 */
export function observeDbPoolAcquire(seconds: number, result: 'ok' | 'error'): void {
  try {
    dbPoolAcquireSeconds.observe({ result }, seconds);
  } catch {
    // Losing one sample beats failing the query it measures.
  }
}

// ── Postgres connections for the whole host (`cluster/db-connection-budget.ts`) ─────────
// With worker processes every process opens its own pool, so the host can open the SUM of
// their maxima. The primary computes that sum at boot and reads the server's limit;
// `db_connections_planned > db_connections_allowed` means a peak can be refused connections.
// Exported by the primary only, and only when worker processes are configured.

/** Wired by the primary at boot, with the numbers it computed once. */
let _dbConnectionBudgetProvider: (() => { planned: number; allowed: number }) | null = null;

export function setDbConnectionBudgetProvider(fn: (() => { planned: number; allowed: number }) | null): void {
  _dbConnectionBudgetProvider = fn;
}

observableGauge(meter, 'db_connections_planned', {
  description: 'Postgres connections this host\'s processes can open together: the sum of every process\'s pool maximum, plus the headroom kept for migrations and an operator',
}, (observe) => {
  if (_dbConnectionBudgetProvider) observe(_dbConnectionBudgetProvider().planned);
});
observableGauge(meter, 'db_connections_allowed', {
  description: 'Postgres connections the server allows an ordinary role: max_connections minus superuser_reserved_connections, read at boot',
}, (observe) => {
  if (_dbConnectionBudgetProvider) observe(_dbConnectionBudgetProvider().allowed);
});
