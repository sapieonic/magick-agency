import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';
import {
  DB_CONNECTION_HEADROOM,
  analysisChildDbPoolMax,
  judgeDbConnectionBudget,
  planDbConnections,
  readDbConnectionBudget,
} from '../../../src/cluster/db-connection-budget.js';

/*
 * Every process on the host opens its own pg pool, so the host's connections are the sum.
 * The primary adds them up at boot and compares them with the server's max_connections
 * (logged and reported, never refused: docs/decisions.md).
 */
const env = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const result = parseConfig({ ...env, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.config;
}

describe('the host\'s Postgres connection budget', () => {
  it('MEDIA_WORKER_DB_POOL_MAX: 10 by default, env-configurable, never 0', () => {
    expect(parse().processes.mediaWorkerDbPoolMax).toBe(10);
    expect(parse({ MEDIA_WORKER_DB_POOL_MAX: '6' }).processes.mediaWorkerDbPoolMax).toBe(6);
    expect(parseConfig({ ...env, MEDIA_WORKER_DB_POOL_MAX: '0' }).ok).toBe(false);
  });

  it('an analysis worker\'s pool is its slots plus two, never more than DB_POOL_MAX', () => {
    expect(analysisChildDbPoolMax(30, 8)).toBe(10);
    expect(analysisChildDbPoolMax(30, 256)).toBe(30);
  });

  it('adds up the pools of the processes that run: the documented 500-call host fits the default 100', () => {
    const config = parse({ DIALER_ANALYSIS_ENABLED: 'true', ANALYSIS_WORKERS: '2', MEDIA_WORKERS: '3' });
    const plan = planDbConnections(config, { mediaWorkers: 3, analysisWorkers: 2 });
    // 30 (primary) + 3 × 10 (media) + 2 × (8 + 2) (analysis)
    expect(plan).toMatchObject({ primary: 30, perMediaWorker: 10, perAnalysisWorker: 10, total: 80 });
    expect(judgeDbConnectionBudget(plan, 100, 3).fits).toBe(true);
  });

  it('the media workers\' share comes from MEDIA_WORKER_DB_POOL_MAX, not DB_POOL_MAX', () => {
    const plan = planDbConnections(parse({ MEDIA_WORKERS: '3' }), { mediaWorkers: 3, analysisWorkers: 0 });
    expect(plan.total).toBe(30 + 3 * 10);
    const wide = planDbConnections(parse({ MEDIA_WORKERS: '3', MEDIA_WORKER_DB_POOL_MAX: '30' }), { mediaWorkers: 3, analysisWorkers: 0 });
    expect(wide.total).toBe(120);
  });

  it('does not fit once the sum plus the headroom passes max_connections less the reserved slots', () => {
    const plan = planDbConnections(parse({ MEDIA_WORKER_DB_POOL_MAX: '30' }), { mediaWorkers: 3, analysisWorkers: 0 });
    expect(plan.total).toBe(120);
    expect(judgeDbConnectionBudget(plan, 100, 3).fits).toBe(false);
    // The boundary: exactly total + headroom allowed.
    expect(judgeDbConnectionBudget(plan, 120 + DB_CONNECTION_HEADROOM + 3, 3).fits).toBe(true);
    expect(judgeDbConnectionBudget(plan, 120 + DB_CONNECTION_HEADROOM + 2, 3).fits).toBe(false);
  });

  it('reads the server\'s limits; an unreadable answer is null, not a verdict', async () => {
    const plan = planDbConnections(parse(), { mediaWorkers: 1, analysisWorkers: 0 });
    const budget = await readDbConnectionBudget(async () => ({ rows: [{ max: 100, reserved: 3 }] }), plan);
    expect(budget).toMatchObject({ total: 40, maxConnections: 100, reserved: 3, fits: true });
    expect(await readDbConnectionBudget(async () => ({ rows: [] }), plan)).toBeNull();
  });
});
