import { closeTestPool, getTestPool, truncateAll as truncateAllTables } from '../../helpers/test-db.js';

/**
 * PORT NOTE (magick-agency): stands in for core's
 * `test/integration/setup/test-utils.ts` so ported integration suites keep their
 * `../setup/test-utils.js` import. The pool, its safety guard and the truncate
 * are the agency harness (`test/helpers/test-db.ts`: Postgres 5436,
 * `magick_agency_test` only). Redis helpers live in
 * `apps/server/test/helpers/test-redis.ts`; no `packages/db` suite uses Redis.
 */
export { closeTestPool, getTestPool };

/**
 * Core's `truncateAll()` takes no argument, and suites pass it straight to a
 * hook (`beforeEach(truncateAll)`), where Vitest hands it the test context. The
 * harness's version takes an optional client, so it is wrapped rather than
 * re-exported: the context must never be mistaken for a pool.
 */
export async function truncateAll(): Promise<void> {
  await truncateAllTables();
}
