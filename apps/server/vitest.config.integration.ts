import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';

// Real Postgres 5436 + Redis 6383 db 1. One database: files run serially.
export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['../../packages/db/test/helpers/global-setup.ts'],
    setupFiles: ['test/setup/integration-env.ts'],
  },
});
