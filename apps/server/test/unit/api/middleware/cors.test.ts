import { describe, it, expect, vi, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * CORS for the split deployment (the console on its own host, the API on another;
 * `CORS_ALLOWED_ORIGINS`, `src/api/middleware/cors.ts`), through the REAL app (`buildApp`, the
 * real rate limiter and the real session middleware on `GET /auth/me`):
 *
 *  (a) a preflight from an allowed origin is answered 204 with the allow-origin, the methods,
 *      the reflected request headers and the cache lifetime, and is charged to no rate-limit
 *      bucket (it carries no bearer, and a NAT'd floor preflights many URLs);
 *  (b) the real request gets the allow-origin and the exposed headers, even when it is refused
 *      (the console must be able to read a 401 / 429 body and its request id);
 *  (c) any other origin gets no allow-origin, so the browser blocks the response;
 *  (d) an empty allow-list (the single-origin deployment) registers nothing: no preflight
 *      route, no CORS header;
 *  (e) every non-safelisted response header the console or `@magick-agency/web-ui` reads is
 *      exposed, or a cross-origin console would read it as missing.
 *
 * Mutation-checked: dropping the `registerCors` call from `app.ts` reds (a) and (b); removing
 * `'x-request-id'` from `CORS_EXPOSED_HEADERS` reds (e).
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../../src/app.js';
import { CORS_EXPOSED_HEADERS, CORS_PREFLIGHT_MAX_AGE_SECONDS } from '../../../../src/api/middleware/cors.js';

const APP_ORIGIN = 'https://staging.app.example.com';
let app: FastifyInstance | undefined;

async function build(corsAllowedOrigins: string[]): Promise<FastifyInstance> {
  app = await buildApp({ ctx: null, corsAllowedOrigins });
  await app.ready();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const preflight = (a: FastifyInstance, origin: string) => a.inject({
  method: 'OPTIONS',
  url: '/auth/me',
  headers: {
    origin,
    'access-control-request-method': 'GET',
    'access-control-request-headers': 'authorization,x-tenant-id,x-account-id',
  },
});

describe('CORS with an allow-list', () => {
  it('(a) answers a preflight from an allowed origin, before the rate limiter', async () => {
    const res = await preflight(await build([APP_ORIGIN]), APP_ORIGIN);
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('authorization,x-tenant-id,x-account-id');
    expect(res.headers['access-control-max-age']).toBe(String(CORS_PREFLIGHT_MAX_AGE_SECONDS));
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    // Charged requests carry the limiter's headers; a preflight is never charged.
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('(b) puts the allow-origin and exposed headers on the real request, refused or not', async () => {
    const res = await (await build([APP_ORIGIN])).inject({
      method: 'GET',
      url: '/auth/me',
      headers: { origin: APP_ORIGIN, authorization: 'Bearer not-a-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(String(res.headers['access-control-expose-headers']).split(', ')).toEqual([...CORS_EXPOSED_HEADERS]);
    expect(res.headers['vary']).toContain('Origin');
  });

  it('(c) gives any other origin no allow-origin', async () => {
    const a = await build([APP_ORIGIN]);
    for (const origin of ['https://evil.example.com', 'https://staging.app.example.com.evil.com', 'http://staging.app.example.com']) {
      const pre = await preflight(a, origin);
      expect(pre.headers['access-control-allow-origin'], origin).toBeUndefined();
      const get = await a.inject({ method: 'GET', url: '/auth/me', headers: { origin } });
      expect(get.headers['access-control-allow-origin'], origin).toBeUndefined();
    }
  });
});

describe('CORS without an allow-list (single-origin deployment)', () => {
  it('(d) registers nothing', async () => {
    const a = await build([]);
    const pre = await preflight(a, APP_ORIGIN);
    expect(pre.statusCode).toBe(404);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const get = await a.inject({ method: 'GET', url: '/auth/me', headers: { origin: APP_ORIGIN } });
    expect(get.headers['access-control-allow-origin']).toBeUndefined();
    expect(get.headers['access-control-expose-headers']).toBeUndefined();
  });
});

describe('CORS_EXPOSED_HEADERS', () => {
  // CORS-safelisted response headers: readable cross-origin without being exposed.
  const SAFELISTED = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
  const ROOTS = ['../../../../../console/src', '../../../../../../packages/web-ui/src'].map((p) => new URL(p, import.meta.url).pathname);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it('(e) exposes every non-safelisted response header the console reads', () => {
    const read = new Set<string>();
    const nonLiteral: string[] = [];
    for (const file of ROOTS.flatMap(sources)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/headers\.get\(\s*(['"`])([^'"`]+)\1\s*\)/g)) read.add((m[2] ?? '').toLowerCase());
      // A header read through a variable cannot be checked here: name it as a literal.
      for (const m of text.matchAll(/headers\.get\(\s*[^'"`\s)]/g)) nonLiteral.push(`${file}: ${m[0]}`);
    }
    expect(read.size).toBeGreaterThan(0);
    expect(nonLiteral).toEqual([]);
    const missing = [...read].filter((h) => !SAFELISTED.has(h) && !(CORS_EXPOSED_HEADERS as readonly string[]).includes(h));
    expect(missing).toEqual([]);
  });
});
