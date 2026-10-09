/**
 * PORT NOTE (magick-agency): stands in for core's `test/integration/setup/test-utils.ts`
 * so ported agency suites keep their `../setup/test-utils.js` import. The pool, its
 * safety guard and the truncate are the agency harness in packages/db
 * (`test/helpers/test-db.ts`: Postgres 5436, `magick_agency_test*` only). Same shape
 * as packages/db/test/integration/setup/test-utils.ts.
 */
import {
  closeTestPool, getTestPool, truncateAll as truncateAllTables,
} from '../../../../../packages/db/test/helpers/test-db.js';

export { closeTestPool, getTestPool };

/** Takes no argument: suites pass it straight to a hook (`beforeEach(truncateAll)`). */
export async function truncateAll(): Promise<void> {
  await truncateAllTables();
}

// Redis helpers (core's test-utils exported them too): agency test Redis, 6383 db 1+.
export { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
