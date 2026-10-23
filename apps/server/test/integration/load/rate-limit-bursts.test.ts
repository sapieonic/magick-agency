import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Bursts against the rate limiter, on the real app and the Redis store ───────
 *
 * The app-wide limiter (`rate-limit.middleware.ts`, registered once in `app.ts`) keys the
 * `ip` bucket on `request.ip`, which honours exactly `TRUST_PROXY_HOPS` (1) proxies, and
 * counts in Redis. This suite bursts it far past its ceiling — the shared bucket lowered to
 * {@link MAX} so a burst stays small, the per-route ceilings (`POST /super-admin/login`
 * 5/min, `GET /invites/:token` 20/min) at their production values — through `inject` and
 * through real sockets (`listen({ port: 0 })` + `fetch`).
 *
 * What it pins:
 *  1. **Exactly the ceiling passes** a concurrent burst from one client (Redis counts
 *     atomically), every other answer is a 429 with the authored body
 *     (`retryAfter`, never masked, no internals) and the `x-ratelimit-*` / `retry-after`
 *     headers. Mutation-checked: raising the bucket's `max` (`maxFor`'s `ip` arm) reds it.
 *     This case found a defect: through the real app the app-wide error handler rebuilt the
 *     limiter's thrown body from `error.name`, so every 429 reached clients as
 *     `error: 'Error'` without `retryAfter`. Fixed in `error-handler.middleware.ts`;
 *     reverting that reds cases 1, 2 and 5.
 *  2. **Per-key isolation**: while one noisy agent is being throttled, the rest of the floor
 *     — same tenant and another tenant — is never throttled; a spoofed leftmost
 *     `X-Forwarded-For` entry does not move the noisy client into a fresh bucket; the webhook
 *     bucket of the same address is untouched.
 *  3. **Probes are never limited**: `/healthz` and `/readyz` from the exhausted address,
 *     many times over the ceiling, all answer 200.
 *  4. The per-route ceilings hold under a burst, per address.
 *  5. The same holds over real TCP connections.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'load-rate-limit-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { flushTestRedis } from '../../helpers/test-redis.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import {
  call, expectHealthy, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from './load-harness.js';

const MAX = 25;
const BURST = 3 * MAX;
const rng = createRng();

let loaded: LoadApp;
let floors: TenantFloor[];
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[rate-limit-bursts] seed=${rng.seed} max=${MAX} burst=${BURST}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({ configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: MAX, timeWindow: '1 minute' } }) });
  await truncateAll();
  floors = await seedFloor({ tenants: 2, agentsPerTenant: scaled(15) });
});

beforeEach(async () => {
  // A fresh window for every case: the counters live in this worktree's Redis db.
  await flushTestRedis();
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

function expect429(res: { statusCode: number; headers: Record<string, unknown>; body: string }, label: string) {
  expect(res.statusCode, label).toBe(429);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  expect(body).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
  expect(typeof body['retryAfter']).toBe('number');
  expect(body['retryAfter'] as number).toBeGreaterThan(0);
  expect(body['retryAfter'] as number).toBeLessThanOrEqual(60);
  expect(String(body['message'])).toMatch(/^Rate limit exceeded\. Try again in \d+ seconds\.$/);
  expect(Number(res.headers['retry-after']), label).toBeGreaterThan(0);
  expect(Number(res.headers['x-ratelimit-limit']), label).toBe(MAX);
  expect(Number(res.headers['x-ratelimit-remaining']), label).toBe(0);
  expect(res.headers['x-ratelimit-reset'], label).toBeDefined();
}

const noisyGet = (ip: string, extraXff?: string) => {
  const f = floors[0]!;
  const agent = f.agents[0]!;
  return app().inject({
    method: 'GET', url: '/proxy/agency/my-campaigns',
    headers: {
      authorization: `Bearer ${agent.tok}`, 'x-tenant-id': f.tenant, 'x-account-id': f.account,
      'x-forwarded-for': extraXff ? `${extraXff}, ${ip}` : ip,
    },
  });
};

describe('rate-limit bursts (integration, load)', () => {
  it('1. a concurrent burst from one client: exactly the ceiling passes, the rest are well-formed 429s', async () => {
    const ip = floors[0]!.agents[0]!.ip;
    const answers = await Promise.all(Array.from({ length: BURST }, () => noisyGet(ip)));
    const passed = answers.filter((r) => r.statusCode !== 429);
    expect(passed).toHaveLength(MAX);
    for (const res of passed) {
      expect(res.statusCode, res.body).toBe(200);
      expect(Number(res.headers['x-ratelimit-limit'])).toBe(MAX);
    }
    // The remaining counts handed out are exactly MAX-1 … 0, each once.
    expect(passed.map((r) => Number(r.headers['x-ratelimit-remaining'])).sort((a, b) => a - b))
      .toEqual(Array.from({ length: MAX }, (_, i) => i));
    for (const res of answers.filter((r) => r.statusCode === 429)) {
      expectHealthy(res, 'burst');
      expect429(res, 'burst');
    }
  });

  it('2. one noisy agent is throttled; the rest of the floor, a spoofed header and the webhook bucket are not', async () => {
    const noisy = floors[0]!.agents[0]!;
    const others = floors.flatMap((f) => f.agents.filter((a) => a !== noisy).map((a) => ({ f, a })));
    const noise = Promise.all(Array.from({ length: BURST }, () => noisyGet(noisy.ip)));
    const quiet = Promise.all(rng.shuffle(others).flatMap(({ f, a }) =>
      Array.from({ length: 3 }, () => call(app(), 'GET', '/proxy/agency/my-campaigns', a, f))));
    const [noisyAnswers, quietAnswers] = await Promise.all([noise, quiet]);
    expect(noisyAnswers.filter((r) => r.statusCode === 429)).toHaveLength(BURST - MAX);
    for (const res of quietAnswers) {
      expectHealthy(res, 'quiet');
      expect(res.statusCode, res.body).toBe(200);
    }

    // A client that prepends its own X-Forwarded-For entries is still charged by the
    // address the trusted proxy appended — no fresh bucket per spoofed value.
    const spoofed = await Promise.all(Array.from({ length: 10 }, () => noisyGet(noisy.ip, `203.0.113.${rng.int(1, 254)}`)));
    for (const res of spoofed) expect429(res, 'spoofed');

    // The same address's webhook traffic has its own bucket.
    const hook = await app().inject({
      method: 'POST', url: `/api/v1/webhooks/voicelink/webrtc-status/${randomUUID()}`,
      headers: { 'x-forwarded-for': noisy.ip, 'content-type': 'application/json' }, payload: '{}',
    });
    expectHealthy(hook, 'webhook');
    expect(hook.statusCode, hook.body).not.toBe(429);
  });

  it('3. probes are never limited, even from an exhausted address', async () => {
    const ip = floors[0]!.agents[0]!.ip;
    await Promise.all(Array.from({ length: MAX + 5 }, () => noisyGet(ip)));
    expect((await noisyGet(ip)).statusCode).toBe(429);
    const probes = await Promise.all(Array.from({ length: BURST }, (_, i) =>
      app().inject({ method: 'GET', url: i % 2 ? '/healthz' : '/readyz', headers: { 'x-forwarded-for': ip } })));
    for (const res of probes) {
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('4. the per-route ceilings hold under a burst, per address', async () => {
    const login = (ip: string) => app().inject({
      method: 'POST', url: '/super-admin/login',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      payload: JSON.stringify({ email: 'nobody@load.example.com', password: 'wrong-password-123' }),
    });
    const a = await Promise.all(Array.from({ length: 20 }, () => login('198.51.100.7')));
    const b = await Promise.all(Array.from({ length: 3 }, () => login('198.51.100.8')));
    expect(a.filter((r) => r.statusCode !== 429)).toHaveLength(5);
    for (const res of [...a, ...b]) expectHealthy(res, 'login');
    for (const res of a.filter((r) => r.statusCode !== 429)) expect(res.statusCode, res.body).toBe(401);
    for (const res of b) expect(res.statusCode, res.body).toBe(401);

    const invite = (ip: string) => app().inject({ method: 'GET', url: `/invites/${'x'.repeat(43)}`, headers: { 'x-forwarded-for': ip } });
    const inv = await Promise.all(Array.from({ length: 50 }, () => invite('198.51.100.9')));
    expect(inv.filter((r) => r.statusCode !== 429)).toHaveLength(20);
    for (const res of inv) expectHealthy(res, 'invite');
  });

  it('5. over real TCP connections: exactly the ceiling passes and the headers arrive', async () => {
    // Closed with the app in afterAll (Fastify closes idle keep-alive sockets with it).
    const address = await app().listen({ port: 0, host: '127.0.0.1' });
    {
      const f = floors[1]!;
      const agent = f.agents[0]!;
      const answers = await Promise.all(Array.from({ length: BURST }, () => fetch(`${address}/proxy/agency/my-campaigns`, {
        headers: { authorization: `Bearer ${agent.tok}`, 'x-tenant-id': f.tenant, 'x-account-id': f.account, 'x-forwarded-for': agent.ip },
      }).then(async (r) => ({ statusCode: r.status, headers: Object.fromEntries(r.headers.entries()), body: await r.text() }))));
      expect(answers.filter((r) => r.statusCode === 200)).toHaveLength(MAX);
      for (const res of answers.filter((r) => r.statusCode !== 200)) {
        expectHealthy(res as unknown as LightMyRequestResponse, 'tcp');
        expect429(res, 'tcp');
      }
      const probe = await fetch(`${address}/healthz`, { headers: { 'x-forwarded-for': agent.ip } });
      expect(probe.status).toBe(200);
    }
  });
});
