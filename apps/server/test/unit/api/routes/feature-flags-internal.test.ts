/*
 * The feature-flag handler bodies run in-process inside the super-admin routes
 * (`src/api/routes/super-admin-feature-flags.routes.ts`), so this suite drives them through
 * `/super-admin/feature-flags*` with a super-admin JWT.
 *  - the actor is the authenticated super admin (`sa-1`), never a body `updated_by` (the field
 *    is not in the super-admin schema; zod strips it, so payloads still carry it harmlessly);
 *  - ids are UUIDs (`t1`, `tenant-1`, `a1` → T1 …): `feature_flag_overrides` id columns are UUID;
 *  - the flag used is `agency_dialer_enabled`; the two cases that need another flag shape
 *    use unregistered fixture definitions (`test/helpers/fixture-flags.ts`) resolved through a
 *    `getFlag` fallback: `whatsapp_personal` (no account scope) for the scope-422 case,
 *    `prewarm_ring_delay_ms` (range `validate`) for the two number cases;
 *  - the flag audit row (`audit_logs`) is written for ACCOUNT scope only (its UUID
 *    `tenant_id/account_id` columns refuse `'global'`/`'bulk'`/`'default'`):
 *    'upserts a tenant override…' asserts the super-admin audit row and NO flag audit row;
 *    'captures the prior value…', 'old_value is null…' and 'deletes, invalidates, audits…' use
 *    account scope so the flag audit row is still asserted; 'applies per tenant…' asserts the
 *    single super-admin summary row;
 *  - there is no analytics module, so no `trackFeatureFlagChanged` assertions;
 *  - 'returns effective + source + defaults + overrides': the tenant-exists check runs
 *    first, so the tenant repository is mocked to find the tenant.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

const mocks = vi.hoisted(() => ({
  findGlobal: vi.fn(),
  findByFlag: vi.fn(),
  findByTenant: vi.fn(),
  findOne: vi.fn(),
  upsert: vi.fn(),
  delete: vi.fn(),
  resolveAll: vi.fn(),
  resolveAllWithSource: vi.fn(),
  invalidate: vi.fn(),
  auditLog: vi.fn(),
  // The super-admin side of the route.
  superAdminFindById: vi.fn(),
  tenantFindById: vi.fn(),
  superAdminAuditLog: vi.fn(),
}));

vi.mock('../../../../src/config/index.js', () => ({
  config: { superAdmin: { jwtSecret: 'test-secret-1234567890' } },
}));

vi.mock('@magick-agency/db/repositories/feature-flag.repository', () => ({
  featureFlagRepository: {
    findGlobal: mocks.findGlobal,
    findByFlag: mocks.findByFlag,
    findByTenant: mocks.findByTenant,
    findOne: mocks.findOne,
    upsert: mocks.upsert,
    delete: mocks.delete,
  },
}));

vi.mock('../../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    resolveAll: mocks.resolveAll,
    resolveAllWithSource: mocks.resolveAllWithSource,
    invalidate: mocks.invalidate,
  }),
}));

vi.mock('../../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: mocks.auditLog },
}));

vi.mock('@magick-agency/db/repositories/super-admin.repository', () => ({
  superAdminRepository: { findById: mocks.superAdminFindById },
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { findById: mocks.tenantFindById },
}));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.superAdminAuditLog },
}));

// Unregistered fixture flags, resolvable by key only.
vi.mock('../../../../src/feature-flags/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/feature-flags/registry.js')>();
  const { FIXTURE_FLAGS } = await import('../../../helpers/fixture-flags.js');
  const fixtures = new Map<string, import('../../../../src/feature-flags/registry.js').FlagDefinition>([
    ['whatsapp_personal', FIXTURE_FLAGS.whatsapp_personal],
    ['prewarm_ring_delay_ms', FIXTURE_FLAGS.prewarm_ring_delay_ms],
  ]);
  return { ...actual, getFlag: (key: string) => actual.getFlag(key) ?? fixtures.get(key) };
});

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { superAdminFeatureFlagsRoutes } from '../../../../src/api/routes/super-admin-feature-flags.routes.js';

const JWT_SECRET = 'test-secret-1234567890';
const SA_ID = 'sa-1';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const A1 = 'aaaaaaaa-1111-4111-8111-111111111111';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(superAdminFeatureFlagsRoutes, { prefix: '/super-admin' });
  await app.ready();
  return app;
}

const validToken = () => jwt.sign({ sub: SA_ID, email: 'admin@test.com', type: 'super_admin' }, JWT_SECRET, { expiresIn: '1h' });

function req(
  app: FastifyInstance,
  method: 'GET' | 'PUT' | 'DELETE' | 'POST',
  path: string,
  body?: unknown,
  token: string | null = validToken(),
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  return app.inject({ method, url: `/super-admin/${path}`, headers, payload: body as any });
}

describe('Super-admin — Feature Flags', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.findGlobal.mockResolvedValue([]);
    mocks.findByFlag.mockResolvedValue([]);
    mocks.findByTenant.mockResolvedValue([]);
    mocks.resolveAll.mockResolvedValue({ agency_dialer_enabled: false });
    mocks.resolveAllWithSource.mockResolvedValue({ agency_dialer_enabled: { value: false, source: 'default' } });
    mocks.findOne.mockResolvedValue(null);
    mocks.upsert.mockResolvedValue({ id: 'ff-1' });
    mocks.delete.mockResolvedValue(true);
    mocks.superAdminFindById.mockResolvedValue({ id: SA_ID, email: 'admin@test.com', name: 'Admin', status: 'active' });
    mocks.tenantFindById.mockResolvedValue({ id: T1, name: 'Tenant One' });
    mocks.superAdminAuditLog.mockResolvedValue(undefined);
    delete process.env['FF_AGENCY_DIALER'];
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
  });

  describe('super-admin auth', () => {
    it('401 without a Bearer token', async () => {
      const res = await req(app, 'GET', 'feature-flags', undefined, null);
      expect(res.statusCode).toBe(401);
    });
    it('401 with a wrong token; no repo write', async () => {
      const res = await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides',
        { scope_type: 'global', value: true }, 'nope');
      expect(res.statusCode).toBe(401);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /feature-flags (catalog)', () => {
    it('returns the registry catalog with global overrides', async () => {
      mocks.findGlobal.mockResolvedValue([{ flag_key: 'agency_dialer_enabled', value: true }]);
      const res = await req(app, 'GET', 'feature-flags');
      expect(res.statusCode).toBe(200);
      const flags = res.json().flags as Array<Record<string, unknown>>;
      const wa = flags.find((f) => f.key === 'agency_dialer_enabled')!;
      expect(wa.type).toBe('boolean');
      expect(wa.global_override).toBe(true);
      expect(flags.map((f) => f.key)).toEqual(expect.arrayContaining([
        'agency_call_analysis', 'agency_dialer_enabled', 'agency_late_binding',
      ]));
    });
  });

  describe('GET /feature-flags/:flagKey', () => {
    it('404 for an unknown flag', async () => {
      const res = await req(app, 'GET', 'feature-flags/nope');
      expect(res.statusCode).toBe(404);
    });
    it('returns the flag + its override rows', async () => {
      mocks.findByFlag.mockResolvedValue([{ id: 'o1' }]);
      const res = await req(app, 'GET', 'feature-flags/agency_dialer_enabled');
      expect(res.statusCode).toBe(200);
      expect(res.json().flag.key).toBe('agency_dialer_enabled');
      expect(res.json().overrides).toHaveLength(1);
    });
  });

  describe('PUT /feature-flags/:flagKey/overrides', () => {
    it('upserts a tenant override, invalidates cache, audits, tracks', async () => {
      const res = await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'tenant', tenant_id: T1, value: true, updated_by: 'admin-1',
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
        flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: T1, value: true,
      }));
      expect(mocks.invalidate).toHaveBeenCalledWith({ tenantId: T1 });
      // A tenant-scope change is audited in the super-admin log only (the `audit_logs`
      // row cannot hold a non-account scope), with the authenticated actor.
      expect(mocks.superAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'feature_flag.override.upserted', admin_id: SA_ID,
      }));
      expect(mocks.auditLog).not.toHaveBeenCalled();
    });

    // N1 — old→new audit trail.
    it('captures the prior value as old→new in audit + posthog', async () => {
      mocks.findOne.mockResolvedValue({ value: false }); // prior override was false
      await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'account', tenant_id: T1, account_id: A1, value: true, updated_by: 'admin-1',
      });
      expect(mocks.findOne).toHaveBeenCalledWith(expect.objectContaining({
        flag_key: 'agency_dialer_enabled', scope_type: 'account', tenant_id: T1,
      }));
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        eventData: expect.objectContaining({ old_value: false, new_value: true }),
      }));
      expect(mocks.superAdminAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ old_value: false, value: true }),
      }));
    });

    it('old_value is null when there was no prior override', async () => {
      mocks.findOne.mockResolvedValue(null);
      await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'account', tenant_id: T1, account_id: A1, value: true,
      });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        eventData: expect.objectContaining({ old_value: null, new_value: true }),
      }));
    });

    it('a failed prior-read does not block the write', async () => {
      mocks.findOne.mockRejectedValue(new Error('read down'));
      const res = await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'tenant', tenant_id: T1, value: true,
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.upsert).toHaveBeenCalled();
    });

    it('global override invalidates the global key', async () => {
      await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', { scope_type: 'global', value: false });
      expect(mocks.invalidate).toHaveBeenCalledWith({});
    });

    it('404 for an unknown flag', async () => {
      const res = await req(app, 'PUT', 'feature-flags/nope/overrides', { scope_type: 'global', value: true });
      expect(res.statusCode).toBe(404);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('422 when the scope is not permitted for the flag', async () => {
      // whatsapp_personal permits global+tenant, not account
      const res = await req(app, 'PUT', 'feature-flags/whatsapp_personal/overrides', {
        scope_type: 'account', tenant_id: T1, account_id: A1, value: true,
      });
      expect(res.statusCode).toBe(422);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('422 for a wrong-typed value (boolean flag ← string)', async () => {
      const res = await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'tenant', tenant_id: T1, value: 'yes',
      });
      expect(res.statusCode).toBe(422);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it('422 for an out-of-range number value (prewarm_ring_delay_ms ← 99999)', async () => {
      const res = await req(app, 'PUT', 'feature-flags/prewarm_ring_delay_ms/overrides', {
        scope_type: 'tenant', tenant_id: T1, value: 99999,
      });
      expect(res.statusCode).toBe(422);
    });

    it('accepts an in-range number value', async () => {
      const res = await req(app, 'PUT', 'feature-flags/prewarm_ring_delay_ms/overrides', {
        scope_type: 'tenant', tenant_id: T1, value: 5000,
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.upsert).toHaveBeenCalled();
    });

    it('400 when global scope carries tenant_id (superRefine)', async () => {
      const res = await req(app, 'PUT', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'global', tenant_id: T1, value: true,
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /feature-flags/:flagKey/overrides', () => {
    it('404 when nothing was deleted', async () => {
      mocks.delete.mockResolvedValue(false);
      const res = await req(app, 'DELETE', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'tenant', tenant_id: T1,
      });
      expect(res.statusCode).toBe(404);
    });
    it('deletes, invalidates, audits with the removed value (old_value)', async () => {
      mocks.findOne.mockResolvedValue({ value: true }); // the override being removed
      const res = await req(app, 'DELETE', 'feature-flags/agency_dialer_enabled/overrides', {
        scope_type: 'account', tenant_id: T1, account_id: A1, updated_by: 'admin-1',
      });
      expect(res.statusCode).toBe(200);
      expect(mocks.invalidate).toHaveBeenCalledWith({ tenantId: T1 });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'feature_flag.override.delete',
        eventData: expect.objectContaining({ old_value: true }),
        actor: SA_ID,
      }));
    });
  });

  describe('POST /feature-flags/:flagKey/overrides/bulk', () => {
    it('applies per tenant and returns applied/failed', async () => {
      const res = await req(app, 'POST', 'feature-flags/agency_dialer_enabled/overrides/bulk', {
        tenant_ids: [T1, T2], value: true, updated_by: 'admin-1',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toEqual([T1, T2]);
      expect(mocks.upsert).toHaveBeenCalledTimes(2);
      expect(mocks.invalidate).toHaveBeenCalledTimes(2);
      // single summary audit row
      expect(mocks.superAdminAuditLog).toHaveBeenCalledTimes(1);
      expect(mocks.auditLog).not.toHaveBeenCalled();
    });

    it('records a per-tenant failure without aborting the batch', async () => {
      mocks.upsert.mockResolvedValueOnce({ id: 'ok' }).mockRejectedValueOnce(new Error('boom'));
      const res = await req(app, 'POST', 'feature-flags/agency_dialer_enabled/overrides/bulk', {
        tenant_ids: [T1, T2], value: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toEqual([T1]);
      expect(res.json().failed).toEqual([{ tenant_id: T2, error: 'boom' }]);
    });

    it('422 for a wrong-typed value', async () => {
      const res = await req(app, 'POST', 'feature-flags/agency_dialer_enabled/overrides/bulk', {
        tenant_ids: [T1], value: 'yes',
      });
      expect(res.statusCode).toBe(422);
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  });

  describe('GET /feature-flags/resolve', () => {
    it('returns effective + source + defaults + overrides', async () => {
      mocks.resolveAllWithSource.mockResolvedValue({
        agency_dialer_enabled: { value: true, source: 'tenant' },
      });
      const res = await req(app, 'GET', `feature-flags/resolve?tenant_id=${T1}&account_id=${A1}`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.effective).toEqual({ agency_dialer_enabled: true });
      // #19a — per-flag source so the UI can attribute the inherited default.
      expect(body.source).toEqual({ agency_dialer_enabled: 'tenant' });
      expect(body).toHaveProperty('defaults');
      expect(mocks.resolveAllWithSource).toHaveBeenCalledWith({ tenantId: T1, accountId: A1 });
    });
  });
});
