import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { featureFlagRepository } from '@magick-agency/db/repositories/feature-flag.repository';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { FLAGS, FeatureFlagService, getFeatureFlagService, initFeatureFlagService } from '../../../src/feature-flags/index.js';

/**
 * NEW (magick-agency, no source). Core tests `FeatureFlagService` only over a
 * mocked repository and a mocked Redis (its route-level rollout suite,
 * `test/integration/flows/feature-flag-rollout.test.ts`, belongs to lane A with
 * the override routes). This runs the REAL service over the REAL repository on
 * Postgres 5436 and the REAL test Redis (6383 db 1): precedence from stored rows,
 * the shared cache key it writes, invalidation, the singleton, and the fail-safe
 * arm (a failed snapshot read resolves the REGISTRY default, never the env one).
 */

const PREFIX = 'ma-test:';

describe('FeatureFlagService against Postgres + Redis (integration)', () => {
  const TENANT = randomUUID();
  const ACCOUNT = randomUUID();
  const ORIG_ENV = { ...process.env };

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    process.env = { ...ORIG_ENV };
    delete process.env['FF_AGENCY_DIALER'];
  });

  afterAll(async () => {
    process.env = ORIG_ENV;
    await closePool();
    await closeTestRedis();
  });

  it('resolves account → tenant → global from stored overrides and caches both snapshots in Redis', async () => {
    const svc = new FeatureFlagService(getTestRedis(), PREFIX);
    const ctx = { tenantId: TENANT, accountId: ACCOUNT };

    expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, ctx)).toBe(false);

    await featureFlagRepository.upsert({ flag_key: 'agency_dialer_enabled', scope_type: 'global', value: true });
    await svc.invalidate({});
    expect(await svc.getValue(FLAGS.agency_dialer_enabled, ctx)).toBe(true);

    await featureFlagRepository.upsert({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT, value: false });
    await svc.invalidate({ tenantId: TENANT });
    expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, ctx)).toBe(false);

    await featureFlagRepository.upsert({
      flag_key: 'agency_dialer_enabled', scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT, value: true,
    });
    await svc.invalidate({ tenantId: TENANT });
    expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, ctx)).toBe(true);
    expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, { tenantId: TENANT, accountId: randomUUID() })).toBe(false);

    const redis = getTestRedis();
    expect(JSON.parse((await redis.get(`${PREFIX}ff:global`))!)).toHaveLength(1);
    expect(JSON.parse((await redis.get(`${PREFIX}ff:tenant:${TENANT}`))!)).toHaveLength(2);
  });

  it('serves a cached snapshot until invalidate, then re-reads the database', async () => {
    const svc = new FeatureFlagService(getTestRedis(), PREFIX);
    const ctx = { tenantId: TENANT };
    expect(await svc.isEnabled(FLAGS.agency_late_binding, ctx)).toBe(false);

    await featureFlagRepository.upsert({ flag_key: 'agency_late_binding', scope_type: 'tenant', tenant_id: TENANT, value: true });
    // Stale by design within the 60s TTL: nothing told the cache.
    expect(await svc.isEnabled(FLAGS.agency_late_binding, ctx)).toBe(false);

    await svc.invalidate({ tenantId: TENANT });
    expect(await svc.isEnabled(FLAGS.agency_late_binding, ctx)).toBe(true);
  });

  it('snapshot / resolveAll / resolveClientExposed / resolveAllWithSource read the same stored state', async () => {
    await featureFlagRepository.upsert({ flag_key: 'agency_call_analysis', scope_type: 'tenant', tenant_id: TENANT, value: true });
    const svc = new FeatureFlagService(getTestRedis(), PREFIX);
    const ctx = { tenantId: TENANT, accountId: ACCOUNT };

    const snap = await svc.snapshot(ctx);
    expect(snap.isEnabled(FLAGS.agency_call_analysis)).toBe(true);
    expect(snap.isEnabled(FLAGS.agency_dialer_enabled)).toBe(false);

    expect(await svc.resolveAll(ctx)).toEqual({
      agency_call_analysis: true, agency_dialer_enabled: false, agency_late_binding: false,
    });
    expect(await svc.resolveClientExposed(ctx)).toEqual({ agency_call_analysis: true, agency_dialer_enabled: false });
    expect((await svc.resolveAllWithSource(ctx))['agency_call_analysis']).toEqual({ value: true, source: 'tenant' });
  });

  it('a failed snapshot read resolves the REGISTRY default even with the env var set on', async () => {
    process.env['FF_AGENCY_DIALER'] = 'true';
    await featureFlagRepository.upsert({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT, value: true });
    await closePool(); // the database is now unreachable for this service
    try {
      const svc = new FeatureFlagService(null, PREFIX);
      expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, { tenantId: TENANT })).toBe(false);
      expect((await svc.snapshot({ tenantId: TENANT })).isEnabled(FLAGS.agency_dialer_enabled)).toBe(false);
    } finally {
      initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    }
  });

  it('initFeatureFlagService installs the singleton that getFeatureFlagService returns', () => {
    const svc = initFeatureFlagService(getTestRedis(), PREFIX);
    expect(getFeatureFlagService()).toBe(svc);
  });
});
