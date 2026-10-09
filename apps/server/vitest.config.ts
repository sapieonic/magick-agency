import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';

export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    // `exclude` REPLACES vitest's defaults; keep the `**/` prefix on node_modules.
    exclude: ['test/integration/**', 'test/chaos/**', '**/node_modules/**'],
    setupFiles: ['test/setup/unit-env.ts'],
  },
});
