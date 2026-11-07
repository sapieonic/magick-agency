/*
 * Super-admin phone-number routes. There is no unassign inbound-config cascade,
 * `pool_eligible` is never on the wire, there are no metadata/phone cache busts, and the
 * telephony-provider routes are read-only.
 *  - DELETE …/assign/:tenantId: unassigns and answers 200 with no phone lookup and no
 *    inbound cascade; the two 404 cases assert nothing about a cascade.
 *  - pool_eligible: POST and PUT strip it before the repository and never return it, and
 *    POST defaults to dedicated when it is omitted. GET list/detail strip it from every row
 *    (`toWirePhoneNumber`).
 *  - the telephony-provider write routes are not registered; 'the telephony-provider CRUD
 *    routes are not registered' pins that, and the list read is kept.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  findAllProviders: vi.fn().mockResolvedValue([]),
  findPhoneById: vi.fn(),
  findAllPhones: vi.fn().mockResolvedValue([]),
  createPhone: vi.fn(),
  updatePhone: vi.fn(),
  findProviderById: vi.fn(),
  unassign: vi.fn(),
  findByPhoneNumberId: vi.fn().mockResolvedValue([]),
  assign: vi.fn(),
  findCredentialById: vi.fn(),
  auditLog: vi.fn().mockResolvedValue(undefined),
  logWarn: vi.fn(),
}));

vi.mock('../../../../src/auth/super-admin.middleware.js', () => ({
  superAdminMiddleware: async (req: any) => {
    req.superAdmin = { id: 'super-1', email: 'admin@example.com' };
  },
}));

vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.auditLog },
}));

vi.mock('../../../../src/db/repositories/telephony-provider.repository.js', () => ({
  telephonyProviderRepository: {
    findByName: vi.fn(),
    findAll: mocks.findAllProviders,
    findById: mocks.findProviderById,
  },
}));

vi.mock('@magick-agency/db/repositories/phone-number.repository', () => ({
  phoneNumberRepository: {
    findById: mocks.findPhoneById,
    findAll: mocks.findAllPhones,
    findByPhoneNumber: vi.fn().mockResolvedValue(null),
    create: mocks.createPhone,
    update: mocks.updatePhone,
    // Returns Promise<boolean>; the route 500s on a falsy result, so a bare
    // vi.fn() (undefined) would fail any future success-path test.
    retire: vi.fn().mockResolvedValue(true),
    reactivate: vi.fn(),
    softDelete: vi.fn(),
    countAssignments: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', async (importOriginal) => ({
  PhoneNumberOtherTenantError: (await importOriginal<typeof import('@magick-agency/db/repositories/tenant-phone-assignment.repository')>()).PhoneNumberOtherTenantError,
  tenantPhoneAssignmentRepository: {
    findByPhoneNumberId: mocks.findByPhoneNumberId,
    assign: mocks.assign,
    unassign: mocks.unassign,
    findByTenantId: vi.fn().mockResolvedValue([]),
    findTagsForAssignment: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@magick-agency/db/repositories/telephony-credential.repository', () => ({
  telephonyCredentialRepository: { findById: mocks.findCredentialById },
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }),
}));

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: mocks.logWarn, error: vi.fn(), debug: vi.fn() }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import Fastify from 'fastify';
import { superAdminPhoneRoutes } from '../../../../src/api/routes/super-admin-phone.routes.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(superAdminPhoneRoutes, { prefix: '/super-admin' });
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DELETE /super-admin/phone-numbers/:id/assign/:tenantId — cascade inbound cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unassigns and answers 200 with no phone lookup and no inbound cascade', async () => {
    mocks.unassign.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/super-admin/phone-numbers/pn-1/assign/tenant-x',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('Phone number unassigned from tenant');
    expect(mocks.unassign).toHaveBeenCalledWith('tenant-x', 'pn-1');
    // The lookup existed only to feed the deleted cascade.
    expect(mocks.findPhoneById).not.toHaveBeenCalled();
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'unassign_phone_number',
      resource_type: 'tenant_phone_assignment',
      resource_id: 'pn-1',
      details: { phone_number_id: 'pn-1', tenant_id: 'tenant-x' },
    }));
  });

  it('returns 404 when assignment not found — no cascade fired (phoneNumber unknown)', async () => {
    mocks.findPhoneById.mockResolvedValue(null);
    mocks.unassign.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/super-admin/phone-numbers/pn-missing/assign/tenant-x',
    });

    expect(res.statusCode).toBe(404);
    // There is no cascade to fire (module note).
  });

  it('skips cascade when phone lookup returns null but still returns 404 from unassign', async () => {
    // phone doesn't exist (e.g. stale id) but unassign also returns false
    mocks.findPhoneById.mockResolvedValue(null);
    mocks.unassign.mockResolvedValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/super-admin/phone-numbers/pn-gone/assign/tenant-y',
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('phone-number pool_eligible passthrough (removed in agency)', () => {
  beforeEach(() => vi.clearAllMocks());

  // `pool_eligible` is stripped, never on the wire.
  it('POST /phone-numbers does not forward pool_eligible to the repository, nor return it', async () => {
    mocks.findProviderById.mockResolvedValue({ id: 'prov-1', name: 'vobiz' });
    mocks.createPhone.mockResolvedValue({ id: 'pn-new', phone_number: '+12025550100', pool_eligible: false });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/super-admin/phone-numbers',
      payload: {
        phone_number: '+12025550100',
        provider_id: '11111111-1111-1111-1111-111111111111',
        max_concurrent_calls: 1,
        pool_eligible: true,
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().phone_number).not.toHaveProperty('pool_eligible');
    expect(mocks.createPhone.mock.calls[0]![0]).not.toHaveProperty('pool_eligible');
    expect(mocks.auditLog.mock.calls[0]![0].details).toEqual({
      phone_number: '+12025550100',
      provider_id: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('POST /phone-numbers refuses an inactive provider', async () => {
    mocks.findProviderById.mockResolvedValue({ id: 'prov-2', name: 'voicelink', status: 'inactive' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/super-admin/phone-numbers',
      payload: { phone_number: '+12025550102', provider_id: '22222222-2222-2222-2222-222222222222', max_concurrent_calls: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toBe('Telephony provider is not active');
    expect(mocks.createPhone).not.toHaveBeenCalled();
  });

  it('POST /phone-numbers defaults to dedicated (pool_eligible omitted) when not provided', async () => {
    mocks.findProviderById.mockResolvedValue({ id: 'prov-1', name: 'vobiz' });
    mocks.createPhone.mockResolvedValue({ id: 'pn-new', phone_number: '+12025550101', pool_eligible: false });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/super-admin/phone-numbers',
      payload: {
        phone_number: '+12025550101',
        provider_id: '11111111-1111-1111-1111-111111111111',
        max_concurrent_calls: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    const arg = mocks.createPhone.mock.calls[0]![0];
    expect(arg.pool_eligible).toBeUndefined();
  });

  it('PUT /phone-numbers/:id drops a pool_eligible toggle before the repository, and does not return it', async () => {
    mocks.updatePhone.mockResolvedValue({ id: 'pn-1', phone_number: '+12025550100', pool_eligible: true });

    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/super-admin/phone-numbers/pn-1',
      payload: { pool_eligible: true },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.updatePhone).toHaveBeenCalledWith('pn-1', {});
    expect(res.json().phone_number).not.toHaveProperty('pool_eligible');
  });

  // `toWirePhoneNumber` on the read paths.
  it('GET /phone-numbers and GET /phone-numbers/:id strip pool_eligible from every row', async () => {
    const row = { id: 'pn-1', phone_number: '+12025550100', status: 'active', pool_eligible: true };
    mocks.findAllPhones.mockResolvedValue([row]);
    mocks.findPhoneById.mockResolvedValue(row);

    const app = await buildApp();
    const list = await app.inject({ method: 'GET', url: '/super-admin/phone-numbers' });
    const detail = await app.inject({ method: 'GET', url: '/super-admin/phone-numbers/pn-1' });

    expect(list.statusCode).toBe(200);
    expect(list.json().phone_numbers).toEqual([
      { id: 'pn-1', phone_number: '+12025550100', status: 'active', assignment_count: 0 },
    ]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().phone_number).toEqual({ id: 'pn-1', phone_number: '+12025550100', status: 'active' });
  });
});

describe('telephony-provider CRUD (writes removed; the list is kept)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('the telephony-provider write routes are not registered', async () => {
    const app = await buildApp();
    const put = await app.inject({
      method: 'PUT', url: '/super-admin/telephony-providers/tp-1', payload: { live_transfer_enabled: true },
    });
    const post = await app.inject({
      method: 'POST', url: '/super-admin/telephony-providers', payload: { name: 'plivo', display_name: 'Plivo' },
    });

    expect([put.statusCode, post.statusCode]).toEqual([404, 404]);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  // The GET list is kept so the console can pick the seeded provider's id for
  // POST /phone-numbers.
  it('GET /telephony-providers lists the providers and forwards ?status', async () => {
    const app = await buildApp();
    mocks.findAllProviders.mockResolvedValue([{ id: 'tp-1', name: 'voicelink' }, { id: 'tp-2', name: 'plivo' }]);
    const all = await app.inject({ method: 'GET', url: '/super-admin/telephony-providers' });
    const active = await app.inject({ method: 'GET', url: '/super-admin/telephony-providers?status=active' });

    expect(all.statusCode).toBe(200);
    // Which carriers take tenant credentials (their numbers are synced, never added by
    // hand) comes from the credential specs, not the name.
    expect(all.json()).toEqual({ providers: [
      { id: 'tp-1', name: 'voicelink', takes_tenant_credentials: false },
      { id: 'tp-2', name: 'plivo', takes_tenant_credentials: true },
    ] });
    expect(mocks.findAllProviders).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.findAllProviders).toHaveBeenNthCalledWith(2, 'active');
    expect(active.statusCode).toBe(200);
  });
});

describe('numbers on a tenant\'s own carrier account (B18): synced, never added or reassigned by hand', () => {
  beforeEach(() => vi.clearAllMocks());

  const TENANT_A = '11111111-1111-4111-8111-111111111111';
  const TENANT_B = '44444444-4444-4444-8444-444444444444';

  it('POST /phone-numbers refuses a carrier that takes tenant credentials (its numbers come from a sync)', async () => {
    mocks.findProviderById.mockResolvedValue({ id: 'prov-2', name: 'plivo', status: 'active' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/super-admin/phone-numbers',
      payload: { phone_number: '+12025550102', provider_id: '22222222-2222-2222-2222-222222222222', max_concurrent_calls: 1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/sync them from its credential/);
    expect(mocks.createPhone).not.toHaveBeenCalled();
  });

  it('a synced number is assigned only to its credential\'s tenant (the repository refuses; the route says why)', async () => {
    mocks.findPhoneById.mockResolvedValue({ id: 'pn-1', status: 'active', telephony_credential_id: 'cred-a' });
    const { PhoneNumberOtherTenantError } = await import('@magick-agency/db/repositories/tenant-phone-assignment.repository');
    mocks.assign.mockImplementation(async (tenantId: string, id: string) => {
      if (tenantId !== TENANT_A) throw new PhoneNumberOtherTenantError(id, tenantId);
      return { id: 'asg-1' };
    });
    const app = await buildApp();

    const refused = await app.inject({ method: 'POST', url: '/super-admin/phone-numbers/pn-1/assign', payload: { tenant_id: TENANT_B } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().message).toMatch(/synced from another tenant’s carrier account/);

    const allowed = await app.inject({ method: 'POST', url: '/super-admin/phone-numbers/pn-1/assign', payload: { tenant_id: TENANT_A } });
    expect(allowed.statusCode).toBe(201);
    expect(mocks.assign).toHaveBeenCalledWith(TENANT_A, 'pn-1', false, 'super-1');
  });

  it('a number on the service\'s own account is assignable to any tenant, with no credential read', async () => {
    mocks.findPhoneById.mockResolvedValue({ id: 'pn-2', status: 'active', telephony_credential_id: null });
    mocks.assign.mockResolvedValue({ id: 'asg-2' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/super-admin/phone-numbers/pn-2/assign', payload: { tenant_id: TENANT_B } });
    expect(res.statusCode).toBe(201);
    expect(mocks.findCredentialById).not.toHaveBeenCalled();
  });
});
