/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/routes/super-admin-feature-flags.test.ts@a1f0756a
 * (35 cases → 22: 21 kept or modified, 14 deleted — one of them an it.each row — and 1 NEW).
 * The route is a HOP COLLAPSE (`src/api/routes/super-admin-feature-flags.routes.ts`):
 * master's validation + audit run over core's `/internal/feature-flags*` handler bodies
 * in-process, so master's assertions on the OUTGOING core request become assertions on the
 * in-process effect — the `featureFlagRepository` call, the flag-service `invalidate` /
 * `resolveAllWithSource` call, and the response body. Test names are kept verbatim; where a
 * name says "core", it now means core's handler body running in-process.
 * Changes forced by the port:
 *  - ids are UUIDs (`tenant-1`, `t1`, `acc-1` → TENANT_1 …): the validator is `.uuid()` because
 *    `feature_flag_overrides.tenant_id/account_id` are UUID columns in the baseline.
 *  - `whatsapp_personal` (not an agency flag) → `agency_dialer_enabled`. Master's policy flag
 *    `ai_turn_transcript_logging` and `prewarm_enabled` are unregistered fixture copies of
 *    core's definitions (`@4850d1d9`), resolved through a `getFlag` fallback below — the same
 *    technique as `test/helpers/fixture-flags.ts`; `allFlags()` never sees them.
 *  - 'does NOT audit locally when core rejects (4xx)': the in-process handler only rejects a
 *    bad body, so the payload's value is `'yes'` (core's `Invalid Value` 422).
 *  - 'GET /feature-flags/resolve validates + 404s an unknown tenant': `ghost` is now a 400
 *    (non-UUID), so the unknown tenant is a well-formed UUID; NEW case pins the 400.
 *  - 'a global enable is left to core (its 422 Invalid Scope)…': asserts the in-process 422 and
 *    that nothing was written (was: core called once).
 *  - 'core 4xx through the global error mask': agency has no `errorMaskHook`, so the "masked"
 *    app is a plain Fastify app; the bodies asserted are the route's own first-party 4xx.
 * Deleted:
 *  - 'broadcast_concurrency cache bust' (2): master's broadcast-concurrency cache; no broadcast
 *    campaigns in agency (`afterOverrideWrite` deleted, route PORT NOTE).
 *  - '502 when the core call throws': no core hop to be unreachable.
 *  - policy: the 3 it.each 'refuses an enable with a %s reason, before core' rows, 'refuses bulk
 *    outright (422)…', 'annotates the catalog entry…', 'annotates the per-flag detail', 'a
 *    prototype-named key gets no policy': `flag-policies` is deleted (no agency flag has a
 *    policy, route PORT NOTE), so there is no reason-required / bulk-refused / `policy` field.
 *  - it.each row `POST overrides/bulk … 422 Invalid Scope`: unreachable — every flag in core's
 *    and agency's registries permits tenant scope.
 *  - "Fastify's unmatched-route 404 from core stays masked", 'an unreviewed core 4xx label is
 *    still masked', 'a core 5xx is still masked even with a reviewed label': no core response
 *    and no error mask to test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-secret-1234567890';

const mocks = vi.hoisted(() => ({
  superAdminRepo: { findById: vi.fn() },
  tenantRepo: { findById: vi.fn() },
  auditLog: vi.fn().mockResolvedValue(undefined),
  // PORT NOTE (magick-agency): core's handler collaborators, which replace `coreInternalRequest`.
  flagRepo: {
    findGlobal: vi.fn(),
    findByFlag: vi.fn(),
    findByTenant: vi.fn(),
    findOne: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  },
  resolveAllWithSource: vi.fn(),
  invalidate: vi.fn(),
  coreAuditLog: vi.fn(),
}));

vi.mock('../../../../src/config/index.js', () => ({
  config: { superAdmin: { jwtSecret: 'test-secret-1234567890' } },
}));
vi.mock('@magick-agency/db/repositories/super-admin.repository', () => ({
  superAdminRepository: mocks.superAdminRepo,
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepo,
}));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.auditLog },
}));
vi.mock('@magick-agency/db/repositories/feature-flag.repository', () => ({
  featureFlagRepository: mocks.flagRepo,
}));
vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    resolveAllWithSource: mocks.resolveAllWithSource,
    invalidate: mocks.invalidate,
  }),
}));
vi.mock('../../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: mocks.coreAuditLog },
}));
// PORT NOTE (magick-agency): unregistered fixture flags, resolvable by key only.
vi.mock('../../../../src/feature-flags/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/feature-flags/registry.js')>();
  const { FIXTURE_FLAGS } = await import('../../../helpers/fixture-flags.js');
  const fixtures = new Map<string, import('../../../../src/feature-flags/registry.js').FlagDefinition>([
    // core `src/feature-flags/registry.ts`@4850d1d9 `ai_turn_transcript_logging`, verbatim fields.
    ['ai_turn_transcript_logging', Object.freeze({
      key: 'ai_turn_transcript_logging',
      type: 'boolean',
      default: false,
      scopes: ['tenant', 'account'],
      clientExposed: false,
      owner: 'voice',
      description:
        'Add the bot turn transcript text to the per-turn AI summary log line '
        + '(personal data in logs: test accounts only; default off)',
    }) as import('../../../../src/feature-flags/registry.js').FlagDefinition],
    ['prewarm_enabled', FIXTURE_FLAGS.prewarm_enabled],
  ]);
  return { ...actual, getFlag: (key: string) => actual.getFlag(key) ?? fixtures.get(key) };
});

import Fastify from 'fastify';
import { superAdminFeatureFlagsRoutes } from '../../../../src/api/routes/super-admin-feature-flags.routes.js';

const SA_ID = 'sa-1';
const TENANT_1 = '11111111-1111-4111-8111-111111111111';
const ACC_1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const T1 = '22222222-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const GHOST = '99999999-9999-4999-8999-999999999999';

function makeToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign(
    { sub: SA_ID, email: 'admin@test.com', type: 'super_admin', ...overrides },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}
function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${makeToken()}`, 'content-type': 'application/json' };
}

/** PORT NOTE (magick-agency): "core was called" ⇔ core's handler touched the repository. */
function coreTouched(): boolean {
  return Object.values(mocks.flagRepo).some((fn) => fn.mock.calls.length > 0)
    || mocks.resolveAllWithSource.mock.calls.length > 0;
}

describe('super-admin feature-flags routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.superAdminRepo.findById.mockResolvedValue({
      id: SA_ID, email: 'admin@test.com', name: 'Admin', status: 'active',
    });
    mocks.tenantRepo.findById.mockResolvedValue({ id: TENANT_1, name: 'Tenant One' });
    mocks.flagRepo.findGlobal.mockResolvedValue([]);
    mocks.flagRepo.findByFlag.mockResolvedValue([]);
    mocks.flagRepo.findByTenant.mockResolvedValue([]);
    mocks.flagRepo.findOne.mockResolvedValue(null);
    mocks.flagRepo.upsert.mockResolvedValue({ id: 'ff-1' });
    mocks.flagRepo.delete.mockResolvedValue(true);
    mocks.resolveAllWithSource.mockResolvedValue({ agency_dialer_enabled: { value: false, source: 'default' } });
    mocks.invalidate.mockResolvedValue(undefined);

    app = Fastify();
    await app.register(superAdminFeatureFlagsRoutes, { prefix: '/super-admin' });
    await app.ready();
  });

  describe('auth', () => {
    it('401 without a token; core not called', async () => {
      const res = await app.inject({ method: 'GET', url: '/super-admin/feature-flags' });
      expect(res.statusCode).toBe(401);
      expect(coreTouched()).toBe(false);
    });

    it('401 with an invalid JWT on a write', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
        payload: { scope_type: 'global', value: true },
      });
      expect(res.statusCode).toBe(401);
      expect(coreTouched()).toBe(false);
    });
  });

  describe('GET catalog + resolve + per-flag', () => {
    it('GET /feature-flags forwards to core', async () => {
      const res = await app.inject({ method: 'GET', url: '/super-admin/feature-flags', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.findGlobal).toHaveBeenCalledTimes(1);
      expect(res.json().flags.map((f: { key: string }) => f.key)).toEqual([
        'agency_call_analysis', 'agency_dialer_enabled', 'agency_late_binding',
      ]);
    });

    it('GET /feature-flags/resolve validates + 404s an unknown tenant', async () => {
      mocks.tenantRepo.findById.mockResolvedValue(null);
      const res = await app.inject({
        method: 'GET', url: `/super-admin/feature-flags/resolve?tenant_id=${GHOST}`, headers: authHeaders(),
      });
      expect(res.statusCode).toBe(404);
      expect(coreTouched()).toBe(false);
    });

    // NEW (magick-agency): the validator's `.uuid()` (baseline UUID columns) — master's
    // `tenant_id=ghost` would otherwise reach Postgres as 22P02, a 500.
    it('GET /feature-flags/resolve 400s a non-UUID tenant_id before any lookup', async () => {
      const res = await app.inject({
        method: 'GET', url: '/super-admin/feature-flags/resolve?tenant_id=ghost', headers: authHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(mocks.tenantRepo.findById).not.toHaveBeenCalled();
      expect(coreTouched()).toBe(false);
    });

    it('GET /feature-flags/resolve forwards tenant_id/account_id', async () => {
      const res = await app.inject({
        method: 'GET', url: `/super-admin/feature-flags/resolve?tenant_id=${TENANT_1}&account_id=${ACC_1}`, headers: authHeaders(),
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.resolveAllWithSource).toHaveBeenCalledWith({ tenantId: TENANT_1, accountId: ACC_1 });
      expect(mocks.flagRepo.findByTenant).toHaveBeenCalledWith(TENANT_1);
      expect(res.json()).toMatchObject({
        tenant_id: TENANT_1, account_id: ACC_1,
        effective: { agency_dialer_enabled: false }, source: { agency_dialer_enabled: 'default' },
      });
    });

    it('GET /feature-flags/:flagKey forwards the path (resolve is NOT captured by :flagKey)', async () => {
      const res = await app.inject({ method: 'GET', url: '/super-admin/feature-flags/agency_dialer_enabled', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.findByFlag).toHaveBeenCalledWith('agency_dialer_enabled');
      expect(res.json().flag.key).toBe('agency_dialer_enabled');
    });
  });

  describe('PUT override', () => {
    it('threads updated_by=superAdmin.id, audits locally on success', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: authHeaders(), payload: { scope_type: 'tenant', tenant_id: TENANT_1, value: true },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.upsert).toHaveBeenCalledWith({
        flag_key: 'agency_dialer_enabled',
        scope_type: 'tenant',
        tenant_id: TENANT_1,
        account_id: undefined,
        value: true,
        reason: undefined,
        expires_at: null,
        updated_by: SA_ID,
      });
      expect(mocks.invalidate).toHaveBeenCalledWith({ tenantId: TENANT_1 });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        admin_id: SA_ID, admin_email: 'admin@test.com',
        action: 'feature_flag.override.upserted', resource_type: 'feature_flag', resource_id: 'agency_dialer_enabled',
      }));
    });

    it('does NOT audit locally when core rejects (4xx)', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: authHeaders(), payload: { scope_type: 'tenant', tenant_id: TENANT_1, value: 'yes' },
      });
      expect(res.statusCode).toBe(422);
      expect(mocks.flagRepo.upsert).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
    });

    it('400 on a scope-incoherent body (global + tenant_id), core not called', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: authHeaders(), payload: { scope_type: 'global', tenant_id: T1, value: true },
      });
      expect(res.statusCode).toBe(400);
      expect(coreTouched()).toBe(false);
    });
  });

  describe('DELETE override', () => {
    it('forwards DELETE with updated_by and audits', async () => {
      const res = await app.inject({
        method: 'DELETE', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: authHeaders(), payload: { scope_type: 'tenant', tenant_id: TENANT_1 },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.delete).toHaveBeenCalledWith({
        flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT_1, account_id: undefined,
      });
      expect(mocks.invalidate).toHaveBeenCalledWith({ tenantId: TENANT_1 });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        admin_id: SA_ID,
        action: 'feature_flag.override.deleted',
      }));
    });
  });

  describe('POST bulk', () => {
    it('forwards the tenant list with updated_by and audits', async () => {
      const res = await app.inject({
        method: 'POST', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides/bulk',
        headers: authHeaders(), payload: { tenant_ids: [T1, T2], value: true },
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.upsert).toHaveBeenNthCalledWith(1, {
        flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: T1, value: true,
        reason: undefined, updated_by: SA_ID,
      });
      expect(mocks.flagRepo.upsert).toHaveBeenNthCalledWith(2, {
        flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: T2, value: true,
        reason: undefined, updated_by: SA_ID,
      });
      expect(res.json()).toEqual({ applied: [T1, T2], failed: [] });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'feature_flag.override.bulk',
      }));
    });

    it('400 on empty tenant_ids', async () => {
      const res = await app.inject({
        method: 'POST', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides/bulk',
        headers: authHeaders(), payload: { tenant_ids: [], value: true },
      });
      expect(res.statusCode).toBe(400);
      expect(coreTouched()).toBe(false);
    });
  });
  // Bot transcripts in Loki (ClickUp 14ygtkjaf5a): tenant/account only, never
  // in bulk, and never switched on without a reason in the audit trail.
  // PORT NOTE (magick-agency): the flag is an unregistered fixture; only the cases that
  // do not depend on master's deleted `flag-policies` remain (see the file note).
  describe('ai_turn_transcript_logging policy', () => {
    const FLAG = 'ai_turn_transcript_logging';
    const put = (payload: object) => app.inject({
      method: 'PUT', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: authHeaders(), payload,
    });

    it('forwards a tenant enable with its reason and updated_by, and audits it', async () => {
      const res = await put({ scope_type: 'tenant', tenant_id: TENANT_1, value: true, reason: 'debug call 42' });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.upsert).toHaveBeenCalledWith({
        flag_key: FLAG,
        scope_type: 'tenant',
        tenant_id: TENANT_1,
        account_id: undefined,
        value: true,
        reason: 'debug call 42',
        expires_at: null,
        updated_by: SA_ID,
      });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        resource_id: FLAG,
        details: expect.objectContaining({ scope_type: 'tenant', value: true, reason: 'debug call 42' }),
      }));
    });

    it('forwards an account enable', async () => {
      const res = await put({
        scope_type: 'account', tenant_id: TENANT_1, account_id: ACC_1, value: true, reason: 'repro',
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ scope_type: 'account', account_id: ACC_1, updated_by: SA_ID }),
      );
    });

    it('a global enable is left to core (its 422 Invalid Scope), not answered with the reason 400', async () => {
      const res = await put({ scope_type: 'global', value: true });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: 'Invalid Scope' });
      expect(mocks.flagRepo.upsert).not.toHaveBeenCalled();
    });

    it('turning it OFF needs no reason', async () => {
      const res = await put({ scope_type: 'tenant', tenant_id: TENANT_1, value: false });
      expect(res.statusCode).toBe(200);
      expect(mocks.flagRepo.upsert).toHaveBeenCalledTimes(1);
    });

    it('other flags still accept an enable without a reason', async () => {
      const res = await app.inject({
        method: 'PUT', url: '/super-admin/feature-flags/agency_dialer_enabled/overrides',
        headers: authHeaders(), payload: { scope_type: 'tenant', tenant_id: TENANT_1, value: true },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // The real core client records every core 4xx for `errorMaskHook`; without a
  // reviewed exemption the console would see "contact support" for a refused
  // global override instead of why it was refused.
  // PORT NOTE (magick-agency): no core client and no `errorMaskHook` in agency; these pin
  // that the route's own 4xx reach the console readable.
  describe('core 4xx through the global error mask', () => {
    let masked: ReturnType<typeof Fastify>;

    beforeEach(async () => {
      masked = Fastify({ logger: false });
      await masked.register(superAdminFeatureFlagsRoutes, { prefix: '/super-admin' });
      await masked.ready();
    });

    it('a forced global write of a tenant-only flag reads as the 422 core sent', async () => {
      const body = {
        error: 'Invalid Scope',
        message: "Flag 'ai_turn_transcript_logging' does not permit scope 'global'",
      };
      const res = await masked.inject({
        method: 'PUT', url: '/super-admin/feature-flags/ai_turn_transcript_logging/overrides',
        headers: authHeaders(), payload: { scope_type: 'global', value: false },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual(body);
    });

    it.each([
      ['PUT', 'overrides', { scope_type: 'tenant', tenant_id: TENANT_1, value: 'yes' }, 422, 'Invalid Value',
        "value must be a boolean for flag 'prewarm_enabled'"],
      ['DELETE', 'overrides', { scope_type: 'tenant', tenant_id: TENANT_1 }, 404, 'Not Found',
        'No matching override to delete'],
    ] as const)('%s %s keeps core\'s reviewed %i %s readable', async (method, path, payload, status, label, message) => {
      mocks.flagRepo.delete.mockResolvedValue(false);
      const res = await masked.inject({
        method, url: `/super-admin/feature-flags/prewarm_enabled/${path}`, headers: authHeaders(), payload,
      });
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ error: label, message });
    });

    it('an unknown flag on the detail read is a readable 404', async () => {
      const res = await masked.inject({ method: 'GET', url: '/super-admin/feature-flags/nope', headers: authHeaders() });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe("Unknown flag 'nope'");
    });
  });
});
