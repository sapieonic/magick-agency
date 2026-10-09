import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/schema.js';
import { buildApp } from '../../../src/app.js';
import { getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';

/**
 * Decisions Q7/Q9: the built app passes
 * `server.trustProxyHops` (`TRUST_PROXY_HOPS`) to Fastify's `trustProxy`,
 * so `request.ip` — the key of every IP rate-limit bucket — honours exactly N proxy hops:
 *  - with hops = 1, a spoofed extra LEFTMOST `X-Forwarded-For` entry changes neither
 *    `request.ip` nor the bucket (the limiter's remaining count keeps falling across
 *    rotated spoofs, and the next request past the ceiling is a 429);
 *  - with hops = 1, `request.ip` is the entry the trusted proxy appended, not the socket;
 *  - with hops = 2, the second-from-right entry is trusted (the count is what moves it).
 * Real Postgres (5436) and Redis (6383, this worktree's db): the limiter uses the shared
 * Redis store, as in production.
 *
 * Mutation-checked: passing the bare number (`trustProxy: hops`, which Fastify 5.12 fails
 * closed) reds the three hop cases (request.ip stays the socket peer); `trustProxy: true` reds
 * them too (the spoofed leftmost entry becomes request.ip and rotates the bucket).
 */

const PROXY_SOCKET = '10.0.0.5';

let current: FastifyInstance | null = null;

/** Close the previous app and its voice engine before building the next (one at a time). */
async function teardown(): Promise<void> {
  await current?.close();
  current = null;
  const engine = getVoiceEngine();
  await engine?.bridge.gracefulShutdown();
  await engine?.guardHost.gracefulShutdown();
  resetVoiceEngineForTests();
  resetConcurrencyControl();
  await resetAgencyRuntimeForTests();
}

async function appWith(server: Partial<AppConfig['server']>, rateLimit?: Partial<AppConfig['rateLimit']>) {
  const cfg: AppConfig = {
    ...config,
    server: { ...config.server, ...server },
    rateLimit: { ...config.rateLimit, ...rateLimit },
    localCache: { ...config.localCache, enabled: false },
    auditPartitions: { ...config.auditPartitions, enabled: false },
  };
  await teardown();
  const app = await buildApp({ ctx: { config: cfg, pool: getPool(), redis: getTestRedis() } });
  app.get('/__test/ip', async (request) => ({ ip: request.ip }));
  await app.ready();
  current = app;
  return app;
}

function get(app: FastifyInstance, xff: string) {
  return app.inject({
    method: 'GET', url: '/__test/ip', remoteAddress: PROXY_SOCKET,
    headers: { 'x-forwarded-for': xff },
  });
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 });
  await flushTestRedis();
});

afterAll(async () => {
  await teardown();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

describe('TRUST_PROXY_HOPS in the built app (integration)', () => {
  it('defaults to 1 and is never `true`', () => {
    expect(config.server.trustProxyHops).toBe(1);
  });

  it('hops = 1: request.ip is the entry the proxy appended, and a spoofed leftmost entry does not change it', async () => {
    const app = await appWith({ trustProxyHops: 1 });
    expect((await get(app, '203.0.113.7')).json().ip).toBe('203.0.113.7');
    expect((await get(app, '198.51.100.1, 203.0.113.7')).json().ip).toBe('203.0.113.7');
    expect((await get(app, '1.2.3.4, 5.6.7.8, 203.0.113.7')).json().ip).toBe('203.0.113.7');
  });

  it('hops = 1: rotating a spoofed leftmost entry does not rotate the rate-limit bucket', async () => {
    await flushTestRedis();
    const app = await appWith({ trustProxyHops: 1 }, { max: 3 });
    const statuses: number[] = [];
    const remaining: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await get(app, `198.51.100.${i + 10}, 203.0.113.9`);
      statuses.push(res.statusCode);
      remaining.push(String(res.headers['x-ratelimit-remaining']));
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(remaining.slice(0, 3)).toEqual(['2', '1', '0']);
    // A genuinely different client behind the same proxy has its own bucket.
    expect((await get(app, '203.0.113.10')).statusCode).toBe(200);
  });

  it('hops = 2: the count is what decides which entry is trusted', async () => {
    const app = await appWith({ trustProxyHops: 2 });
    expect((await get(app, '198.51.100.1, 203.0.113.7')).json().ip).toBe('198.51.100.1');
    expect((await get(app, '1.2.3.4, 198.51.100.1, 203.0.113.7')).json().ip).toBe('198.51.100.1');
  });
});
