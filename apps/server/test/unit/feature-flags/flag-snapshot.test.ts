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
import { FLAGS as REGISTERED_FLAGS } from '../../../src/feature-flags/registry.js';
import { FIXTURE_FLAGS } from '../../helpers/fixture-flags.js';

/*
 * Subject: the snapshot reader's resolution and failure semantics.
 *  - The GATED flag is `agency_dialer_enabled` (registered; boolean, default
 *    false, env `FF_AGENCY_DIALER`, global+tenant+account — exactly
 *    `custom_sip`'s shape), so the `resolveAll` cases resolve it from the real
 *    registry;
 *  - every other flag (`knowledge_bases_enabled`, `webrtc_calls_enabled`, `gold_ii`,
 *    `max_sip_connections`, `whatsapp_personal`, `prewarm_ring_delay_ms`) is an
 *    UNREGISTERED fixture definition (`test/helpers/fixture-flags.ts`) — the
 *    snapshot reader resolves the definition it is handed.
 */
const FLAGS = { ...FIXTURE_FLAGS, custom_sip: REGISTERED_FLAGS.agency_dialer_enabled };

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

// `custom_sip` is boolean, defaults false, has envVar FF_CUSTOM_SIP and permits
// global/tenant/account scope — i.e. exactly the gated-capability shape the
// snapshot path's failure semantics are about.
// `agency_dialer_enabled` has that shape (see the header).
const GATED = FLAGS.custom_sip;
const GATED_ENV = 'FF_AGENCY_DIALER';

describe('FeatureFlagService.snapshot (request-scoped flag snapshot)', () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findGlobal.mockResolvedValue([]);
    mocks.findByTenant.mockResolvedValue([]);
    delete process.env[GATED_ENV];
    delete process.env['FF_KNOWLEDGE_BASES'];
    delete process.env['FF_MAX_SIP_CONNECTIONS'];
  });
  afterEach(() => {
    process.env = { ...ORIG };
  });

  describe('one round-trip pair serves many resolutions', () => {
    it('reads the global + tenant snapshot exactly once for N isEnabled calls', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      snap.isEnabled(FLAGS.custom_sip);
      snap.isEnabled(FLAGS.knowledge_bases_enabled);
      snap.isEnabled(FLAGS.webrtc_calls_enabled);
      snap.isEnabled(FLAGS.gold_ii);
      snap.getValue(FLAGS.max_sip_connections);

      expect(mocks.findGlobal).toHaveBeenCalledTimes(1);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });

    it('is cheaper than N separate isEnabled calls (which each read a pair)', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      // Baseline: three independent gates = three snapshot pair reads. (No Redis
      // hit is stored because createMockRedis().get always returns null.)
      await svc.isEnabled(FLAGS.custom_sip, CTX);
      await svc.isEnabled(FLAGS.knowledge_bases_enabled, CTX);
      await svc.isEnabled(FLAGS.webrtc_calls_enabled, CTX);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(3);

      vi.clearAllMocks();
      mocks.findGlobal.mockResolvedValue([]);
      mocks.findByTenant.mockResolvedValue([]);

      const snap = await svc.snapshot(CTX);
      snap.isEnabled(FLAGS.custom_sip);
      snap.isEnabled(FLAGS.knowledge_bases_enabled);
      snap.isEnabled(FLAGS.webrtc_calls_enabled);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });

    it('the reader is a point-in-time view — a later override is not observed', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);

      // Flag flipped on after the snapshot was taken.
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);

      expect(snap.isEnabled(GATED)).toBe(false);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });
  });

  describe('precedence matches getValue for the same inputs', () => {
    it('account beats tenant beats global beats env beats registry default', async () => {
      process.env[GATED_ENV] = 'true';

      // env=true, global=false, tenant=true, account=false → account wins.
      mocks.findGlobal.mockResolvedValue([
        override({ scope_type: 'global', tenant_id: null, value: false }),
      ]);
      mocks.findByTenant.mockResolvedValue([
        override({ scope_type: 'tenant', value: true }),
        override({ scope_type: 'account', account_id: 'acc-1', value: false }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('tenant beats global', async () => {
      mocks.findGlobal.mockResolvedValue([
        override({ scope_type: 'global', tenant_id: null, value: false }),
      ]);
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(true);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('global beats env', async () => {
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockResolvedValue([
        override({ scope_type: 'global', tenant_id: null, value: false }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('env beats the registry default', async () => {
      process.env[GATED_ENV] = 'true';
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(true);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('falls to the registry default when nothing overrides', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('resolves a typed (number) flag identically to getValue', async () => {
      mocks.findByTenant.mockResolvedValue([
        override({ flag_key: 'max_sip_connections', scope_type: 'tenant', value: 42 }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.getValue(FLAGS.max_sip_connections)).toBe(42);
      expect(snap.getValue(FLAGS.max_sip_connections)).toBe(
        await svc.getValue(FLAGS.max_sip_connections, CTX),
      );
    });

    it('skips an expired override, like getValue', async () => {
      mocks.findByTenant.mockResolvedValue([
        override({ scope_type: 'tenant', value: true, expires_at: new Date(Date.now() - 60_000) }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('ignores an account row for a flag that does not permit account scope', async () => {
      // whatsapp_personal scopes are [global, tenant] → the account row is ignored.
      mocks.findByTenant.mockResolvedValue([
        override({ flag_key: 'whatsapp_personal', scope_type: 'tenant', value: false }),
        override({
          flag_key: 'whatsapp_personal',
          scope_type: 'account',
          account_id: 'acc-1',
          value: true,
        }),
      ]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(FLAGS.whatsapp_personal)).toBe(false);
      expect(snap.isEnabled(FLAGS.whatsapp_personal)).toBe(
        await svc.isEnabled(FLAGS.whatsapp_personal, CTX),
      );
    });
  });

  describe('failure semantics are byte-identical to getValue (the critical case)', () => {
    it('a failed snapshot read resolves the REGISTRY default even with the env var set ON', async () => {
      // The whole point: an infra outage must not silently OPEN a gated
      // capability whose env var says "on". getValue's catch returns
      // flag.default (false), NOT the env default (true).
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockRejectedValue(new Error('redis + db down'));
      mocks.findByTenant.mockRejectedValue(new Error('redis + db down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);

      expect(snap.isEnabled(GATED)).toBe(false);
      // …and identical to what getValue does under the very same failure.
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
      expect(await svc.getValue(GATED, CTX)).toBe(false);
    });

    it('a failed read on a typed flag resolves the registry default, not the env default', async () => {
      process.env['FF_MAX_SIP_CONNECTIONS'] = '99';
      mocks.findGlobal.mockRejectedValue(new Error('down'));
      mocks.findByTenant.mockRejectedValue(new Error('down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);

      expect(snap.getValue(FLAGS.max_sip_connections)).toBe(FLAGS.max_sip_connections.default);
      expect(snap.getValue(FLAGS.max_sip_connections)).toBe(
        await svc.getValue(FLAGS.max_sip_connections, CTX),
      );
    });

    it('a PARTIAL failure (tenant read throws) is all-or-nothing → registry default, not the surviving global', async () => {
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockResolvedValue([
        override({ scope_type: 'global', tenant_id: null, value: true }),
      ]);
      mocks.findByTenant.mockRejectedValue(new Error('tenant read down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('a tenant with genuinely NO overrides still resolves the env default (empty ≠ failed)', async () => {
      // Proves the failure path is detected by the read reporting failure, not by
      // the pair being two empty arrays — which is the ordinary, healthy case.
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockResolvedValue([]);
      mocks.findByTenant.mockResolvedValue([]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);

      expect(snap.isEnabled(GATED)).toBe(true);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('an empty pair from Redis (cached "[]") also resolves the env default', async () => {
      process.env[GATED_ENV] = 'true';
      const redis = createMockRedis({ get: vi.fn().mockResolvedValue('[]') });
      const svc = new FeatureFlagService(redis, PREFIX);

      const snap = await svc.snapshot(CTX);

      expect(snap.isEnabled(GATED)).toBe(true);
      expect(mocks.findByTenant).not.toHaveBeenCalled();
    });

    it('snapshot() itself never throws on infra failure', async () => {
      mocks.findGlobal.mockRejectedValue(new Error('down'));
      mocks.findByTenant.mockRejectedValue(new Error('down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      await expect(svc.snapshot(CTX)).resolves.toBeDefined();
    });
  });

  describe('isEnabled type guard', () => {
    it('throws on a non-boolean flag, like the async isEnabled', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);

      expect(() => snap.isEnabled(FLAGS.prewarm_ring_delay_ms as any)).toThrow(
        /non-boolean flag 'prewarm_ring_delay_ms'/,
      );
      await expect(svc.isEnabled(FLAGS.prewarm_ring_delay_ms as any, CTX)).rejects.toThrow(
        /non-boolean flag 'prewarm_ring_delay_ms'/,
      );
    });

    it('does not record an evaluation for the rejected non-boolean flag', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();

      expect(() => snap.isEnabled(FLAGS.prewarm_ring_delay_ms as any)).toThrow();
      expect(mocks.evalInc).not.toHaveBeenCalled();
    });
  });

  describe('recordEval / metrics', () => {
    it('records one evaluation per resolution, with the resolving source', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();

      snap.isEnabled(GATED);

      expect(mocks.evalInc).toHaveBeenCalledTimes(1);
      expect(mocks.evalInc).toHaveBeenCalledWith({
        flag: 'agency_dialer_enabled',
        result: 'true',
        source: 'tenant',
      });
    });

    it('records source=env / source=default for the lower layers', async () => {
      process.env[GATED_ENV] = 'true';
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();

      snap.isEnabled(GATED);
      expect(mocks.evalInc).toHaveBeenCalledWith({
        flag: 'agency_dialer_enabled',
        result: 'true',
        source: 'env',
      });

      mocks.evalInc.mockClear();
      snap.isEnabled(FLAGS.knowledge_bases_enabled);
      expect(mocks.evalInc).toHaveBeenCalledWith({
        flag: 'knowledge_bases_enabled',
        result: 'false',
        source: 'default',
      });
    });

    it('records source=default on a failed snapshot read — matching getValue’s catch arm', async () => {
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockRejectedValue(new Error('down'));
      mocks.findByTenant.mockRejectedValue(new Error('down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();
      snap.isEnabled(GATED);
      const fromSnapshot = mocks.evalInc.mock.calls[0]?.[0];

      mocks.evalInc.mockClear();
      await svc.isEnabled(GATED, CTX);
      const fromGetValue = mocks.evalInc.mock.calls[0]?.[0];

      expect(fromSnapshot).toEqual({ flag: 'agency_dialer_enabled', result: 'false', source: 'default' });
      expect(fromSnapshot).toEqual(fromGetValue);
    });

    it('records a typed flag as result=value', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();

      snap.getValue(FLAGS.max_sip_connections);

      expect(mocks.evalInc).toHaveBeenCalledWith({
        flag: 'max_sip_connections',
        result: 'value',
        source: 'default',
      });
    });

    it('emits one evaluation per read, so repeated reads of one flag each count', async () => {
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);
      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();

      snap.isEnabled(GATED);
      snap.isEnabled(GATED);
      snap.isEnabled(GATED);

      expect(mocks.evalInc).toHaveBeenCalledTimes(3);
    });
  });

  describe('existing callers are untouched', () => {
    it('resolveAll still collapses a failed pair to registry defaults', async () => {
      process.env[GATED_ENV] = 'true';
      mocks.findGlobal.mockRejectedValue(new Error('down'));
      mocks.findByTenant.mockRejectedValue(new Error('down'));
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const all = await svc.resolveAll(CTX);

      // Unchanged legacy behaviour: resolveAll's [[], []] reaches the ENV
      // default. (This is exactly the divergence snapshot() deliberately does
      // NOT inherit — pinned here so the two stay distinguishable.)
      expect(all['agency_dialer_enabled']).toBe(true);
    });

    it('resolveAll still resolves normally on a healthy read', async () => {
      mocks.findByTenant.mockResolvedValue([override({ scope_type: 'tenant', value: true })]);
      const svc = new FeatureFlagService(createMockRedis(), PREFIX);

      const all = await svc.resolveAll(CTX);
      expect(all['agency_dialer_enabled']).toBe(true);
      expect(mocks.findGlobal).toHaveBeenCalledTimes(1);
      expect(mocks.findByTenant).toHaveBeenCalledTimes(1);
    });
  });

  // The defect this pins turned a graceful degradation into a total outage of
  // call creation. `getValue` wraps BOTH the snapshot read and `resolveFrom` in
  // one try/catch; `snapshot()`'s reader originally guarded only the read. It is
  // reachable because `getSnapshot` does `JSON.parse(cached)` with no shape
  // check — a Redis value that is valid JSON but NOT an array (corruption, a
  // stray SET, a key-prefix collision) makes `resolveFrom`'s `.find` throw a
  // TypeError. Escaping `snapshot().isEnabled`, that TypeError rejected the
  // preflight stage and 500'd every call-creation request, where the same input
  // through `getValue` had degraded to the registry default (a 403).
  describe('a resolver throw degrades exactly as getValue does', () => {
    const NON_ARRAY_JSON = '{"not":"an array"}';

    it('isEnabled does not throw, and returns what getValue returns', async () => {
      const svc = new FeatureFlagService(
        createMockRedis({ get: vi.fn().mockResolvedValue(NON_ARRAY_JSON) }),
        PREFIX,
      );

      const viaGetValue = await svc.isEnabled(GATED, CTX);
      const snap = await svc.snapshot(CTX);

      expect(() => snap.isEnabled(GATED)).not.toThrow();
      expect(snap.isEnabled(GATED)).toBe(viaGetValue);
      expect(snap.isEnabled(GATED)).toBe(GATED.default);
    });

    it('resolves the REGISTRY default even when the env var would open the gate', async () => {
      // The whole point of the arm: a gated capability must not swing open
      // because a resolution fault skipped past the layers that keep it shut.
      process.env[GATED_ENV] = 'true';
      const svc = new FeatureFlagService(
        createMockRedis({ get: vi.fn().mockResolvedValue(NON_ARRAY_JSON) }),
        PREFIX,
      );

      const snap = await svc.snapshot(CTX);

      expect(snap.isEnabled(GATED)).toBe(false);
      expect(snap.isEnabled(GATED)).toBe(await svc.isEnabled(GATED, CTX));
    });

    it('getValue through the snapshot degrades the same way', async () => {
      const svc = new FeatureFlagService(
        createMockRedis({ get: vi.fn().mockResolvedValue(NON_ARRAY_JSON) }),
        PREFIX,
      );

      const snap = await svc.snapshot(CTX);

      expect(() => snap.getValue(GATED)).not.toThrow();
      expect(snap.getValue(GATED)).toBe(GATED.default);
    });

    it("records the evaluation with source 'default', matching getValue's catch arm", async () => {
      const svc = new FeatureFlagService(
        createMockRedis({ get: vi.fn().mockResolvedValue(NON_ARRAY_JSON) }),
        PREFIX,
      );

      const snap = await svc.snapshot(CTX);
      mocks.evalInc.mockClear();
      snap.isEnabled(GATED);

      expect(mocks.evalInc).toHaveBeenCalledWith(
        expect.objectContaining({ flag: GATED.key, source: 'default' }),
      );
    });
  });
});
