/*
 * Super-admin phone-number routes. `pool_eligible` is never on the wire, there are no
 * metadata/phone cache busts, and the telephony-provider routes are read-only.
 *  - DELETE …/assign/:tenantId: unassigns and answers 200 with no phone lookup, then runs the
 *    inbound cascade for the number (docs/inbound.md §8.2; the service decides whether it was
 *    linked); the two 404 cases run no cascade. Retire, delete and a PUT to a retired or deleted
 *    status run it too.
 *  - pool_eligible: POST and PUT strip it before the repository and never return it, and
 *    POST defaults to dedicated when it is omitted. GET list/detail strip it from every row
 *    (`toWirePhoneNumber`).
 *  - the telephony-provider write routes are not registered; 'the telephony-provider CRUD
 *    routes are not registered' pins that, and the list read is kept, with each carrier's
 *    capabilities (CR1, CR6, CR11).
 *  - numbers by hand follow the carrier's account modes (docs/carriers.md CR6), read from a
 *    catalogue double (`test/helpers/carrier-catalog-double.ts`) so each mode is named here,
 *    whatever the real catalogue declares: VoiceLink is pinned service-only unless a test says
 *    otherwise, `acme` is a made-up carrier on tenant accounts only whose numbers are added by
 *    hand, and Plivo is real (tenant accounts, numbers synced).
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
  reconcileNumber: vi.fn().mockResolvedValue(false),
  createPinned: vi.fn(),
}));

const carriers = vi.hoisted(() => ({} as Record<string, { accounts: { service: boolean; tenant: boolean } } | undefined>));
const SERVICE_ONLY = { accounts: { service: true, tenant: false } };
const HYBRID = { accounts: { service: true, tenant: true } };
const TENANT_ONLY = { accounts: { service: false, tenant: true } };

vi.mock('../../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));

beforeEach(() => {
  carriers['voicelink'] = SERVICE_ONLY;
  carriers['acme'] = TENANT_ONLY;
});

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
    createPinned: mocks.createPinned,
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
import { numberModeRefusal, superAdminPhoneRoutes } from '../../../../src/api/routes/super-admin-phone.routes.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(superAdminPhoneRoutes, { prefix: '/super-admin', inbound: () => ({ reconcileNumber: mocks.reconcileNumber }) as never });
  await app.ready();
  return app;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DELETE /super-admin/phone-numbers/:id/assign/:tenantId — cascade inbound cleanup', () => {
  beforeEach(() => vi.clearAllMocks());

  it('unassigns, answers 200 with no phone lookup, and runs the inbound cascade for the number', async () => {
    mocks.unassign.mockResolvedValue(true);

    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/super-admin/phone-numbers/pn-1/assign/tenant-x',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('Phone number unassigned from tenant');
    expect(mocks.unassign).toHaveBeenCalledWith('tenant-x', 'pn-1');
    expect(mocks.findPhoneById).not.toHaveBeenCalled();
    expect(mocks.reconcileNumber).toHaveBeenCalledWith('pn-1', 'unassigned', { adminId: 'super-1', adminEmail: 'admin@example.com' });
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
    expect(mocks.reconcileNumber).not.toHaveBeenCalled();
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
    expect(mocks.reconcileNumber).not.toHaveBeenCalled();
  });

  it('retire, delete and a PUT to a retired or deleted status run the cascade; any other PUT does not', async () => {
    const actor = { adminId: 'super-1', adminEmail: 'admin@example.com' };
    const app = await buildApp();
    mocks.findPhoneById.mockResolvedValue({ id: 'pn-1', phone_number: '+14155550101', status: 'active' });
    expect((await app.inject({ method: 'DELETE', url: '/super-admin/phone-numbers/pn-1' })).statusCode).toBe(200);
    expect(mocks.reconcileNumber).toHaveBeenLastCalledWith('pn-1', 'retired', actor);

    mocks.findPhoneById.mockResolvedValue({ id: 'pn-1', phone_number: '+14155550101', status: 'retired' });
    const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
    vi.mocked(phoneNumberRepository.softDelete).mockResolvedValue(true);
    expect((await app.inject({ method: 'POST', url: '/super-admin/phone-numbers/pn-1/delete' })).statusCode).toBe(200);
    expect(mocks.reconcileNumber).toHaveBeenLastCalledWith('pn-1', 'deleted', actor);

    mocks.reconcileNumber.mockClear();
    mocks.updatePhone.mockResolvedValue({ id: 'pn-1', phone_number: '+14155550101', status: 'active' });
    await app.inject({ method: 'PUT', url: '/super-admin/phone-numbers/pn-1', payload: { label: 'x' } });
    expect(mocks.reconcileNumber).not.toHaveBeenCalled();
    mocks.updatePhone.mockResolvedValue({ id: 'pn-1', phone_number: '+14155550101', status: 'retired' });
    await app.inject({ method: 'PUT', url: '/super-admin/phone-numbers/pn-1', payload: { status: 'retired' } });
    expect(mocks.reconcileNumber).toHaveBeenCalledWith('pn-1', 'retired', actor);
  });
});

describe('phone-number pool_eligible passthrough (removed in agency)', () => {
  beforeEach(() => vi.clearAllMocks());

  // `pool_eligible` is stripped, never on the wire.
  it('POST /phone-numbers does not forward pool_eligible to the repository, nor return it', async () => {
    mocks.findProviderById.mockResolvedValue({ id: 'prov-1', name: 'voicelink' });
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
      telephony_credential_id: null,
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
    mocks.findProviderById.mockResolvedValue({ id: 'prov-1', name: 'voicelink' });
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
      // VoiceLink takes both: the service's own account and tenants' (docs/carriers.md CR1);
      // its tenant numbers are added by hand (CR6).
      {
        id: 'tp-1', name: 'voicelink', takes_tenant_credentials: true,
        service_account: true, tenant_accounts: true, number_source: 'manual', supports_inbound: false,
      },
      {
        id: 'tp-2', name: 'plivo', takes_tenant_credentials: true,
        service_account: false, tenant_accounts: true, number_source: 'sync', supports_inbound: true,
      },
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
    expect(refused.json().message).toMatch(/on another tenant’s own carrier account/);

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

describe('numbers by hand follow the carrier`s account modes (CR6)', () => {
  beforeEach(() => vi.clearAllMocks());

  const PROVIDER = '22222222-2222-4222-8222-222222222222';
  const CRED = '33333333-3333-4333-8333-333333333333';
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const post = async (payload: Record<string, unknown>) => (await buildApp()).inject({
    method: 'POST', url: '/super-admin/phone-numbers',
    payload: { phone_number: '+12025550150', provider_id: PROVIDER, max_concurrent_calls: 2, ...payload },
  });

  it('the rule, by mode: no credential needs a service account, a credential a carrier whose numbers are added by hand; synced numbers never', () => {
    // VoiceLink service-only: a number on the service's own account, never pinned.
    expect(numberModeRefusal('voicelink', null)).toBeNull();
    expect(numberModeRefusal('voicelink', CRED)).toMatch(/no tenant carrier accounts/);
    // Both modes: either.
    carriers['voicelink'] = HYBRID;
    expect(numberModeRefusal('voicelink', null)).toBeNull();
    expect(numberModeRefusal('voicelink', CRED)).toBeNull();
    // Tenant accounts only, numbers by hand: only pinned.
    expect(numberModeRefusal('acme', null)).toMatch(/choose the credential/);
    expect(numberModeRefusal('acme', CRED)).toBeNull();
    // Numbers synced: never by hand, either way, with today's message.
    expect(numberModeRefusal('plivo', null)).toMatch(/sync them from its credential/);
    expect(numberModeRefusal('plivo', CRED)).toMatch(/sync them from its credential/);
    // A carrier the catalogue does not know: neither.
    expect(numberModeRefusal('nobody', null)).toMatch(/not one this service can dial on/);
    expect(numberModeRefusal('nobody', CRED)).toMatch(/no tenant carrier accounts/);
  });

  it('with a credential on a carrier that takes numbers by hand: created pinned and assigned in one write, audited with the credential and tenant', async () => {
    carriers['voicelink'] = HYBRID;
    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'voicelink', status: 'active' });
    mocks.createPinned.mockResolvedValue({
      ok: true, tenantId: TENANT,
      phoneNumber: { id: 'pn-pinned', phone_number: '+12025550150', telephony_credential_id: CRED, pool_eligible: false },
    });
    const res = await post({ telephony_credential_id: CRED, label: 'Desk' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().phone_number).toMatchObject({ id: 'pn-pinned', telephony_credential_id: CRED });
    expect(res.json().phone_number).not.toHaveProperty('pool_eligible');
    expect(mocks.createPinned).toHaveBeenCalledWith(
      { phone_number: '+12025550150', provider_id: PROVIDER, max_concurrent_calls: 2, label: 'Desk', created_by: 'super-1' },
      CRED,
    );
    expect(mocks.createPhone).not.toHaveBeenCalled();
    expect(mocks.auditLog.mock.calls[0]![0]).toMatchObject({
      action: 'create_phone_number', resource_id: 'pn-pinned',
      details: { phone_number: '+12025550150', provider_id: PROVIDER, telephony_credential_id: CRED, tenant_id: TENANT },
    });
  });

  it('a credential that is not found or on another carrier is 404, one not active 409, a number that exists 409; nothing audited', async () => {
    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'acme', status: 'active' });
    mocks.createPinned.mockResolvedValueOnce({ ok: false, reason: 'credential_not_found' });
    const missing = await post({ telephony_credential_id: CRED });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'telephony_credential_not_found' });

    mocks.createPinned.mockResolvedValueOnce({ ok: false, reason: 'credential_not_active', status: 'disabled' });
    const disabled = await post({ telephony_credential_id: CRED });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ code: 'telephony_credential_not_active' });
    expect(disabled.json().message).toContain('disabled');

    mocks.createPinned.mockResolvedValueOnce({ ok: false, reason: 'duplicate' });
    const twice = await post({ telephony_credential_id: CRED });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().message).toContain('already exists');
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('refused before any write: a credential on a service-only carrier or on one whose numbers are synced, none on a tenant-only carrier', async () => {
    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'voicelink', status: 'active' });
    const serviceOnly = await post({ telephony_credential_id: CRED });
    expect(serviceOnly.statusCode).toBe(400);
    expect(serviceOnly.json().message).toMatch(/without a credential/);

    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'plivo', status: 'active' });
    const synced = await post({ telephony_credential_id: CRED });
    expect(synced.statusCode).toBe(400);
    expect(synced.json().message).toMatch(/sync them from its credential/);

    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'acme', status: 'active' });
    const unpinned = await post({});
    expect(unpinned.statusCode).toBe(400);
    expect(unpinned.json().message).toMatch(/choose the credential/);
    const nullPin = await post({ telephony_credential_id: null });
    expect(nullPin.statusCode).toBe(400);

    expect(mocks.createPinned).not.toHaveBeenCalled();
    expect(mocks.createPhone).not.toHaveBeenCalled();
  });

  it('a malformed credential id is a 400, never a uuid cast', async () => {
    carriers['voicelink'] = HYBRID;
    mocks.findProviderById.mockResolvedValue({ id: PROVIDER, name: 'voicelink', status: 'active' });
    const res = await post({ telephony_credential_id: 'nope' });
    expect(res.statusCode).toBe(400);
    expect(mocks.createPinned).not.toHaveBeenCalled();
  });

  it('PUT never changes a number`s carrier or pin (CR7): both are stripped before the repository', async () => {
    mocks.updatePhone.mockResolvedValue({ id: 'pn-1', status: 'active', telephony_credential_id: CRED });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: '/super-admin/phone-numbers/pn-1',
      payload: { label: 'New', telephony_credential_id: null, provider_id: PROVIDER },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.updatePhone).toHaveBeenCalledWith('pn-1', { label: 'New' });
  });

  it('GET /telephony-providers: a carrier with both modes says so, its numbers added by hand', async () => {
    carriers['voicelink'] = HYBRID;
    mocks.findAllProviders.mockResolvedValue([{ id: 'tp-1', name: 'voicelink' }, { id: 'tp-3', name: 'acme' }]);
    const res = await (await buildApp()).inject({ method: 'GET', url: '/super-admin/telephony-providers' });
    expect(res.json().providers).toEqual([
      {
        id: 'tp-1', name: 'voicelink', takes_tenant_credentials: true,
        service_account: true, tenant_accounts: true, number_source: 'manual', supports_inbound: false,
      },
      {
        id: 'tp-3', name: 'acme', takes_tenant_credentials: true,
        service_account: false, tenant_accounts: true, number_source: 'manual', supports_inbound: false,
      },
    ]);
  });
});
