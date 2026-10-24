import pg from 'pg';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';

/**
 * The pool the PRODUCT runs on in the load suites, sized like production's
 * (`poolMax` 10, `config/blocks/base.ts`). The 5-connection test pool would make
 * the pool itself the bottleneck of a hundred-agent floor and turn every latency
 * in the run into a queueing artefact.
 *
 * Its own module, with nothing but `pg` behind it, because the suites hand it to
 * the product from a `vi.mock('@magick-agency/db', …)` factory: a factory that
 * imported the floor harness would load half the test graph before the mock
 * existed.
 */
let pool: pg.Pool | null = null;

export function floorPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 10 });
  return pool;
}

export async function closeFloorPool(): Promise<void> {
  const p = pool;
  pool = null;
  await p?.end();
}
