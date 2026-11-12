import { baseTestTargets, testWorkers, workerTestTargets } from '../../../../tooling/test-env.js';

/**
 * The first setup file of every integration run (this package's and the server's), run
 * before each test file: points the Vitest worker at its own database and Redis db before
 * anything imports `test-db.ts` or `test-redis.ts` (which read TEST_DB_URL / TEST_REDIS_URL
 * once, at import), and makes that database afresh from the migrated base
 * (`worker-db.ts`). Files run in parallel, one per worker, so a file's `truncateAll` and
 * `FLUSHDB` reach only its own targets, and no file sees what an earlier one left behind.
 *
 * The base targets are kept in TEST_BASE_* on the first pass: should a worker process ever
 * run more than one file (Vitest's `isolate: false`), a later pass derives from the base
 * and not from the worker URL this one wrote.
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
// Imported only now: worker-db.ts imports test-db.ts, which reads TEST_DB_URL once, and the
// test file shares that module. A static import would have fixed it to the base.
const { recreateWorkerDatabase } = await import('./worker-db.js');
await recreateWorkerDatabase(base.dbUrl, worker);
