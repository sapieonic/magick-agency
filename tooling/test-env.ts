import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

/**
 * Per-checkout test targets.
 *
 * Every git worktree of this repo shares the one agency Postgres (5436) and
 * Redis (6383). Two worktrees running integration suites against the same
 * database truncate each other's rows mid-run and manufacture confident,
 * wrong reds, so each worktree gets its own database and Redis db range via
 * an untracked `.test-env.local.json` at the repo root:
 *
 *   { "dbName": "magick_agency_test_lane_a", "redisDb": 5, "workers": 4 }
 *
 * Precedence: TEST_DB_URL / TEST_REDIS_URL / TEST_WORKERS env vars, then this
 * file, then the defaults (`magick_agency_test`, Redis db 1, up to 4 workers).
 * The guards in packages/db/test/helpers/test-db.ts and
 * apps/server/test/helpers/test-redis.ts still refuse anything that is not
 * agency's own port, a `magick_agency_test*` database, or a non-zero Redis db.
 *
 * Integration files run in parallel, one worker per file at a time, and each
 * worker has a database and a Redis db of its own ({@link workerTestTargets}):
 * worker N uses `<dbName>_w<N>`, cloned from the migrated `<dbName>` by the
 * global setup, and Redis db `redisDb + N - 1`. So a worktree owns the Redis
 * dbs `redisDb` to `redisDb + workers - 1`, and two worktrees that run
 * integration at the same time need ranges that do not overlap.
 */
interface LocalTestEnv {
  dbName?: string;
  redisDb?: number;
  workers?: number;
}

const REPO_ROOT = resolve(__dirname, '..');
const LOCAL_FILE = resolve(REPO_ROOT, '.test-env.local.json');

function readLocal(): LocalTestEnv {
  if (!existsSync(LOCAL_FILE)) return {};
  return JSON.parse(readFileSync(LOCAL_FILE, 'utf8')) as LocalTestEnv;
}

const local = readLocal();

export const DEFAULT_TEST_DB_URL = `postgresql://magick_agency:magick_agency_password@localhost:5436/${local.dbName ?? 'magick_agency_test'}`;
export const DEFAULT_TEST_REDIS_URL = `redis://localhost:6383/${local.redisDb ?? 1}`;

/** The highest Redis db index a test may use (Redis has 0-15; 0 is dev). */
export const MAX_TEST_REDIS_DB = 15;

/** Workers when neither TEST_WORKERS nor the local file names a count. */
const DEFAULT_MAX_WORKERS = 4;

/**
 * How many integration workers run at once: TEST_WORKERS, then `workers` in the
 * local file, then the machine's parallelism capped at 4. 1 runs files one at a time.
 */
export function testWorkers(env: NodeJS.ProcessEnv = process.env, file: LocalTestEnv = local): number {
  const raw = env['TEST_WORKERS'] ?? file.workers;
  if (raw === undefined || raw === '') return Math.max(1, Math.min(DEFAULT_MAX_WORKERS, availableParallelism()));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`TEST_WORKERS (or "workers" in .test-env.local.json) must be a positive integer, got "${raw}"`);
  return n;
}

/** The base targets: what a run uses before it is split into workers. */
export function baseTestTargets(env: NodeJS.ProcessEnv = process.env): { dbUrl: string; redisUrl: string } {
  return { dbUrl: env['TEST_DB_URL'] ?? DEFAULT_TEST_DB_URL, redisUrl: env['TEST_REDIS_URL'] ?? DEFAULT_TEST_REDIS_URL };
}

/** `<base>_w<worker>`: the database worker `worker` (1-based) owns. */
export function workerDbName(baseDbName: string, worker: number): string {
  return `${baseDbName}_w${worker}`;
}

/**
 * Worker `worker`'s (1-based, as Vitest's VITEST_POOL_ID) database and Redis db, derived
 * from the base targets. Throws when the worker is outside 1..workers or its Redis db
 * would pass {@link MAX_TEST_REDIS_DB}: it never wraps onto another worktree's db.
 */
export function workerTestTargets(
  base: { dbUrl: string; redisUrl: string },
  worker: number,
  workers: number,
): { dbUrl: string; redisUrl: string } {
  if (!Number.isInteger(worker) || worker < 1 || worker > workers) {
    throw new Error(`integration worker ${worker} is outside 1..${workers}; set TEST_WORKERS rather than --maxWorkers`);
  }
  const db = new URL(base.dbUrl);
  db.pathname = `/${workerDbName(db.pathname.replace(/^\//, ''), worker)}`;
  const redis = new URL(base.redisUrl);
  const first = Number(redis.pathname.replace(/^\//, '') || '0');
  const last = first + workers - 1;
  if (last > MAX_TEST_REDIS_DB) {
    throw new Error(
      `${workers} integration workers from Redis db ${first} need dbs ${first}-${last}, past ${MAX_TEST_REDIS_DB}; ` +
        'lower TEST_WORKERS or "redisDb" in .test-env.local.json',
    );
  }
  redis.pathname = `/${first + worker - 1}`;
  return { dbUrl: db.toString(), redisUrl: redis.toString() };
}
