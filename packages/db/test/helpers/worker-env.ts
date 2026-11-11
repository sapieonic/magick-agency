import { baseTestTargets, testWorkers, workerTestTargets } from '../../../../tooling/test-env.js';

/**
 * The first setup file of every integration run (this package's and the server's):
 * points this Vitest worker at its own database and Redis db before anything imports
 * `test-db.ts` or `test-redis.ts`, which read TEST_DB_URL / TEST_REDIS_URL once, at
 * import. Files run in parallel, one per worker, so a worker's `truncateAll` and
 * `FLUSHDB` reach only its own targets. The databases are cloned by `global-setup.ts`.
 *
 * A worker runs many files in one process, and this file runs before each, after it
 * has already overwritten TEST_DB_URL: the base targets are kept on the first pass, so
 * every later pass derives from the base and not from the previous worker URL.
 */
const base = baseTestTargets({
  TEST_DB_URL: process.env['TEST_BASE_DB_URL'] ?? process.env['TEST_DB_URL'],
  TEST_REDIS_URL: process.env['TEST_BASE_REDIS_URL'] ?? process.env['TEST_REDIS_URL'],
});
process.env['TEST_BASE_DB_URL'] = base.dbUrl;
process.env['TEST_BASE_REDIS_URL'] = base.redisUrl;

const worker = Number(process.env['VITEST_POOL_ID'] ?? '1');
const targets = workerTestTargets(base, worker, testWorkers());
process.env['TEST_DB_URL'] = targets.dbUrl;
process.env['TEST_REDIS_URL'] = targets.redisUrl;
