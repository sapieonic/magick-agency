/// <reference types="vitest/config" />
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadBrandConfig, injectBrandName } from './src/brand/load-brand';
import type { Brand } from './src/brand/types';

/*
 * Vite config: the TZ pin, the brand plugin and defines, and the
 * unit/timezone project split. The dev port is 5175, the dev proxy targets the
 * agency server on 3021 (see `API_PREFIXES`), a locale pin sits beside the TZ
 * pin, and the pool is `forks` (for that pin). There are no manual chunks for
 * heavy libraries, since the console does not ship any.
 */

/**
 * The suite's timezone, pinned before anything reads a clock.
 *
 * Node applies a `TZ` change only when it is assigned on a process's MAIN
 * thread — that is the only place the assignment reaches `tzset` and V8's date
 * cache. A `TZ` set from inside a worker (which is what `test.env` and
 * `setupFiles` both are) updates `process.env` and changes nothing about what
 * `new Date()` does. Vitest loads this config on that main thread, before any
 * worker exists, so an assignment here is the one that takes.
 *
 * Guarded on `VITEST` so `vite dev` and `vite build` keep the operator's own
 * clock.
 */
if (process.env['VITEST']) process.env['TZ'] = 'UTC';
/*
 * The LOCALE, pinned the same way. The suite
 * assumes en-US number and date formatting (`1,000,000`, `Aug 19`) and its CI ran
 * in that locale; on a machine whose `LANG` is `en_IN` ICU renders `10,00,000`
 * and `19 Aug`. ICU reads the locale once per PROCESS, at start, so this reaches
 * only workers spawned after it — which is why the pool below is `forks`.
 */
if (process.env['VITEST']) {
  process.env['LANG'] = 'en_US.UTF-8';
  process.env['LC_ALL'] = 'en_US.UTF-8';
}


const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BRANDS_DIR = resolve(ROOT, 'brands');
const BRAND_NAME = process.env.VITE_BRAND ?? 'magick-agency';
const brand: Brand = loadBrandConfig(BRANDS_DIR, BRAND_NAME);

/** Rewrites %BRAND_NAME% placeholders in index.html with the active brand's name. */
function brandPlugin(b: Brand): Plugin {
  return {
    name: 'brand-inject',
    transformIndexHtml(html) {
      return injectBrandName(html, b.name);
    },
  };
}

/**
 * Every prefix the console calls on the agency server — the paths
 * are unchanged (decision B16) — proxied in dev so the browser talks to ONE origin.
 * `ws: true` on `/proxy` carries the station socket.
 */
const API_PREFIXES = [
  '/auth',
  '/accounts',
  '/tenants',
  '/users',
  '/invites',
  '/notifications',
  '/feature-flags',
  '/proxy',
  '/dnc',
  // The caller-ID picker's `GET /phone-numbers`; without it the
  // dev server's SPA fallback answered it with index.html. Pinned by devProxyPrefixes.test.ts.
  '/phone-numbers',
];

export default defineConfig({
  plugins: [react(), brandPlugin(brand)],
  // The active brand's optional static assets (`brands/<id>/public/`), served at
  // the site root. The default
  // `magick-agency` pack ships none (decision B17), so the directory is used only when it exists; `false` turns
  // public-dir copying off instead of pointing Vite at a missing folder.
  publicDir: existsSync(resolve(BRANDS_DIR, BRAND_NAME, 'public'))
    ? resolve(BRANDS_DIR, BRAND_NAME, 'public')
    : false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BRAND__: JSON.stringify(brand),
  },
  test: {
    environment: 'happy-dom',
    /**
     * Two projects, split entirely by the timezone pin above: `timezone` holds
     * the files that are ABOUT a zone and must be able to leave UTC, which needs
     * `pool: 'forks'` (a zone switch inside a thread is a no-op). The two
     * `include`/`exclude` sets are complementary on purpose: a file must run in
     * exactly one project, or every count is doubled. `include` is declared per
     * project and NOT at this level, for the same reason.
     */
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
          exclude: [
            '**/node_modules/**',
            'src/**/*.timezone.test.ts',
            'src/**/*.timezone.test.tsx',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'timezone',
          include: ['src/**/*.timezone.test.ts', 'src/**/*.timezone.test.tsx'],
          pool: 'forks',
        },
      },
    ],
    /**
     * `forks` rather than `threads`. A worker
     * thread shares its parent's ICU, initialised before this config could pin
     * the locale above; a forked child starts with the pinned environment, so a
     * bare `npx vitest run` formats in en-US on any machine. Costs wall time over
     * `threads` (roughly 2x when measured; machine-dependent). Do **not** set `isolate: false`: shared
     * `vi.mock` state contaminates later files.
     */
    pool: 'forks',
    maxWorkers: '100%',
    fileParallelism: true,
    /** Registers the global `afterEach(cleanup)` — see `src/__tests__/setup.ts`. */
    setupFiles: ['./src/__tests__/setup.ts'],
    env: { TZ: 'UTC' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/firebase/')) return 'firebase';
          if (id.includes('/posthog-js/')) return 'posthog';
          if (
            id.includes('/react/') ||
            id.includes('/react-dom/') ||
            id.includes('/react-router-dom/')
          ) return 'react';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5175,
    proxy: Object.fromEntries(
      API_PREFIXES.map((prefix) => [
        prefix,
        { target: 'http://localhost:3021', changeOrigin: true, ws: prefix === '/proxy' },
      ]),
    ),
  },
});
