import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';
import { testWorkers } from '../../tooling/test-env.js';

// Real Postgres on 5436 (docker/docker-compose.dev.yml). Files run in parallel, each
// worker on its own copy of the migrated test database (`<db>_w<N>`, made by the
// global setup; `test/helpers/worker-env.ts` points the worker at it), so one file's
// `truncateAll` never reaches another's rows. TEST_WORKERS=1 runs files one at a time.
const workers = testWorkers();

export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    fileParallelism: workers > 1,
    maxWorkers: workers,
    hookTimeout: 60_000,
    testTimeout: 20_000,
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    setupFiles: ['test/helpers/worker-env.ts'],
  },
});
