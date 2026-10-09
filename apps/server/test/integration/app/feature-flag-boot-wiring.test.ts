import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * NEW (magick-agency, lead): `buildApp` with a real context initialises the
 * feature-flag service with the shared Redis, as core did at boot
 * (`call-manager.ts:677@4850d1d9`). Without it `getFeatureFlagService()` falls back
 * to a Redis-less instance and a flag read never writes its snapshot to Redis.
 * Real Postgres (5436) and Redis (6383, this worktree's db).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import { FLAGS, getFeatureFlagService, initFeatureFlagService } from '../../../src/feature-flags/index.js';
import { getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';

let app: FastifyInstance | null = null;

describe('feature-flag service wiring in the built app (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    initFeatureFlagService(null, ''); // start from the Redis-less fallback
  });

  afterAll(async () => {
    await app?.close();
    const engine = getVoiceEngine();
    await engine?.bridge.gracefulShutdown();
    await engine?.guardHost.gracefulShutdown();
    resetVoiceEngineForTests();
    resetConcurrencyControl();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('a flag read before buildApp caches nothing (the precondition this suite guards)', async () => {
    await getFeatureFlagService().getValue(FLAGS.agency_dialer_enabled, { tenantId: randomUUID(), accountId: randomUUID() });
    expect(await getTestRedis().keys('*ff:*')).toEqual([]);
  });

  it('after buildApp a flag read caches its snapshots in the shared Redis', async () => {
    app = await buildApp({ ctx: { config, pool: getTestPool(), redis: getTestRedis() } });
    const tenantId = randomUUID();
    await getFeatureFlagService().getValue(FLAGS.agency_dialer_enabled, { tenantId, accountId: randomUUID() });
    const keys = await getTestRedis().keys('*ff:*');
    expect(keys).toContain(`${config.redis.keyPrefix}ff:global`);
    expect(keys).toContain(`${config.redis.keyPrefix}ff:tenant:${tenantId}`);
  });
});
