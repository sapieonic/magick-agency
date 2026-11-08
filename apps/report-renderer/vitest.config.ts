import { defineConfig } from 'vitest/config';

// PDF tests launch Chromium (found by `findChrome`), so they get a longer timeout than the
// default; they run in one fork at a time to keep the shared machine's CPU for the others.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
