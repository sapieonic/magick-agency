/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pinned on the MAIN thread (as in the console's vite config): a TZ set
// inside a worker changes process.env and nothing about new Date().
if (process.env['VITEST']) process.env['TZ'] = 'UTC';

// The super-admin's own release version (release-please, docs/operations.md), shown at the
// foot of the sidebar.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**'],
    setupFiles: ['./src/__tests__/setup.ts'],
    env: { TZ: 'UTC' },
  },
  server: {
    port: 5176,
    proxy: {
      // The API serves `/super-admin/*` (decision B16); UI routes sit at the
      // root, so there is no collision with a page reload.
      '/super-admin': { target: 'http://localhost:3021', changeOrigin: true },
    },
  },
});
