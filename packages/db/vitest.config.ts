import { defineConfig } from 'vitest/config';
import { decoratorTransform } from '../../tooling/vitest-decorator-transform.js';

export default defineConfig({
  plugins: [decoratorTransform()],
  test: {
    pool: 'forks',
    include: ['test/unit/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});
