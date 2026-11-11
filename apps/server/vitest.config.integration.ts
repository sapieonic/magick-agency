import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';
import { testWorkers } from '../../tooling/test-env.js';

/**
 * Files whose run time is real wall-clock waiting (about five minutes one after
 * another, about two in parallel): on Redis TTLs (fake timers cannot move a
 * server-side PTTL), or on a forked server's own liveness timers (the mobile stations file: the 10 s grace and the 8 s
 * deferred hangup, which have no overrides; the mobile inbound file: the 8 s deferred
 * hangup ending an inbound call). CI runs them as their own job beside the
 * rest: INTEGRATION_LANE=wall-clock runs only these, =rest runs everything else, unset
 * runs all.
 */
const WALL_CLOCK_FILES = [
  'test/integration/agency/agency-lease-ring-duration.test.ts',
  'test/integration/agency/chaos/lease-renewer-killed.test.ts',
  'test/integration/cluster/mobile-stations.test.ts',
  'test/integration/telephony/inbound-wrapup-lease.test.ts',
  'test/integration/telephony/inbound-mobile-wall-clock.test.ts',
];

const lane = process.env['INTEGRATION_LANE'] || undefined;
if (lane !== undefined && lane !== 'wall-clock' && lane !== 'rest') {
  throw new Error(`INTEGRATION_LANE must be "wall-clock" or "rest", got "${lane}"`);
}

/**
 * Real Postgres 5436 + Redis 6383. Files run in parallel, each worker on a database and a
 * Redis db of its own (`tooling/test-env.ts`): the global setup migrates the base test
 * database and copies it once per worker, `worker-env.ts` points the worker at its copy
 * and its Redis db before anything imports the test helpers. TEST_WORKERS=1 runs files
 * one at a time, as this suite did before.
 */
const workers = testWorkers();

export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    fileParallelism: workers > 1,
    maxWorkers: workers,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    include: lane === 'wall-clock' ? WALL_CLOCK_FILES : ['test/integration/**/*.test.ts'],
    exclude: lane === 'rest' ? ['**/node_modules/**', ...WALL_CLOCK_FILES] : ['**/node_modules/**'],
    globalSetup: ['test/setup/integration-global-setup.ts'],
    // worker-env first: integration-env imports the helpers that read TEST_DB_URL once.
    setupFiles: ['../../packages/db/test/helpers/worker-env.ts', 'test/setup/integration-env.ts'],
  },
});
