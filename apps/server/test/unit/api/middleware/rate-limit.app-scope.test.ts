import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * NEW (magick-agency, Phase 8): core's limiter is registered ONCE, at app scope (`app.ts`), as
 * core registered it — so every route is charged to a bucket — and lane A's per-route
 * `config.rateLimit` blocks are still honoured by that one registration, as master's single
 * global limiter honoured them (lane A's own `@fastify/rate-limit` registration was removed,
 * see `platform.plugin.ts`). Through the REAL app (`buildApp`, in-memory store):
 *  - `POST /super-admin/login`: master's 5/minute (`super-admin.routes.ts`) — the 6th is a 429;
 *  - `GET /invites/:token` and `POST /invites/:token/claim`: `PUBLIC_INVITE_RATE_LIMIT`,
 *    20/minute per IP — the 21st is a 429, each route its own counter;
 *  - `POST /auth/session` (which had no limit before the hoist: lane C's limiter was
 *    plugin-scoped) is charged to the app-wide bucket (`x-ratelimit-limit: 200`, core's
 *    default ceiling);
 *  - the probes `/healthz`, `/readyz` are exempt (`EXEMPT_PATHS`).
 * Mutation-checked: dropping `registerRateLimit` from `app.ts` reds every case but the probes'.
 *
 * Review fix (Phase 8, BLOCKING): the limiter's `tenant` bucket (core keyed any request with an
 * `x-api-key` header on `${x-mgkvc-tenant}:${hash(x-api-key)}`) is deleted with platform API
 * keys. The last describe proves, through the real app, that rotating those headers rotates no
 * bucket and that a duplicated `x-api-key` is not a 500. Mutation-checked: restoring the
 * `'tenant'` branch in `budgetFor` and its key arm reds the two rotation cases. The duplicate-
 * header case does not red under that mutation: through Node's HTTP layer (and `inject`) a
 * repeated unknown header arrives JOINED into one string ("a, b"), so the array that made core's
 * `hashApiKey` throw (the deleted unit "CURRENT BEHAVIOR" case) never reaches a key generator in
 * the real stack; the case pins the end-to-end answer only.
 */

vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'rate-limit-app-scope-secret-0123456789';
});

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildApp } from '../../../../src/app.js';

let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp({ ctx: null });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function fire(n: number, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const res = await app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    statuses.push(res.statusCode);
  }
  return statuses;
}

describe('the app-scope limiter honours the per-route limits (real app)', () => {
  it('POST /super-admin/login keeps master\'s 5/minute: the 6th attempt is a 429', async () => {
    const statuses = await fire(6, 'POST', '/super-admin/login', {});
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it.each([
    ['GET', '/invites/some-token'],
    ['POST', '/invites/some-token/claim'],
  ] as const)('%s %s keeps PUBLIC_INVITE_RATE_LIMIT (20/minute per IP): the 21st is a 429', async (method, url) => {
    const statuses = await fire(21, method, url, method === 'POST' ? {} : undefined);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('POST /auth/session is charged to the app-wide bucket (it had none before the hoist)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/session', payload: {} });
    expect(res.headers['x-ratelimit-limit']).toBe('200');
    expect(Number(res.headers['x-ratelimit-remaining'])).toBe(199);
  });

  it('the probes are exempt', async () => {
    for (const url of ['/healthz', '/readyz']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['x-ratelimit-limit'], url).toBeUndefined();
    }
  });
});

describe('client headers cannot rotate the bucket (the deleted API-key bucket)', () => {
  it('POST /super-admin/login: six attempts, each with a new x-api-key and x-mgkvc-tenant — the 6th is a 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/super-admin/login',
        headers: { 'x-api-key': `guess-${i}-${Math.random()}`, 'x-mgkvc-tenant': `tenant-${i}` },
        payload: {},
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  it('POST /auth/session: rotating the headers still exhausts the one IP budget (200) — the 201st is a 429', async () => {
    let last = 0;
    for (let i = 0; i < 201; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        headers: { 'x-api-key': `k-${i}`, 'x-mgkvc-tenant': `t-${i}` },
        payload: {},
      });
      last = res.statusCode;
      if (i < 200) expect(res.statusCode, `request ${i + 1}`).not.toBe(429);
    }
    expect(last).toBe(429);
  });

  it('a duplicated x-api-key header is not a 500', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/session',
      headers: { 'x-api-key': ['a', 'b'] as unknown as string, 'x-mgkvc-tenant': 't1' },
      payload: {},
    });
    expect(res.statusCode).not.toBe(500);
    expect(res.headers['x-ratelimit-limit']).toBe('200');
  });
});
