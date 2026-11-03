import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppConfig } from '../../../src/config/schema.js';
import { buildApp, type BuildAppOptions } from '../../../src/app.js';
import { getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';

/**
 * `/readyz` in the built app, with real Postgres (5436) and Redis (6383, this worktree's db)
 * and a stand-in for the media workers' readiness (`index.ts` passes `media.health()` there):
 *  - the plain body is the verdict and each worker's state (D5), never the per-process detail;
 *  - `?detail=1` needs `Authorization: Bearer <READYZ_DETAIL_TOKEN>`: without it, with another
 *    token, or with no token configured it is 401, and nothing is probed (no worker pinged);
 *  - a flood of probes runs the readiness probe once per second, not once per request, and a
 *    not-ready verdict is still 503 within that second.
 *
 * Mutation-checked: answering the detail without the token check reds the 401 cases; probing
 * without `cachedProbe`, or with a TTL of 0 (single-flight only), reds the flood case.
 */

const TOKEN = 'readyz-integration-detail-token-0123456789';
const SUMMARY = { mediaWorkers: { answering: 1, total: 2, workers: [{ slot: 0, state: 'ok' }, { slot: 1, state: 'not_answering' }] } };
const DETAIL = [{ role: 'primary', slot: 0, pid: 4242, elu: 0.1, loopDelayP99Ms: 2, db: { maxConnections: 100 } }];

let current: FastifyInstance | null = null;
const workers = { pings: 0, ready: true };
const readiness: NonNullable<BuildAppOptions['readiness']> = async () => {
  workers.pings++;
  return { ready: workers.ready, summary: SUMMARY, detail: DETAIL };
};

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

async function appWith(readyzDetailToken: string | undefined): Promise<FastifyInstance> {
  const cfg: AppConfig = {
    ...config,
    server: { ...config.server, readyzDetailToken },
    localCache: { ...config.localCache, enabled: false },
    auditPartitions: { ...config.auditPartitions, enabled: false },
  };
  await teardown();
  workers.pings = 0;
  workers.ready = true;
  const app = await buildApp({ ctx: { config: cfg, pool: getPool(), redis: getTestRedis() }, readiness });
  await app.ready();
  current = app;
  return app;
}

const get = (app: FastifyInstance, url: string, authorization?: string) =>
  app.inject({ method: 'GET', url, headers: authorization ? { authorization } : {} });
const pastTheCache = (): Promise<void> => new Promise((r) => setTimeout(r, 1_100));

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

describe('/readyz in the built app (integration)', () => {
  it('plain /readyz: the verdict and each worker state, no per-process detail', async () => {
    const app = await appWith(TOKEN);
    const res = await get(app, '/readyz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', ...SUMMARY });
    expect(res.body).not.toContain('4242');
  });

  it('?detail=1 without the token, or with another: 401, nothing probed', async () => {
    const app = await appWith(TOKEN);
    for (const auth of [undefined, 'Bearer not-the-token', TOKEN, `Basic ${TOKEN}`]) {
      const res = await get(app, '/readyz?detail=1', auth);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ status: 'unauthorized' });
    }
    expect(workers.pings).toBe(0);
  });

  it('?detail=1 with the token: the per-process detail', async () => {
    const app = await appWith(TOKEN);
    const res = await get(app, '/readyz?detail=1', `Bearer ${TOKEN}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', ...SUMMARY, processes: DETAIL });
  });

  it('no READYZ_DETAIL_TOKEN configured: the detail is off for everyone', async () => {
    const app = await appWith(undefined);
    for (const auth of [undefined, 'Bearer ', 'Bearer undefined', `Bearer ${TOKEN}`]) {
      expect((await get(app, '/readyz?detail=1', auth)).statusCode).toBe(401);
    }
    expect((await get(app, '/readyz')).statusCode).toBe(200);
    expect(workers.pings).toBe(1);
  });

  it('a flood of probes pings the workers once a second; a not-ready verdict is 503 within that second', async () => {
    const app = await appWith(TOKEN);
    const flood = await Promise.all(Array.from({ length: 200 }, (_, i) =>
      i % 4 === 0 ? get(app, '/readyz?detail=1', `Bearer ${TOKEN}`) : get(app, '/readyz')));
    expect(flood.every((r) => r.statusCode === 200)).toBe(true);
    expect(workers.pings).toBe(1);
    // One after another (no overlap to share): still the same answer inside the second.
    for (let i = 0; i < 20; i++) expect((await get(app, '/readyz')).statusCode).toBe(200);
    expect(workers.pings).toBe(1);

    workers.ready = false;
    await pastTheCache();
    const res = await get(app, '/readyz');
    // D5 unchanged: not ready is 503, and the body still names each worker's state.
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', ...SUMMARY });
    expect(workers.pings).toBe(2);
  });
});
