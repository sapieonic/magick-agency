/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/*
 * Test-only config: the package is never built on its own. Each app's Vite
 * build compiles these sources (and their CSS modules) as part of the app.
 *
 * TZ and the locale are pinned on the MAIN thread, as in the console's config:
 * a TZ set inside a worker changes process.env and nothing about `new Date()`,
 * and ICU reads the locale once per process (hence `forks`).
 */
if (process.env['VITEST']) {
  process.env['TZ'] = 'UTC';
  process.env['LANG'] = 'en_US.UTF-8';
  process.env['LC_ALL'] = 'en_US.UTF-8';
}

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    pool: 'forks',
    setupFiles: ['./test/setup.ts'],
    env: { TZ: 'UTC' },
  },
});
