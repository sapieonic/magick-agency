/**
 * NEW (magick-agency, lead): every top-level path the console calls on the agency server is in
 * the dev proxy's `API_PREFIXES` (vite.config.ts). A missing prefix is invisible in tests and
 * in production (same origin), but in `pnpm dev` the request falls through to Vite's SPA
 * fallback and `apiFetch` gets index.html — the caller-ID picker came up empty this way.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('dev proxy prefixes', () => {
  it('proxies every `${API_BASE}/<segment>` the console source calls', () => {
    const viteConfig = readFileSync(resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    const block = viteConfig.match(/API_PREFIXES = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const proxied = new Set([...(block?.[1] ?? '').matchAll(/'(\/[a-z0-9-]+)'/g)].map((m) => m[1] ?? ''));

    const called = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\$\{API_BASE\}(\/[a-z][a-z0-9-]*)/g)) called.add(m[1] ?? '');
    }
    expect(called.size).toBeGreaterThan(5);
    expect([...called].filter((p) => !proxied.has(p)).sort()).toEqual([]);
  });

  /**
   * The other direction: no proxied prefix may shadow a page the SPA routes.
   *
   * A prefix that matched a top-level route would send `pnpm dev`'s deep link to
   * the API instead of to `index.html` — the invite pages most of all, which are
   * only ever opened cold from an email. `/join/:token` sits beside the API's own
   * `/invites/*` and must stay on the SPA's side of the line.
   */
  it('never proxies a path the SPA itself routes', () => {
    const viteConfig = readFileSync(resolve(SRC, '..', 'vite.config.ts'), 'utf8');
    const block = viteConfig.match(/API_PREFIXES = \[([\s\S]*?)\];/);
    const proxied = [...(block?.[1] ?? '').matchAll(/'(\/[a-z0-9-]+)'/g)].map((m) => m[1] ?? '');
    expect(proxied.length).toBeGreaterThan(5);

    const app = readFileSync(resolve(SRC, 'App.tsx'), 'utf8');
    const routed = [...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((m) => m[1] ?? '');
    expect(routed).toContain('/join/:token');
    expect(routed).toContain('/agency/join/:token');

    const shadowed = routed.filter((route) =>
      proxied.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)),
    );
    expect(shadowed).toEqual([]);
  });
});
