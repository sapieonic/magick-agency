import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Per-checkout test targets.
 *
 * Every git worktree of this repo shares the one agency Postgres (5436) and
 * Redis (6383). Two worktrees running integration suites against the same
 * database truncate each other's rows mid-run and manufacture confident,
 * wrong reds, so each worktree gets its own database and Redis db index via
 * an untracked `.test-env.local.json` at the repo root:
 *
 *   { "dbName": "magick_agency_test_lane_a", "redisDb": 2 }
 *
 * Precedence: TEST_DB_URL / TEST_REDIS_URL env vars, then this file, then the
 * defaults (`magick_agency_test`, Redis db 1). The guards in
 * packages/db/test/helpers/test-db.ts and apps/server/test/helpers/test-redis.ts
 * still refuse anything that is not agency's own port, a `magick_agency_test*`
 * database, or a non-zero Redis db.
 */
interface LocalTestEnv {
  dbName?: string;
  redisDb?: number;
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
