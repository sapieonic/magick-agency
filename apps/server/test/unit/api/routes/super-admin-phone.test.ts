/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/routes/super-admin-phone.test.ts@a1f0756a
 * (16 cases → 8: 1 verbatim, 4 modified, 11 deleted, 3 NEW). The route's PORT NOTE
 * deletes the unassign inbound-config cascade, `pool_eligible` on the wire, the
 * metadata/phone cache busts and the telephony-provider CRUD routes; this file
 * follows.
 *  - DELETE …/assign/:tenantId: 'cascades inbound config removal before
 *    unassigning' and 'continues with unassign even when cascade throws —
 *    best-effort' are DELETED (no cascade, no phone lookup feeding it); NEW
 *    'unassigns and answers 200 with no phone lookup and no inbound cascade' keeps
 *    the success path. The two 404 cases are MODIFIED: their
 *    `removeAllForTenantPhone` not-called assertion is dropped with the
 *    `inbound-config.service` mock (the route no longer imports it).
 *  - pool_eligible: 'POST /phone-numbers forwards pool_eligible to the repository'
 *    and 'PUT /phone-numbers/:id forwards a pool_eligible toggle to the repository'
 *    are MODIFIED into their inverse (renamed: the field is stripped, not
 *    forwarded, and never on the wire); the describe is renamed to match.
 *    'POST /phone-numbers defaults to dedicated (pool_eligible omitted) when not
 *    provided' is verbatim. NEW 'GET /phone-numbers and GET /phone-numbers/:id
 *    strip pool_eligible from every row' covers the port's `toWirePhoneNumber`.
 *  - 'PUT /super-admin/telephony-providers/:id — live_transfer_enabled': all 9
 *    cases DELETED with the route ('forwards the toggle to the repository, returns
 *    the row, and audit-logs new AND previous value', 'records the previous value
 *    of every CHANGED field, and omits unchanged ones', 'busts every tenant metadata
 *    cache when live_transfer_enabled or status is written', 'does not bust tenant
 *    metadata caches for a display_name-only edit', 'deactivating a carrier with
 *    live transfer ON warns and audits that transfers stop', 'switching the flag ON
 *    for an inactive carrier warns that it has no effect', 'deactivating a carrier
 *    whose live transfer is OFF does not warn', 'rejects a non-boolean
 *    live_transfer_enabled with 400 and writes nothing', '404s when the provider
 *    does not exist, and busts nothing'); NEW 'the telephony-provider CRUD routes
 *    are not registered' pins the deletion.
 * Mocks: `metadata-cache.js` and `inbound-config.service.js` removed (not imported
 * by the route); the telephony-provider mock keeps only the reads the port has;
 * the rest re-pointed per the path rule.
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

vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: {
    findByPhoneNumberId: mocks.findByPhoneNumberId,
    assign: vi.fn(),
    unassign: mocks.unassign,
    findByTenantId: vi.fn().mockResolvedValue([]),
    findTagsForAssignment: vi.fn().mockResolvedValue([]),
  },
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

  // PORT NOTE (magick-agency): NEW, replacing the two deleted cascade cases.
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
    // PORT NOTE (magick-agency): master's `removeAllForTenantPhone` not-called
    // assertion is dropped — there is no cascade to fire (module note).
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
    // PORT NOTE (magick-agency): `removeAllForTenantPhone` assertion dropped, as above.
  });
});

describe('phone-number pool_eligible passthrough (removed in agency)', () => {
  beforeEach(() => vi.clearAllMocks());

  // PORT NOTE (magick-agency): MODIFIED from 'POST /phone-numbers forwards
  // pool_eligible to the repository' — the inverse: stripped, never on the wire.
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

  // PORT NOTE (magick-agency): MODIFIED from 'PUT /phone-numbers/:id forwards a
  // pool_eligible toggle to the repository' — the inverse.
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

  // PORT NOTE (magick-agency): NEW — the port's `toWirePhoneNumber` on the read paths.
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

// PORT NOTE (magick-agency): NEW, replacing master's 9-case
// 'PUT /super-admin/telephony-providers/:id — live_transfer_enabled' describe (the
// routes are deleted; see the module note).
describe('telephony-provider CRUD (writes deleted in agency; the list is kept)', () => {
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

  // NEW (lead, session 3): master's GET list is kept (verbatim) so the console can
  // pick the seeded provider's id for POST /phone-numbers. Master had no case for it.
  it('GET /telephony-providers lists the providers and forwards ?status', async () => {
    const app = await buildApp();
    mocks.findAllProviders.mockResolvedValue([{ id: 'tp-1', name: 'voicelink' }]);
    const all = await app.inject({ method: 'GET', url: '/super-admin/telephony-providers' });
    const active = await app.inject({ method: 'GET', url: '/super-admin/telephony-providers?status=active' });

    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ providers: [{ id: 'tp-1', name: 'voicelink' }] });
    expect(mocks.findAllProviders).toHaveBeenNthCalledWith(1, undefined);
    expect(mocks.findAllProviders).toHaveBeenNthCalledWith(2, 'active');
    expect(active.statusCode).toBe(200);
  });
});
