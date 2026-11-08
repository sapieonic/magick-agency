/**
 * Finding and launching headless Chromium for the PDF path (`puppeteer-core`, which ships no
 * browser). The Lambda launches `@sparticuz/chromium` through its own `launch` option
 * (`src/lambda/chromium.ts`); everything else finds a local Chrome here.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';

/** Where Playwright installs its Chromium builds (`chromium-<rev>/chrome-linux*\/chrome`). */
const PLAYWRIGHT_BROWSERS = '/opt/pw-browsers';
const SYSTEM_CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

export interface ChromeDiscoveryDeps {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  list: (dir: string) => string[];
}

const realDeps: ChromeDiscoveryDeps = {
  env: process.env,
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

/**
 * The Chrome to launch, first match wins: `AGENCY_REPORTS_CHROME_PATH`, `CHROME_PATH`, the newest
 * Playwright Chromium under `/opt/pw-browsers`, then the usual system paths (GitHub's Ubuntu
 * runners ship `/usr/bin/google-chrome`). Null when there is none; an env path that does not exist
 * is skipped rather than trusted.
 */
export function findChrome(deps: ChromeDiscoveryDeps = realDeps): string | null {
  for (const name of ['AGENCY_REPORTS_CHROME_PATH', 'CHROME_PATH']) {
    const p = deps.env[name];
    if (p && deps.exists(p)) return p;
  }
  const revisions = deps
    .list(PLAYWRIGHT_BROWSERS)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const rev of revisions) {
    for (const platform of deps.list(join(PLAYWRIGHT_BROWSERS, rev)).filter((d) => d.startsWith('chrome-linux')).sort()) {
      const p = join(PLAYWRIGHT_BROWSERS, rev, platform, 'chrome');
      if (deps.exists(p)) return p;
    }
  }
  for (const p of SYSTEM_CHROMES) if (deps.exists(p)) return p;
  return null;
}

/** Flags for a container: no sandbox (no user namespaces), no /dev/shm reliance, no GPU. */
export const CHROME_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none', '--no-first-run', '--no-zygote'];

export interface ChromeOptions {
  /** The Chrome executable; defaults to {@link findChrome}. */
  chromePath?: string;
  /** Extra launch flags, after {@link CHROME_ARGS}. */
  chromeArgs?: string[];
  /** Full control over the launch (the Lambda passes `@sparticuz/chromium`'s). Wins over the two above. */
  launch?: () => Promise<Browser>;
}

/** Launch a headless browser per the options. The caller closes it. */
export async function launchBrowser(options: ChromeOptions = {}): Promise<Browser> {
  if (options.launch) return options.launch();
  const executablePath = options.chromePath ?? findChrome();
  if (!executablePath) {
    throw new Error('No Chrome found: set AGENCY_REPORTS_CHROME_PATH (or CHROME_PATH) to a Chrome or Chromium executable');
  }
  return puppeteer.launch({
    executablePath,
    headless: true,
    args: [...CHROME_ARGS, ...(options.chromeArgs ?? [])],
  });
}
