/**
 * The golden e2e suite. Run it with `pnpm e2e` from the repo root, which brings the whole
 * simulated stack up first (src/run.ts); a bare `playwright test` refuses to run without it.
 */
import { defineConfig } from '@playwright/test';
import { urls } from './src/env.js';

if (process.env['E2E_STACK'] !== 'up') {
  throw new Error('Run the suite with `pnpm e2e` (it starts the stack), or set E2E_STACK=up against `pnpm --filter @magick-agency/e2e stack`.');
}

export default defineConfig({
  testDir: './specs',
  // One server, one station per agent, wall-clock dialer timers: specs run one at a time. Each
  // seeds a tenant of its own, so order does not matter and any spec runs alone.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: process.env['CI'] ? 1 : 0,
  // A stray test.only must not turn a workflow run green on one spec.
  forbidOnly: !!process.env['CI'],
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }], ['json', { outputFile: 'test-results/results.json' }]],
  outputDir: 'test-results',
  use: {
    baseURL: urls.console,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['microphone'],
    launchOptions: {
      // A fake microphone (a beeping tone) and no permission prompt: the station's audio path
      // runs for real, and the simulated carrier hears the agent.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
