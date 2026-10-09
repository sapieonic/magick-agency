import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { RouteOptions } from 'fastify';

vi.hoisted(() => {
  // The super-admin tree registers only with its secret (platform.plugin.ts).
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
});

import { buildApp } from '../../../src/app.js';

/**
 * NEW (magick-agency): the production packaging in `docker/` (no source; core had one
 * Dockerfile and no proxy). Two kinds of drift here are silent until production:
 *
 * 1. **A route nginx does not forward.** nginx answers every path it does not proxy with the
 *    console's `index.html` (the SPA fallback), so a new top-level route prefix 200s with HTML
 *    in production while every test, and `pnpm dev`, stays green. The server's routes are
 *    enumerated from its own `onRoute` hook and each top-level segment must be proxied by the
 *    right nginx server block; the console's dev-proxy list (`API_PREFIXES`) must be too.
 * 2. **A deployment invariant dropped from the compose file or the image** (docs/operations.md,
 *    "Deployment invariants"): the 45 s stop grace, Redis persistence and `noeviction`, the
 *    server publishing no port, production mode, migrations before boot.
 */

const DOCKER = fileURLToPath(new URL('../../../../../docker/', import.meta.url));
const read = (name: string) => readFileSync(DOCKER + name, 'utf8');
const NGINX = read('nginx.conf');
const COMPOSE = read('docker-compose.prod.yml');

/** The text of the nginx `server { ... }` block that listens on `port`. */
function serverBlock(port: number): string {
  const blocks = NGINX.split(/^server \{$/m).slice(1);
  const block = blocks.find((b) => new RegExp(`^\\s*listen ${port};`, 'm').test(b));
  expect(block, `no nginx server block listens on ${port}`).toBeDefined();
  return block ?? '';
}

/** The top-level segments a server block proxies to the app. */
function proxiedSegments(block: string): Set<string> {
  const segments = new Set<string>();
  const locations = [...block.matchAll(/location ([^{]+)\{([^}]*)\}/g)];
  for (const [, matcher = '', body = ''] of locations) {
    if (!body.includes('proxy_pass')) continue;
    const alternation = matcher.match(/\^\/\(([^)]+)\)/);
    if (alternation) for (const s of (alternation[1] ?? '').split('|')) segments.add(s);
    const literal = matcher.match(/^(?:=\s*)?\/([a-z0-9-]+)/);
    if (literal) segments.add(literal[1] ?? '');
  }
  return segments;
}

/** The text of one service in the compose file (top-level keys under `services:`). */
function service(name: string): string {
  const match = COMPOSE.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]|^[a-z])`, 'm'));
  expect(match, `no compose service ${name}`).not.toBeNull();
  return match?.[1] ?? '';
}

async function topLevelSegments(): Promise<Set<string>> {
  const segments = new Set<string>();
  const app = await buildApp({
    ctx: null,
    onRoute: (r: RouteOptions) => {
      segments.add(r.url.split('/')[1] ?? '');
    },
  });
  await app.ready();
  await app.close();
  return segments;
}

describe('docker/nginx.conf forwards every route to the server', () => {
  const console8080 = serverBlock(8080);
  const superAdmin8081 = serverBlock(8081);

  it('proxies every top-level route segment from the block that serves its UI', async () => {
    const routes = await topLevelSegments();
    expect(routes.has('super-admin')).toBe(true);
    const consoleProxied = proxiedSegments(console8080);
    const superAdminProxied = proxiedSegments(superAdmin8081);

    // `/readyz` is for the container healthcheck, which calls the server directly.
    const internalOnly = new Set(['readyz']);
    const unrouted = [...routes].filter((s) =>
      s === 'super-admin' ? !superAdminProxied.has(s) : !internalOnly.has(s) && !consoleProxied.has(s),
    );
    expect(unrouted.sort()).toEqual([]);
    // And the super-admin API is not exposed on the console's (public) block.
    expect(consoleProxied.has('super-admin')).toBe(false);
  });

  it("proxies every prefix in the console's dev proxy (apps/console/vite.config.ts API_PREFIXES)", () => {
    const vite = readFileSync(new URL('../../../../console/vite.config.ts', import.meta.url), 'utf8');
    const list = vite.match(/API_PREFIXES = \[([\s\S]*?)\];/)?.[1] ?? '';
    const prefixes = [...list.matchAll(/'\/([a-z0-9-]+)'/g)].map((m) => m[1] ?? '');
    expect(prefixes.length).toBeGreaterThan(5);
    const proxied = proxiedSegments(console8080);
    expect(prefixes.filter((p) => !proxied.has(p))).toEqual([]);
  });

  it('passes WebSocket upgrades (station socket, PSTN media socket)', () => {
    expect(NGINX).toMatch(/proxy_set_header Upgrade \$http_upgrade;/);
    expect(NGINX).toMatch(/proxy_set_header Connection \$connection_upgrade;/);
  });

  it('appends the client address to X-Forwarded-For (the one hop TRUST_PROXY_HOPS counts)', () => {
    expect(NGINX).toMatch(/proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;/);
  });

  it('accepts the 512 MiB roster CSV upload', () => {
    expect(console8080).toMatch(/client_max_body_size 513m;/);
  });
});

describe('docker/docker-compose.prod.yml keeps the deployment invariants', () => {
  it('gives the server a 45s stop grace (30s completion-email drain; Docker defaults to 10s)', () => {
    expect(service('server')).toMatch(/^ {4}stop_grace_period: 45s$/m);
  });

  it('publishes no server port: it is reachable only through nginx', () => {
    expect(service('server')).not.toMatch(/^ {4}ports:/m);
    expect(service('server')).not.toMatch(/replicas/);
  });

  it('runs the server in production mode with one proxy hop by default', () => {
    expect(service('server')).toMatch(/NODE_ENV: production/);
    expect(service('server')).toMatch(/TRUST_PROXY_HOPS: \$\{TRUST_PROXY_HOPS:-1\}/);
  });

  it('runs Redis with AOF persistence and noeviction', () => {
    const redis = service('redis');
    expect(redis).toMatch(/"--appendonly", "yes"/);
    expect(redis).toMatch(/"--maxmemory-policy", "noeviction"/);
    expect(redis).toMatch(/redisdata:\/data/);
  });
});

describe('docker/Dockerfile and docker/entrypoint.sh', () => {
  it('sets NODE_ENV=production in the image (turns verified Postgres TLS on)', () => {
    expect(read('Dockerfile')).toMatch(/^ENV NODE_ENV=production$/m);
  });

  it('runs migrations, then execs the server, failing the start if migrations fail', () => {
    const entrypoint = read('entrypoint.sh');
    expect(entrypoint).toMatch(/^set -e$/m);
    const migrate = entrypoint.indexOf('node dist/migrate.js migrations');
    const start = entrypoint.indexOf('exec node');
    expect(migrate).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(migrate);
  });
});
