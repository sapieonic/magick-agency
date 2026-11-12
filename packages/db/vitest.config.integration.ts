import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';
import { testWorkers } from '../../tooling/test-env.js';

// Real Postgres on 5436 (docker/docker-compose.dev.yml). Files run in parallel, each on
// its worker's own copy of the migrated test database (`<db>_w<N>`, made afresh before
// each file by `test/helpers/worker-env.ts`), so one file's `truncateAll` never reaches
// another's rows and no file sees what another left. TEST_WORKERS=1 runs files one at a time.
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
