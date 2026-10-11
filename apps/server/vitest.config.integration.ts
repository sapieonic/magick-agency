import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';

/**
 * Files whose run time is real wall-clock waiting on Redis TTLs (fake timers cannot
 * move a server-side PTTL), about three minutes between them. CI runs them as their
 * own job beside the rest: INTEGRATION_LANE=wall-clock runs only these, =rest runs
 * everything else, unset runs all.
 */
const WALL_CLOCK_FILES = [
  'test/integration/agency/agency-lease-ring-duration.test.ts',
  'test/integration/agency/chaos/lease-renewer-killed.test.ts',
];

const lane = process.env['INTEGRATION_LANE'] || undefined;
if (lane !== undefined && lane !== 'wall-clock' && lane !== 'rest') {
  throw new Error(`INTEGRATION_LANE must be "wall-clock" or "rest", got "${lane}"`);
}

// Real Postgres 5436 + Redis 6383 db 1. One database: files run serially.
export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    include: lane === 'wall-clock' ? WALL_CLOCK_FILES : ['test/integration/**/*.test.ts'],
    exclude: lane === 'rest' ? ['**/node_modules/**', ...WALL_CLOCK_FILES] : ['**/node_modules/**'],
    globalSetup: ['../../packages/db/test/helpers/global-setup.ts'],
    setupFiles: ['test/setup/integration-env.ts'],
  },
});
