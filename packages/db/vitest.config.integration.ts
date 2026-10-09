import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';

// Real Postgres on 5436 (docker/docker-compose.dev.yml). One database, so files
// run one at a time: a second concurrent run truncates under the first and
// manufactures confident, wrong reds.
export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
  },
});
