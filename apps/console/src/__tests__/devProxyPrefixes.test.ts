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
});
