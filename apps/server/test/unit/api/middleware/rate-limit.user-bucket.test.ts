import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Decision Q9, amended 2026-11-01: a call floor behind one carrier-grade NAT shares an IP, so
 * the per-IP bucket must not be what binds authenticated traffic. Through the REAL app
 * (`buildApp`, in-memory store, default ceilings) and the REAL `sessionMiddleware` (Firebase
 * and the user lookup stubbed), on a probe route behind it:
 *
 *  (a) two users behind one IP each get their own `u:<id>` bucket, and together they pass
 *      more than the unauthenticated per-IP ceiling;
 *  (b) one user is refused at the per-user max: the request past it is the authored 429,
 *      with the user ceiling in its headers and `bucket_kind="user"` on the counter;
 *  (c) unauthenticated traffic (no bearer) is still limited per IP (`RATE_LIMIT_MAX`);
 *  (d) a request carrying a bearer is measured in the `ipa:` bucket, even a forged
 *      one (refused 401 by the session middleware), and that bucket is not the
 *      unauthenticated one.
 *
 * Mutation-checked: dropping the `chargeUserRateLimit` call from `sessionMiddleware` reds (a)
 * and (b); returning `ip_auth` for every request in `budgetFor` reds (c).
 */

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  trackRateLimitRejected: vi.fn(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability/metrics/voice')>()),
  trackRateLimitRejected: mocks.trackRateLimitRejected,
}));
vi.mock('../../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: async (uid: string) => ({
      id: `00000000-0000-4000-8000-${uid.padStart(12, '0')}`,
      firebase_uid: uid,
      email: `${uid}@example.com`,
      display_name: uid,
      avatar_url: null,
      status: 'active',
      phone_number: null,
      email_unverified: false,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }),
  },
}));

import { buildApp } from '../../../../src/app.js';
import { sessionMiddleware } from '../../../../src/auth/session.middleware.js';
import {
  DEFAULT_RATE_LIMIT_IP_AUTH_MAX,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_USER_MAX,
} from '../../../../src/api/middleware/rate-limit-defaults.js';

/** One public address, as Jio/Airtel CGNAT presents a whole floor. */
const NAT_IP = '100.64.7.7';
// The default ceilings (`rate-limit-defaults.ts`): 600 per user, 2000 per IP unauthenticated,
// 20 000 per IP with a bearer.
const USER_MAX = DEFAULT_RATE_LIMIT_USER_MAX;
const IP_MAX = DEFAULT_RATE_LIMIT_MAX;
const IP_AUTH_MAX = DEFAULT_RATE_LIMIT_IP_AUTH_MAX;

let app: FastifyInstance;

beforeEach(async () => {
  mocks.trackRateLimitRejected.mockClear();
  // `tok:<uid>` verifies as `<uid>`; anything else is a forged token.
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: 'x@example.com', email_verified: true };
  });
  app = await buildApp({ ctx: null });
  // Added after `buildApp`, so the app-scope limiter's `onRoute` hook still attaches to it.
  app.get('/__test/whoami', { preHandler: sessionMiddleware }, async (request) => ({ id: request.user!.id }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

const call = (token?: string, ip = NAT_IP) => app.inject({
  method: 'GET',
  url: '/__test/whoami',
  remoteAddress: ip,
  ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
});

async function fire(n: number, token?: string, ip = NAT_IP): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i += 1) statuses.push((await call(token, ip)).statusCode);
  return statuses;
}

describe('the per-user bucket (Q9, amended 2026-11-01)', () => {
  it('(a) two users behind one IP each get their own bucket, past what one user may spend', async () => {
    // 2 × USER_MAX verified requests from one address: each user's own ceiling binds, not the IP.
    expect(2 * USER_MAX).toBeLessThan(IP_AUTH_MAX);
    expect((await fire(USER_MAX, 'tok:agent-a')).every((s) => s === 200)).toBe(true);
    expect((await fire(USER_MAX, 'tok:agent-b')).every((s) => s === 200)).toBe(true);
    // Each is now at their own ceiling, and only their own.
    expect((await call('tok:agent-a')).statusCode).toBe(429);
    expect((await call('tok:agent-b')).statusCode).toBe(429);
    // A third agent on the same IP is untouched by both.
    const third = await call('tok:agent-c');
    expect(third.statusCode).toBe(200);
    expect(third.json()).toEqual({ id: '00000000-0000-4000-8000-00000agent-c' });
  });

  it('(b) one user is refused at the user max: the request past it is the authored 429', async () => {
    const statuses = await fire(USER_MAX, 'tok:agent-a');
    expect(statuses.every((s) => s === 200)).toBe(true);

    const refused = await call('tok:agent-a');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      error: 'Too Many Requests',
      statusCode: 429,
      message: expect.stringMatching(/^Rate limit exceeded\. Try again in \d+ seconds\.$/),
    });
    expect(refused.json().retryAfter).toBeGreaterThan(0);
    // The refusing bucket's ceiling, not the IP bucket's.
    expect(refused.headers['x-ratelimit-limit']).toBe(String(USER_MAX));
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(mocks.trackRateLimitRejected).toHaveBeenCalledWith('user', 'other');
    expect(mocks.trackRateLimitRejected).toHaveBeenCalledTimes(1);
  });

  it('(c) unauthenticated traffic is still limited per IP', async () => {
    const statuses = await fire(IP_MAX);
    expect(statuses.every((s) => s === 401)).toBe(true);
    const refused = await call();
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['x-ratelimit-limit']).toBe(String(IP_MAX));
    expect(mocks.trackRateLimitRejected).toHaveBeenCalledWith('ip', 'other');
    // Another address has its own.
    expect((await call(undefined, '100.64.8.8')).statusCode).toBe(401);
  });

  it('(d) a bearer is measured in the ip_auth bucket, even a forged one, apart from the unauthenticated bucket', { timeout: 120_000 }, async () => {
    const first = await call('forged');
    expect(first.statusCode).toBe(401);
    expect(first.headers['x-ratelimit-limit']).toBe(String(IP_AUTH_MAX));
    expect(first.headers['x-ratelimit-remaining']).toBe(String(IP_AUTH_MAX - 1));

    // Spend it: a forged bearer buys the coarse per-IP ceiling, and every one is still a 401.
    const rest = await fire(IP_AUTH_MAX - 1, 'forged');
    expect(rest.every((s) => s === 401)).toBe(true);
    const refused = await call('forged');
    expect(refused.statusCode).toBe(429);
    expect(mocks.trackRateLimitRejected).toHaveBeenCalledWith('ip_auth', 'other');

    // The unauthenticated bucket of the same address is a different counter, untouched.
    const plain = await call();
    expect(plain.statusCode).toBe(401);
    expect(plain.headers['x-ratelimit-limit']).toBe(String(IP_MAX));
    expect(plain.headers['x-ratelimit-remaining']).toBe(String(IP_MAX - 1));
  });
});
