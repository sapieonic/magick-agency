/**
 * Postgres connections for the whole host (`docs/scaling.md` §8, `docs/operations.md`,
 * "Sizing the media workers").
 *
 * Every process opens its own pg pool: the primary's is `DB_POOL_MAX`, each media
 * worker's `MEDIA_WORKER_DB_POOL_MAX`, each analysis worker's {@link analysisChildDbPoolMax}.
 * Pools start empty and grow under load (`poolMin` is 0 in the children), so a host whose
 * sum exceeds the server's `max_connections` boots and runs fine until a peak, when new
 * connections are refused (`53300 too_many_connections`) in whichever process asked last.
 * The primary therefore adds the pools up at boot and compares the sum with the server.
 *
 * It does not refuse to boot (a default pending Manas, `docs/decisions.md`): the limit
 * belongs to the database, which can be raised without a deploy, and a server that refuses
 * to start is a worse outage than one that may queue at a peak. It logs an error, exports
 * both numbers as gauges and shows them in `/readyz?detail=1`.
 */
import type { AppConfig } from '../config/index.js';

/**
 * Connections kept free beyond the host's pools: a migration run, the super-admin CLI, an
 * operator's `psql`, a monitoring agent.
 */
export const DB_CONNECTION_HEADROOM = 5;

/** An analysis worker's pool: a slot holds a connection only for a claim, a heartbeat or the final transaction. */
export function analysisChildDbPoolMax(poolMax: number, concurrency: number): number {
  return Math.min(poolMax, concurrency + 2);
}

export interface DbConnectionPlan {
  primary: number;
  mediaWorkers: number;
  perMediaWorker: number;
  analysisWorkers: number;
  perAnalysisWorker: number;
  /** The most connections the host's processes can open together. */
  total: number;
}

/** The host's pools added up, for the processes this primary actually runs. */
export function planDbConnections(
  config: Pick<AppConfig, 'db' | 'processes' | 'dialerAnalysis'>,
  running: { mediaWorkers: number; analysisWorkers: number },
): DbConnectionPlan {
  const primary = config.db.poolMax;
  const perMediaWorker = config.processes.mediaWorkerDbPoolMax;
  const perAnalysisWorker = config.dialerAnalysis
    ? analysisChildDbPoolMax(config.db.poolMax, config.dialerAnalysis.concurrency)
    : 0;
  return {
    primary,
    mediaWorkers: running.mediaWorkers,
    perMediaWorker,
    analysisWorkers: running.analysisWorkers,
    perAnalysisWorker,
    total: primary + running.mediaWorkers * perMediaWorker + running.analysisWorkers * perAnalysisWorker,
  };
}

export interface DbConnectionBudget extends DbConnectionPlan {
  /** The server's `max_connections`. */
  maxConnections: number;
  /** `superuser_reserved_connections`: slots an ordinary role can never take. */
  reserved: number;
  /** True when `total + DB_CONNECTION_HEADROOM ≤ maxConnections − reserved`. */
  fits: boolean;
}

/** Compare a plan with what the server allows. */
export function judgeDbConnectionBudget(plan: DbConnectionPlan, maxConnections: number, reserved: number): DbConnectionBudget {
  return { ...plan, maxConnections, reserved, fits: plan.total + DB_CONNECTION_HEADROOM <= maxConnections - reserved };
}

type Query = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

/** Read the server's limits and judge the plan; null when they cannot be read. */
export async function readDbConnectionBudget(query: Query, plan: DbConnectionPlan): Promise<DbConnectionBudget | null> {
  const { rows } = await query(
    "SELECT current_setting('max_connections')::int AS max, current_setting('superuser_reserved_connections')::int AS reserved",
  );
  const max = Number(rows[0]?.['max']);
  const reserved = Number(rows[0]?.['reserved'] ?? 0);
  if (!Number.isFinite(max) || max <= 0) return null;
  return judgeDbConnectionBudget(plan, max, Number.isFinite(reserved) ? reserved : 0);
}
