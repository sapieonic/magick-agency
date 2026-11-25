/**
 * The e2e package's own unit tests (`pnpm test`): the simulator, the preload and the guards,
 * checked against the real SDKs the server uses. They need no stack, so regular CI runs them;
 * the Playwright suite itself runs only through `pnpm e2e`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
