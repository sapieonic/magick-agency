/**
 * `@sparticuz/chromium` for the Lambda. It ships as a Lambda LAYER, so at run time it lives at
 * `/opt/nodejs/node_modules/@sparticuz/chromium`; the bundle leaves it external. ES modules
 * ignore NODE_PATH, so a bare `import('@sparticuz/chromium')` from `/var/task/index.mjs` would
 * not find the layer: it is resolved from the layer's directory first, and only then by its bare
 * name (a local run with the package installed).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer, { type Browser } from 'puppeteer-core';

/** Where Lambda mounts a Node.js layer's packages. */
export const LAYER_NODE_MODULES = '/opt/nodejs/node_modules/';

export interface SparticuzChromium {
  args: string[];
  executablePath(input?: string): Promise<string>;
}

export interface ChromiumLoaderDeps {
  layerDir: string;
  importer: (specifier: string) => Promise<{ default: SparticuzChromium }>;
}

const defaultDeps: ChromiumLoaderDeps = {
  layerDir: LAYER_NODE_MODULES,
  importer: (specifier) => import(specifier) as Promise<{ default: SparticuzChromium }>,
};

/**
 * The specifier to import: the layer copy's entry file as a file URL when the layer has the
 * package, else the bare name. The entry is read from the layer's own `package.json` (its
 * `exports['.']`, then `main`) rather than through Node's resolver, which would also search
 * NODE_PATH and could pick a copy outside the layer.
 */
export function chromiumSpecifier(layerDir: string = LAYER_NODE_MODULES): string {
  const pkgDir = join(layerDir, '@sparticuz', 'chromium');
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      main?: string;
      exports?: string | Record<string, string | { import?: string; default?: string }>;
    };
    const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
    const entry = (typeof dot === 'string' ? dot : (dot?.import ?? dot?.default)) ?? pkg.main ?? 'index.js';
    const file = join(pkgDir, entry);
    if (existsSync(file)) return pathToFileURL(file).href;
  } catch {
    // Not in the layer: fall through to the bare name.
  }
  return '@sparticuz/chromium';
}

export async function loadSparticuzChromium(deps: ChromiumLoaderDeps = defaultDeps): Promise<SparticuzChromium> {
  const mod = await deps.importer(chromiumSpecifier(deps.layerDir));
  return mod.default;
}

/** Launch the layer's Chromium in its headless shell mode. */
export async function launchLambdaChromium(deps?: ChromiumLoaderDeps): Promise<Browser> {
  const chromium = await loadSparticuzChromium(deps);
  return puppeteer.launch({
    args: await puppeteer.defaultArgs({ args: chromium.args, headless: 'shell' }),
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
}
