import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── The per-user bucket, on the real app and the Redis store (Q9, amended 2026-11-01) ───
 *
 * A call floor behind one carrier-grade NAT presents ONE address. Here a whole tenant's
 * agents send from one `X-Forwarded-For` address, through the real app (real Postgres
 * users and memberships, this worktree's Redis db as the limiter store, the one trusted
 * proxy hop), with the ceilings lowered so the bursts stay small:
 *  - unauthenticated `ip` bucket: {@link IP_MAX}; bearer `ip_auth` bucket: {@link IP_AUTH_MAX};
 *    per-user bucket: {@link USER_MAX}.
 *
 * What it pins:
 *  1. agents behind one address each get their own per-user budget, and together pass far
 *     more than the unauthenticated ceiling for that address;
 *  2. one agent bursting concurrently gets exactly {@link USER_MAX} through (Redis counts
 *     atomically) and the rest are the authored 429, while a colleague on the same address
 *     is untouched;
 *  3. the bearer traffic's `ip_auth` bucket is still a ceiling for the address, and the
 *     unauthenticated bucket of that address is a separate counter.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'load-rate-limit-user-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import { truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { flushTestRedis } from '../../helpers/test-redis.js';
import {
  call, expectHealthy, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from './load-harness.js';

const IP_MAX = 10;
const USER_MAX = 15;
const IP_AUTH_MAX = 60;
/** The one public address the whole floor shares. */
const NAT_IP = '100.64.20.20';

let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp({
    configure: (c) => ({
      ...c,
      rateLimit: { ...c.rateLimit, max: IP_MAX, ipAuthMax: IP_AUTH_MAX, timeWindow: '1 minute' },
      userRateLimit: { max: USER_MAX },
    }),
  });
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: 6 }))[0]!;
  // Every agent of the floor behind the one address.
  for (const agent of floor.agents) agent.ip = NAT_IP;
});

beforeEach(async () => {
  // A fresh window for every case: the counters live in this worktree's Redis db.
  await flushTestRedis();
});

afterAll(async () => {
  await stopLoadApp(loaded);
});

const read = (agent: Actor) => call(app(), 'GET', '/auth/me', agent, floor);

describe('the per-user bucket behind one NAT address (integration, Redis store)', () => {
  it('1. agents behind one address each get their own budget, past the unauthenticated ceiling', async () => {
    const [a, b, c] = floor.agents as [Actor, Actor, Actor];
    // 3 × USER_MAX = 45 verified requests from one address: 4.5× its unauthenticated ceiling.
    for (const agent of [a, b, c]) {
      const answers = await Promise.all(Array.from({ length: USER_MAX }, () => read(agent)));
      for (const res of answers) {
        expectHealthy(res, 'within budget');
        expect(res.statusCode, res.body).toBe(200);
      }
    }
    // Each is now at their own ceiling, and only their own.
    for (const agent of [a, b, c]) expect((await read(agent)).statusCode).toBe(429);
    expect((await read(floor.agents[3]!)).statusCode).toBe(200);
  });

  it('2. one agent bursting gets exactly the per-user ceiling; a colleague on the address is untouched', async () => {
    const [noisy, quiet] = floor.agents as [Actor, Actor];
    const answers = await Promise.all(Array.from({ length: 3 * USER_MAX }, () => read(noisy)));
    expect(answers.filter((r) => r.statusCode === 200)).toHaveLength(USER_MAX);
    for (const res of answers.filter((r) => r.statusCode !== 200)) {
      expectHealthy(res, 'refused');
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ error: 'Too Many Requests', statusCode: 429 });
      expect(res.json().retryAfter).toBeGreaterThan(0);
      expect(Number(res.headers['x-ratelimit-limit'])).toBe(USER_MAX);
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    }
    const colleague = await read(quiet);
    expect(colleague.statusCode, colleague.body).toBe(200);
  });

  it('3. the address\'s bearer bucket is still a ceiling, apart from its unauthenticated bucket', async () => {
    // Six agents × 10 = IP_AUTH_MAX bearer requests: every one within its user budget.
    const all = await Promise.all(floor.agents.flatMap((agent) =>
      Array.from({ length: IP_AUTH_MAX / floor.agents.length }, () => read(agent))));
    expect(all.every((r) => r.statusCode === 200)).toBe(true);
    // The address is now spent for bearer traffic, whoever sends it.
    const over = await read(floor.agents[5]!);
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['x-ratelimit-limit'])).toBe(IP_AUTH_MAX);

    // A request without a bearer from the same address is a different counter.
    const anonymous = await app().inject({ method: 'GET', url: '/auth/me', headers: { 'x-forwarded-for': NAT_IP } });
    expect(anonymous.statusCode).toBe(401);
    expect(Number(anonymous.headers['x-ratelimit-limit'])).toBe(IP_MAX);
    expect(Number(anonymous.headers['x-ratelimit-remaining'])).toBe(IP_MAX - 1);
  });
});
