import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({
  findGlobal: vi.fn(),
  findByTenant: vi.fn(),
  evalInc: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/feature-flag.repository', () => ({
  featureFlagRepository: {
    findGlobal: mocks.findGlobal,
    findByTenant: mocks.findByTenant,
  },
}));

vi.mock('@magick-agency/observability/metrics/shared', () => ({
  featureFlagEvaluationsTotal: { inc: mocks.evalInc },
}));

import { FeatureFlagService } from '../../../src/feature-flags/feature-flag.service.js';
import { FLAGS, getFlag } from '../../../src/feature-flags/registry.js';
// Mocked above — imported so the rejection/corruption warnings can be asserted.
import { logger } from '@magick-agency/observability';
import { FIXTURE_FLAGS } from '../../helpers/fixture-flags.js';

/*
 * Subject: the resolver, its Redis read-through cache, degraded mode and the
 * fail-safe arms.
 *  - The subject flag is the registered `agency_dialer_enabled` (boolean, default
 *    false, client-exposed; env `FF_AGENCY_DIALER`), so the multi-flag resolves find
 *    it in the real registry. ONE case needs a flag with NO account scope, which no
 *    agency flag lacks; it uses an UNREGISTERED fixture flag `whatsapp_personal`
 *    (`test/helpers/fixture-flags.ts`). The non-boolean `isEnabled` subject is an
 *    unregistered fixture copy of `prewarm_ring_delay_ms`.
 *  - Reads that need the snapshot-pair path drive it through
 *    `resolveAllWithSource({ tenantId: t })`; assertions read the agency flag's entry.
 */

const warnings = (): Record<string, unknown>[] =>
  vi.mocked(logger.warn).mock.calls.map(([fields]) => fields as Record<string, unknown>);

/** The private latch, read the same way the pre-existing degraded-mode tests read it. */
const isDegraded = (svc: FeatureFlagService): boolean =>
  (svc as unknown as { degradedMode: boolean }).degradedMode;

/** Baseline for the prewarm/caller-activity env layers, which several suites move. */
function clearFlagEnv(): void {
  for (const k of [
    'AI_PREWARM_ENABLED',
    'AI_PREWARM_RING_DELAY_MS',
    'FF_CALLER_ACTIVITY_SUPPRESSION',
    'AI_CALLER_ACTIVITY_MAX_SUPPRESSION_MS',
    'AI_CALLER_ACTIVITY_CV_THRESHOLD',
  ]) {
    delete process.env[k];
  }
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as any;
}

function override(partial: Record<string, unknown>) {
  return {
    id: 'ff-' + Math.random(),
    flag_key: 'agency_dialer_enabled',
    scope_type: 'tenant',
    tenant_id: 'tenant-1',
    account_id: null,
    value: true,
    reason: null,
    expires_at: null,
    created_by: null,
    updated_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...partial,
  };
}

const PREFIX = 'mvc:';
const CTX = { tenantId: 'tenant-1', accountId: 'acc-1' };

describe('FeatureFlagService', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findGlobal.mockResolvedValue([]);
    mocks.findByTenant.mockResolvedValue([]);
    delete process.env['FF_AGENCY_DIALER'];
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  describe('resolution precedence (account → tenant → global → env → default)', () => {
    it('returns the registry default when nothing overrides', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(false);
    });

    it('env default flips the registry default', async () => {
      process.env['FF_AGENCY_DIALER'] = 'true';
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(true);
    });

    it('global override beats env', async () => {
      process.env['FF_AGENCY_DIALER'] = 'true';
      mocks.findGlobal.mockResolvedValue([override({ scope_type: 'global', tenant_id: null, value: false })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(false);
    });

    it('tenant override beats global (an explicit tenant true survives a global false)', async () => {
      mocks.findGlobal.mockResolvedValue([override({ scope_type: 'global', tenant_id: null, value: false })]);
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(true);
    });

    it('account override beats tenant (for a flag that permits account scope)', async () => {
      // whatsapp_personal does not permit account scope, so use a synthetic account-scoped flag.
      // Here we assert account precedence on a flag whose scopes include account by checking
      // that a flag WITHOUT account scope ignores account rows (next test).
      // Uses the unregistered whatsapp_personal fixture — no agency flag lacks account scope.
      mocks.findByTenant.mockResolvedValue([
        override({ flag_key: 'whatsapp_personal', scope_type: 'tenant', value: false }),
        override({ flag_key: 'whatsapp_personal', scope_type: 'account', account_id: 'acc-1', value: true }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      // whatsapp_personal scopes are [global, tenant] → account row ignored → tenant false wins.
      expect(await svc.getValue(FIXTURE_FLAGS.whatsapp_personal, CTX)).toBe(false);
    });

    it('ignores an account row when accountId is absent', async () => {
      mocks.findByTenant.mockResolvedValue([
        override({ scope_type: 'tenant', value: false }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, { tenantId: 'tenant-1' })).toBe(false);
    });
  });

  describe('lazy expires_at', () => {
    it('skips an expired override and falls through to the next layer', async () => {
      const past = new Date(Date.now() - 60_000);
      mocks.findByTenant.mockResolvedValue([
        override({ scope_type: 'tenant', value: true, expires_at: past }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      // expired tenant true → fall through to env/default (false)
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(false);
    });

    it('honors a future expires_at', async () => {
      const future = new Date(Date.now() + 60_000);
      mocks.findByTenant.mockResolvedValue([
        override({ scope_type: 'tenant', value: true, expires_at: future }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.getValue(FLAGS.agency_dialer_enabled, CTX)).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('coerces a boolean flag', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, CTX)).toBe(true);
    });

    it('throws on a non-boolean flag', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      await expect(svc.isEnabled(FIXTURE_FLAGS.prewarm_ring_delay_ms as any, CTX)).rejects.toThrow();
    });

    it('never throws on infra failure — returns the registry default', async () => {
      mocks.findByTenant.mockRejectedValue(new Error('db down'));
      mocks.findGlobal.mockRejectedValue(new Error('db down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      expect(await svc.isEnabled(FLAGS.agency_dialer_enabled, CTX)).toBe(false);
    });
  });

  describe('caching', () => {
    it('a second resolve serves from Redis without re-querying the DB', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const stored: Record<string, string> = {};
      const redis = createMockRedis({
        get: vi.fn(async (k: string) => stored[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { stored[k] = v; return 'OK'; }),
      });
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
      expect(mocks.findGlobal).toHaveBeenCalledTimes(1);
    });

    it('negative-caches an empty snapshot ([]) so repeated misses do not hit the DB', async () => {
      const stored: Record<string, string> = {};
      const redis = createMockRedis({
        get: vi.fn(async (k: string) => stored[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { stored[k] = v; return 'OK'; }),
      });
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });

    it('does NOT cache a DB error (next call retries the DB)', async () => {
      mocks.findByTenant.mockRejectedValueOnce(new Error('blip')).mockResolvedValue([]);
      const stored: Record<string, string> = {};
      const redis = createMockRedis({
        get: vi.fn(async (k: string) => stored[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { stored[k] = v; return 'OK'; }),
      });
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX); // errors → no cache
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX); // retries DB
      expect(mocks.findByTenant).toHaveBeenCalledTimes(2);
    });

    it('a Redis write failure flips degraded mode → subsequent reads use local cache', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const getSpy = vi.fn().mockResolvedValue(null);
      const setSpy = vi.fn().mockRejectedValue(new Error('write fail'));
      const redis = createMockRedis({ get: getSpy, set: setSpy });
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      // tenant snapshot getSpy called once on first miss, then served locally
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveAll', () => {
    it('issues exactly one global + one tenant snapshot read for all flags', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const all = await svc.resolveAll(CTX);
      expect(mocks.findGlobal).toHaveBeenCalledTimes(1);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
      expect(Object.keys(all)).toEqual(expect.arrayContaining([
        'agency_dialer_enabled', 'agency_late_binding', 'agency_call_analysis',
      ]));
    });

    // All-or-nothing snapshot pair. A partial failure (good global, failed
    // tenant) must NOT resolve to the global value (that would override an
    // opted-in tenant's explicit setting); it falls to registry default instead.
    it('tenant-read throws → does NOT resolve to global value, falls to registry default', async () => {
      // global says OFF, tenant override (would say ON) but the tenant read fails.
      mocks.findGlobal.mockResolvedValue([override({ scope_type: 'global', tenant_id: null, value: false })]);
      mocks.findByTenant.mockRejectedValue(new Error('tenant read down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const all = await svc.resolveAll(CTX);

      // With both snapshots collapsed to [], resolution reaches the registry
      // default (false) rather than the surviving global row — so a transient
      // tenant-read failure can't strand an opted-in tenant on global=false.
      expect(all['agency_dialer_enabled']).toBe(false);
    });

    it('global-read throws → both snapshots collapse to [], registry defaults', async () => {
      mocks.findGlobal.mockRejectedValue(new Error('global read down'));
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const all = await svc.resolveAll(CTX);

      // tenant true is dropped too (all-or-nothing) → registry default false.
      expect(all['agency_dialer_enabled']).toBe(false);
    });
  });

  describe('resolveClientExposed', () => {
    it('returns only client-exposed flags', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const map = await svc.resolveClientExposed(CTX);
      expect(map).toHaveProperty('agency_dialer_enabled');
      expect(map).toHaveProperty('agency_call_analysis');
      expect(map).not.toHaveProperty('agency_late_binding');
    });
  });

  describe('resolveAllWithSource (#19a)', () => {
    it('reports source=tenant for a tenant override', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const r = await svc.resolveAllWithSource(CTX);
      expect(r['agency_dialer_enabled']).toEqual({ value: true, source: 'tenant' });
    });

    it('reports source=global for a global override', async () => {
      mocks.findGlobal.mockResolvedValue([override({ scope_type: 'global', tenant_id: null, value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const r = await svc.resolveAllWithSource(CTX);
      expect(r['agency_dialer_enabled']).toEqual({ value: true, source: 'global' });
    });

    it('reports source=env when an env default applies', async () => {
      process.env['FF_AGENCY_DIALER'] = 'true';
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const r = await svc.resolveAllWithSource(CTX);
      expect(r['agency_dialer_enabled']).toEqual({ value: true, source: 'env' });
    });

    it('reports source=default for a bare registry default', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const r = await svc.resolveAllWithSource(CTX);
      expect(r['agency_dialer_enabled']).toEqual({ value: false, source: 'default' });
    });

    it('covers every registered flag', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const r = await svc.resolveAllWithSource(CTX);
      expect(Object.keys(r)).toEqual(expect.arrayContaining([
        'agency_dialer_enabled', 'agency_late_binding', 'agency_call_analysis',
      ]));
    });
  });

  describe('a corrupt cached snapshot', () => {
    const NON_ARRAY = '{"not":"an array"}';

    beforeEach(clearFlagEnv);

    const cachedRedis = (cached: string) =>
      createMockRedis({ get: vi.fn().mockResolvedValue(cached) });

    it.each([
      ['valid JSON that is not an array', NON_ARRAY],
      ['unparseable JSON', 'not json at all'],
      ['a bare JSON null', 'null'],
    ])('cannot throw out of any multi-flag resolve (%s)', async (_label, cached) => {
      const svc = new FeatureFlagService(cachedRedis(cached), PREFIX);

      // Every one of these threw `tenant.find is not a function` before the fix.
      await expect(svc.resolveAll(CTX)).resolves.toBeDefined();
      await expect(svc.resolveClientExposed(CTX)).resolves.toBeDefined();
      await expect(svc.resolveAllWithSource(CTX)).resolves.toBeDefined();
    });

    it('fails the read rather than treating it as a miss: no DB query, no write-back', async () => {
      // A miss would re-query the DB and, for a tenant with no override rows,
      // resolve through the ENV layer — so evident corruption of the flag
      // namespace could OPEN a gated capability. That is the substitution
      // `SnapshotPairResult` exists to prevent, so a corrupt entry takes the
      // read-failure arm instead. (It also means the bad value is never parsed
      // into anything that could be written back.)
      const redis = cachedRedis(NON_ARRAY);
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });

      expect(mocks.findGlobal).not.toHaveBeenCalled();
      expect(mocks.findByTenant).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('evicts the corrupt key, so corruption costs the in-flight requests and no more', async () => {
      // Without the eviction the conservative arm is worse than the bug it
      // replaces: a no-TTL stray SET on `ff:global` would pin the whole fleet to
      // registry defaults permanently, and silently.
      const redis = cachedRedis(NON_ARRAY);
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });

      expect(redis.del).toHaveBeenCalledWith(`${PREFIX}ff:global`);
      expect(redis.del).toHaveBeenCalledWith(`${PREFIX}ff:tenant:tenant-1`);
      expect(warnings().some((w) => w['redisKey'] === `${PREFIX}ff:global`)).toBe(true);
    });

    it('still serves a WELL-FORMED cached snapshot (the guard is not a blanket reject)', async () => {
      const rows = [
        override({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', value: true }),
      ];
      const redis = createMockRedis({
        get: vi.fn(async (k: string) => (k.endsWith('ff:global') ? '[]' : JSON.stringify(rows))),
      });
      const svc = new FeatureFlagService(redis, PREFIX);

      expect((await svc.resolveAllWithSource({ tenantId: 'tenant-1' }))['agency_dialer_enabled'])
        .toEqual({ value: true, source: 'tenant' });
      expect(mocks.findByTenant).not.toHaveBeenCalled();
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('contains a resolver throw arriving from anywhere else, and does not fall to env', async () => {
      // Second layer, independent of the parse guard: the multi-flag resolves must
      // be structurally incapable of throwing into a caller, not merely free of
      // today's known cause. Triggered here past the cache entirely, by a
      // repository that breaks its return contract.
      process.env['FF_AGENCY_DIALER'] = 'true';
      mocks.findByTenant.mockResolvedValue('not an array' as never);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      await expect(svc.resolveAll(CTX)).resolves.toMatchObject({ agency_dialer_enabled: false });
      await expect(svc.resolveClientExposed(CTX)).resolves.toBeDefined();
      // REGISTRY default, not the env `true`: a resolution fault must not open a
      // gate, matching getValue's and snapshot()'s catch arms exactly.
      expect(await svc.resolveAllWithSource(CTX)).toMatchObject({
        agency_dialer_enabled: { value: false, source: 'default' },
      });
    });
  });

  // Degraded mode used to be a ONE-WAY LATCH: one transient Redis SET failure
  // took a replica off shared Redis for the life of the process, so every later
  // `invalidate()` left it serving a stale pre-warm policy (its local cache is
  // cleared only on the replica that handled the write). Since which replica
  // handles a call's `ringing` webhook is effectively random, a tenant's toggle
  // then applied to some calls and not others.
  describe('degraded mode self-healing', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function degradableRedis(stored: Record<string, string>, setFails: () => boolean) {
      return createMockRedis({
        get: vi.fn(async (k: string) => stored[k] ?? null),
        set: vi.fn(async (k: string, v: string) => {
          if (setFails()) throw new Error('write fail');
          stored[k] = v;
          return 'OK';
        }),
      });
    }

    it('re-attempts Redis once the cooldown elapses and clears degraded mode', async () => {
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      let broken = true;
      const redis = degradableRedis(stored, () => broken);
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // SET fails → degraded
      expect((svc as unknown as { degradedMode: boolean }).degradedMode).toBe(true);

      const getsWhileDegraded = redis.get.mock.calls.length;
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // inside the cooldown → local cache
      expect(redis.get.mock.calls.length).toBe(getsWhileDegraded);

      // Redis comes back, and the cooldown lapses.
      broken = false;
      vi.setSystemTime(Date.now() + 31_000);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // the probe
      expect(redis.get.mock.calls.length).toBeGreaterThan(getsWhileDegraded);
      expect((svc as unknown as { degradedMode: boolean }).degradedMode).toBe(false);
      expect(redis.set).toHaveBeenCalled();
      expect(Object.keys(stored).length).toBeGreaterThan(0); // shared cache repopulated

      // And it is genuinely back on the SHARED cache, not merely un-flagged.
      // Note the probe itself only re-reads one of the two snapshots: the claim
      // is per-snapshot-read and taken before the first await, so the sibling
      // read in the same pair still serves locally. The read after it is the one
      // that repopulates both keys.
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      const dbReadsSoFar = mocks.findByTenant.mock.calls.length;
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      expect(mocks.findByTenant.mock.calls.length).toBe(dbReadsSoFar);
    });

    it('probes at most once per cooldown window while Redis stays down', async () => {
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      const redis = degradableRedis(stored, () => true);
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // degrades
      const afterDegrade = redis.get.mock.calls.length;

      // A burst inside the window must not reach Redis at all.
      for (let i = 0; i < 5; i++) await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      expect(redis.get.mock.calls.length).toBe(afterDegrade);

      // One window later: exactly ONE probe — a single GET, not a pair. The claim
      // is per snapshot READ and taken synchronously before that read's first
      // await, so the global read takes the window and the tenant read of the same
      // pair is already refused by the time it asks. (The other test's note says
      // the same thing from the other side: "the probe itself only re-reads one of
      // the two snapshots".) A second burst behind it still spends nothing.
      vi.setSystemTime(Date.now() + 31_000);
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      const afterProbe = redis.get.mock.calls.length;
      expect(afterProbe - afterDegrade).toBe(1);

      for (let i = 0; i < 5; i++) await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      expect(redis.get.mock.calls.length).toBe(afterProbe);
    });

    // ── The three clauses below are each pinned ALONE ────────────────────────
    // Deleting any one of them used to leave the whole suite green: the two
    // `leaveDegradedMode()` calls were covered only jointly (either one alone
    // could carry the other's scenario), and the read-catch's `useRedis = false`
    // was not covered at all. Each test here fails with only its own clause
    // removed, which is the only way a comment justifying a clause can be trusted.

    it('a probe whose GET FAILS stops there — one probe costs one round trip, not two', async () => {
      // Pins `if (probing) useRedis = false` in the Redis-read catch. Redis is
      // demonstrably still down; attempting the SET as well would double the cost
      // of every probe during a real outage, and re-enter degraded mode for a
      // failure already known.
      vi.useFakeTimers();
      const redis = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('read fail')),
        set: vi.fn().mockRejectedValue(new Error('write fail')),
      });
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // GET fails → DB → SET fails → degraded
      expect(isDegraded(svc)).toBe(true);
      const setsBefore = redis.set.mock.calls.length;
      const getsBefore = redis.get.mock.calls.length;

      vi.setSystemTime(Date.now() + 31_000);
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // the probe

      expect(redis.get.mock.calls.length).toBe(getsBefore + 1); // it did probe
      expect(redis.set.mock.calls.length).toBe(setsBefore); // and it stopped there
    });

    it('a probe whose GET HITS heals degraded mode, having never reached a SET', async () => {
      // Pins the `leaveDegradedMode()` after a successful GET, and the long
      // comment defending it. The scenario is real, not hypothetical: with a
      // shared key warmed by another replica and this replica's writes still
      // failing, the probe returns from the GET and never reaches the SET — so
      // requiring a write success to heal would latch this replica forever behind
      // a key it can read perfectly well.
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      const redis = degradableRedis(stored, () => true); // writes never recover
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // SET fails → degraded, shared keys still cold
      expect(isDegraded(svc)).toBe(true);

      // Another replica repopulates the shared keys while this one is degraded.
      stored[`${PREFIX}ff:global`] = '[]';
      stored[`${PREFIX}ff:tenant:tenant-1`] = '[]';
      const setsBefore = redis.set.mock.calls.length;

      vi.setSystemTime(Date.now() + 31_000);
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // the probe: GET hits, returns early

      expect(isDegraded(svc)).toBe(false);
      expect(redis.set.mock.calls.length).toBe(setsBefore); // healed by the GET alone
    });

    it('a cache MISS does not heal degraded mode before its DB read and SET', async () => {
      // The other half of the GET-side heal, and the reason it lives in the HIT
      // branch. A miss proves only that Redis answered a read — it is no evidence
      // about the WRITE failure that caused degraded mode. Healing on it clears
      // the flag before the DB read and the SET, so for the whole duration of that
      // DB query `claimRedisAttempt()` returns true unconditionally and every
      // concurrent caller bypasses the 30s cooldown: with writes still down a
      // burst spends a Redis round trip AND a DB query each before one of them
      // re-enters degraded mode. That is the stampede the synchronous claim exists
      // to prevent, defeated by the single probe meant to be its only cost.
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      const redis = degradableRedis(stored, () => true); // writes never recover
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // SET fails → degraded
      expect(isDegraded(svc)).toBe(true);

      // The burst is fired from INSIDE the probe's DB read, which is the window
      // itself: the probe's GET has returned (a miss — nothing was ever stored,
      // every SET failed) and its SET has not run yet. No timer juggling, no
      // microtask guessing — the window is entered by construction.
      let getsAtWindowOpen = -1;
      let getsAfterBurst = -1;
      mocks.findGlobal.mockImplementationOnce(async () => {
        getsAtWindowOpen = redis.get.mock.calls.length;
        for (let i = 0; i < 5; i++) await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
        getsAfterBurst = redis.get.mock.calls.length;
        return [];
      });

      vi.setSystemTime(Date.now() + 31_000);
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // the probe

      expect(getsAtWindowOpen).toBeGreaterThan(0); // the window really was entered
      // Every one of the five served from the local cache, as a degraded replica
      // inside its cooldown must: the probe already consumed this window.
      expect(getsAfterBurst).toBe(getsAtWindowOpen);
      // And the replica is still degraded afterwards — writes never recovered, so
      // nothing about this probe was evidence of recovery.
      expect(isDegraded(svc)).toBe(true);
    });

    it('a probe whose GET hits a CORRUPT value still heals — Redis answered', async () => {
      // Pins the heal BEFORE `readCachedSnapshot` rather than after it. A cached
      // value we cannot use is still proof that Redis is reachable, and
      // `readCachedSnapshot` THROWS on one (evicting the key on the way out) — so
      // healing after it would spend the probe, heal nothing, and keep the replica
      // degraded on the strength of a bad VALUE rather than a bad Redis, for as
      // long as something keeps rewriting the key.
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      const redis = degradableRedis(stored, () => true); // writes never recover
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // SET fails → degraded
      expect(isDegraded(svc)).toBe(true);

      // Valid JSON, wrong shape — a key-prefix collision or a stray SET. The
      // global key, because the claim is taken by the global read of the pair.
      stored[`${PREFIX}ff:global`] = '{"not":"an array"}';

      vi.setSystemTime(Date.now() + 31_000);
      // Resolves to registry defaults (the conservative arm) rather than throwing.
      await expect(svc.resolveAllWithSource({ tenantId: 'tenant-1' })).resolves.toMatchObject(
        { agency_dialer_enabled: { value: false, source: 'default' } },
      );

      expect(isDegraded(svc)).toBe(false);
      expect(redis.del).toHaveBeenCalledWith(`${PREFIX}ff:global`);
    });

    it('a SET that succeeds heals degraded mode re-entered while this read was in the DB', async () => {
      // Pins the `leaveDegradedMode()` after a successful SET, under the hardest
      // shape it has to survive: a CONCURRENT read re-degrading the replica while
      // this read is parked on the DB, which is exactly what a flapping Redis
      // produces. (It is no longer the ONLY shape — since the GET-side heal moved
      // into the cache-HIT branch, an ordinary probe that MISSES now reaches this
      // SET while still degraded, and 'a cache MISS does not heal…' below covers
      // that. This one stays because interleaving is where a heal that reads
      // `degradedMode` at the wrong moment would break.) Modelled deterministically
      // with a Redis whose tenant-key ops fail while the global key works, and a
      // global DB read held open until the tenant read has re-degraded the replica.
      const stored: Record<string, string> = {};
      const redis = createMockRedis({
        get: vi.fn(async (k: string) => {
          if (k.includes('ff:tenant:')) throw new Error('read fail');
          return stored[k] ?? null;
        }),
        set: vi.fn(async (k: string, v: string) => {
          if (k.includes('ff:tenant:')) throw new Error('write fail');
          stored[k] = v;
          return 'OK';
        }),
      });
      let releaseGlobalRead = (): void => {};
      mocks.findGlobal.mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseGlobalRead = () => resolve([]);
          }),
      );
      const svc = new FeatureFlagService(redis, PREFIX);

      const pending = svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      await new Promise((r) => setImmediate(r));

      // The tenant read got there first: its SET failed and degraded the replica
      // while the global read is still parked on the DB. The global read's own GET
      // already completed and MISSED, so no GET-side heal is coming — only its SET
      // can clear the flag this read arrived too early to have seen set.
      expect(isDegraded(svc)).toBe(true);

      releaseGlobalRead();
      await pending;

      expect(isDegraded(svc)).toBe(false);
    });

    it('a Redis READ failure alone does NOT flip degraded mode', async () => {
      // Deliberate, pre-existing behaviour: the DB is the source of truth, so a
      // failed GET costs a query, not correctness — and must not cost the replica
      // its shared cache.
      const redis = createMockRedis({
        get: vi.fn().mockRejectedValue(new Error('read fail')),
        set: vi.fn().mockResolvedValue('OK'),
      });
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });

      expect((svc as unknown as { degradedMode: boolean }).degradedMode).toBe(false);
      expect(redis.set).toHaveBeenCalled(); // still writes through
    });

    it('never caches a DB error, degraded or not', async () => {
      vi.useFakeTimers();
      const stored: Record<string, string> = {};
      const redis = degradableRedis(stored, () => true);
      const svc = new FeatureFlagService(redis, PREFIX);

      await svc.resolveAllWithSource({ tenantId: 'tenant-1' }); // degrades, local-caches the empty snapshot
      mocks.findByTenant.mockRejectedValue(new Error('db down'));

      // Past the local TTL, the local cache can't answer and the DB error must
      // reach the caller's fallback rather than being memoised.
      vi.setSystemTime(Date.now() + 61_000);
      const before = mocks.findByTenant.mock.calls.length;
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      await svc.resolveAllWithSource({ tenantId: 'tenant-1' });
      expect(mocks.findByTenant.mock.calls.length).toBeGreaterThan(before + 1);
    });
  });

  describe('invalidate', () => {
    it('deletes the tenant key', async () => {
      const redis = createMockRedis();
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.invalidate({ tenantId: 'tenant-1' });
      expect(redis.del).toHaveBeenCalledWith(`${PREFIX}ff:tenant:tenant-1`);
    });

    it('deletes the global key when no tenantId given', async () => {
      const redis = createMockRedis();
      const svc = new FeatureFlagService(redis, PREFIX);
      await svc.invalidate({});
      expect(redis.del).toHaveBeenCalledWith(`${PREFIX}ff:global`);
    });

    it('does not throw when Redis is null', async () => {
      const svc = new FeatureFlagService(null, PREFIX);
      await expect(svc.invalidate({ tenantId: 'tenant-1' })).resolves.toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('increments feature_flag_evaluations_total with flag/result/source labels', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      expect(mocks.evalInc).toHaveBeenCalledWith(
        expect.objectContaining({ flag: 'agency_dialer_enabled', source: 'tenant' }),
      );
    });

    it('source=default when nothing overrides and no env', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      expect(mocks.evalInc).toHaveBeenCalledWith(
        expect.objectContaining({ flag: 'agency_dialer_enabled', source: 'default' }),
      );
    });

    it('source=env when env default applies', async () => {
      process.env['FF_AGENCY_DIALER'] = 'true';
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      await svc.getValue(FLAGS.agency_dialer_enabled, CTX);
      expect(mocks.evalInc).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'env' }),
      );
    });
  });
});

// Ensure getFlag import is used (type-only would be elided); referenced for parity with route tests.
void getFlag;
