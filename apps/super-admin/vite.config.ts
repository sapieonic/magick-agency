/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pinned on the MAIN thread (as in the console's vite config): a TZ set
// inside a worker changes process.env and nothing about new Date().
if (process.env['VITEST']) process.env['TZ'] = 'UTC';

export default defineConfig({
  plugins: [react()],
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
