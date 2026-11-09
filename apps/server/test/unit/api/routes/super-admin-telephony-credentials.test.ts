// The super-admin credential routes (decision B20): status codes per service result,
// ids validated at the edge (a non-UUID never reaches a uuid cast), and no submitted
// value echoed in a response or written to the audit trail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));

vi.mock('../../../../src/auth/super-admin.middleware.js', () => ({
  superAdminMiddleware: async (req: any) => {
    req.superAdmin = { id: 'super-1', email: 'admin@example.com' };
  },
}));
vi.mock('../../../../src/audit/super-admin-audit.js', () => ({ recordSuperAdminAudit: mocks.audit }));
vi.mock('../../../../src/telephony/credentials/index.js', () => ({
  getTelephonyCredentialService: () => { throw new Error('tests pass a service'); },
  getTelephonyInboundService: () => { throw new Error('tests pass an inbound service'); },
}));

import { superAdminTelephonyCredentialRoutes } from '../../../../src/api/routes/super-admin-telephony-credentials.routes.js';
import { errorMaskHook } from '../../../../src/api/middleware/error-mask.middleware.js';
import { TELEPHONY_CREDENTIAL_ERROR_CODES } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

const ID = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CANARY = 'canaryTokenValue0123456789';
const ROW = {
  id: ID, tenant_id: TENANT, provider: 'plivo', label: 'Main', status: 'active', account_ref: 'MA1',
  public_config: {}, secret_version: 1, secret_hint: '6789', verified_at: null, last_error: null,
  created_by: null, updated_by: null, created_at: new Date(0), updated_at: new Date(0), revoked_at: null, shredded_at: null,
};

const SYNC = {
  listed: 4, added: ['+14155550001'], reactivated: [], taken_over: [], unchanged: ['+14155550002'], retired: ['+14155550009'],
  skipped: [{ number: '14155550003', reason: 'not_voice' }],
  conflicts: [{ phone_number: '+14155550005', reason: 'registered_elsewhere' }], active_numbers: 2,
};

const INBOUND_STATE = {
  inbound: { enabled: true, app_id: 'app-1', enabled_at: '2026-11-09T00:00:00.000Z', linked_numbers: 1, previous_token_expires_at: null },
  webhook_base_configured: true,
  numbers: [],
};
const NUMBER = '33333333-3333-4333-8333-333333333333';
const NUMBER_STATE = {
  phone_number_id: NUMBER, phone_number: '+14155550101',
  link: { linked: true, linked_at: '2026-11-09T00:00:00.000Z', previous_app_id: null, route: null },
  credential: { id: ID, label: 'Main', status: 'active', inbound_enabled: true }, link_blocker: null,
};

let svc: Record<string, ReturnType<typeof vi.fn>> & { storeAvailable: boolean };
let inb: Record<string, ReturnType<typeof vi.fn>>;
let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  svc = {
    storeAvailable: true,
    create: vi.fn().mockResolvedValue({ ok: true, value: ROW }),
    rename: vi.fn().mockResolvedValue({ ok: true, value: ROW }),
    rotate: vi.fn().mockResolvedValue({ ok: true, value: { ...ROW, secret_version: 2 } }),
    verify: vi.fn().mockResolvedValue({ ok: true, value: ROW }),
    disable: vi.fn().mockResolvedValue({ ok: true, value: { ...ROW, status: 'disabled' } }),
    enable: vi.fn().mockResolvedValue({ ok: true, value: ROW }),
    revoke: vi.fn().mockResolvedValue({ ok: true, value: { credential: { ...ROW, status: 'revoked' }, shredded: true } }),
    get: vi.fn().mockResolvedValue(ROW),
    usage: vi.fn().mockResolvedValue({ campaigns: 2, inFlightCalls: 1 }),
    list: vi.fn().mockResolvedValue([ROW]),
    syncNumbers: vi.fn().mockResolvedValue({ ok: true, value: { credential: ROW, sync: SYNC } }),
  } as never;
  inb = {
    state: vi.fn().mockResolvedValue({ ok: true, value: INBOUND_STATE }),
    enable: vi.fn().mockResolvedValue({ ok: true, value: INBOUND_STATE }),
    disable: vi.fn().mockResolvedValue({ ok: true, value: INBOUND_STATE }),
    repoint: vi.fn().mockResolvedValue({ ok: true, value: INBOUND_STATE }),
    health: vi.fn().mockResolvedValue({ ok: true, value: { inbound: INBOUND_STATE.inbound, health: { health: 'ok', mismatched: [], stored_urls_current: true, checked_at: 'x' } } }),
    numberState: vi.fn().mockResolvedValue({ ok: true, value: NUMBER_STATE }),
    link: vi.fn().mockResolvedValue({ ok: true, value: NUMBER_STATE }),
    unlink: vi.fn().mockResolvedValue({ ok: true, value: NUMBER_STATE }),
    reconcileCredential: vi.fn().mockResolvedValue(0),
  };
  app = Fastify();
  // The app-wide 5xx mask, as `buildApp` registers it, so the status mapping is tested
  // against what an admin actually receives.
  app.addHook('onSend', errorMaskHook);
  await app.register(superAdminTelephonyCredentialRoutes, { prefix: '/super-admin', service: () => svc as never, inbound: () => inb as never });
  await app.ready();
});

describe('super-admin telephony credential routes', () => {
  it('lists providers with their forms and whether the store is available', async () => {
    const res = await app.inject({ method: 'GET', url: '/super-admin/telephony-credential-providers' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.store_available).toBe(true);
    expect(body.providers).toEqual([expect.objectContaining({
      provider: 'plivo',
      fields: [expect.objectContaining({ key: 'auth_id', secret: false }), expect.objectContaining({ key: 'auth_token', secret: true })],
    })]);
  });

  it('creates (201), audits without the secret, and never echoes it', async () => {
    const res = await app.inject({
      method: 'POST', url: '/super-admin/telephony-credentials',
      payload: { tenant_id: TENANT, provider: 'plivo', label: 'Main', fields: { auth_id: 'MA1', auth_token: CANARY } },
    });
    expect(res.statusCode).toBe(201);
    expect(svc.create).toHaveBeenCalledWith({ tenantId: TENANT, provider: 'plivo', label: 'Main', fields: { auth_id: 'MA1', auth_token: CANARY }, adminId: 'super-1' });
    expect(res.body).not.toContain(CANARY);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'create_telephony_credential', resource_id: ID }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(CANARY);
  });

  it('answers a 400 with paths and messages only, never the submitted value', async () => {
    const res = await app.inject({
      method: 'POST', url: '/super-admin/telephony-credentials',
      payload: { tenant_id: 'not-a-uuid', provider: 'plivo', label: '', fields: { auth_token: CANARY }, extra: CANARY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(CANARY);
    expect(res.body).not.toContain('not-a-uuid');
    expect(svc.create).not.toHaveBeenCalled();
  });

  it('rebuilds value-bearing zod messages (an enum issue writes the value into its message)', async () => {
    const res = await app.inject({ method: 'GET', url: `/super-admin/telephony-credentials?include_revoked=${CANARY}` });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(CANARY);
    expect(res.json().details).toEqual([{ path: 'include_revoked', message: 'Expected one of: true, false' }]);
  });

  it.each([
    ['credential_store_unavailable', 503], ['carrier_rejected', 422], ['carrier_unreachable', 502],
    ['duplicate_account', 409], ['tenant_not_found', 404], ['invalid_input', 400],
  ])('maps a service %s to HTTP %i', async (code, status) => {
    svc.create!.mockResolvedValue({ ok: false, code, message: 'm' });
    const res = await app.inject({
      method: 'POST', url: '/super-admin/telephony-credentials',
      payload: { tenant_id: TENANT, provider: 'plivo', label: 'Main', fields: {} },
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, message: 'm' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  // Written out by hand: every code of the contract's union, and the status it answers.
  const EXPECTED_STATUS: Record<string, number> = {
    credential_store_unavailable: 503, secret_unavailable: 409, unknown_provider: 400, invalid_input: 400,
    tenant_not_found: 404, not_found: 404, duplicate_account: 409, duplicate_label: 409, carrier_rejected: 422,
    carrier_unreachable: 502, version_conflict: 409, invalid_transition: 409, in_use: 409,
    credential_not_active: 409, too_many_numbers: 422,
    inbound_enabled: 409, inbound_not_enabled: 409, inbound_numbers_linked: 409, inbound_previous_token_in_use: 409,
    inbound_unconfigured: 503,
    phone_number_not_found: 404, phone_number_not_linkable: 409, phone_number_not_linked: 409,
    carrier_number_missing: 409, carrier_refused: 422,
  };

  it('has an expected status for every code of the contract, and no other', () => {
    expect(Object.keys(EXPECTED_STATUS).sort()).toEqual([...TELEPHONY_CREDENTIAL_ERROR_CODES].sort());
  });

  it.each([...TELEPHONY_CREDENTIAL_ERROR_CODES])('a failed verify answering %s keeps its message and is not audited', async (code) => {
    svc.verify!.mockResolvedValue({ ok: false, code, message: 'service message' });
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/verify` });
    expect(res.statusCode).toBe(EXPECTED_STATUS[code]);
    expect(res.json()).toMatchObject({ error: code, message: 'service message' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', ''], ['PATCH', ''], ['PUT', '/secret'], ['POST', '/verify'], ['POST', '/disable'], ['POST', '/enable'], ['POST', '/revoke'],
    ['POST', '/sync-numbers'],
  ])('%s …/:id%s answers 404 for a non-UUID id without calling the service', async (method, suffix) => {
    const res = await app.inject({ method: method as 'GET', url: `/super-admin/telephony-credentials/x'1${suffix}`, payload: method === 'GET' || method === 'POST' ? undefined : { label: 'x', fields: {}, expected_version: 1 } });
    expect(res.statusCode).toBe(404);
    for (const fn of ['get', 'rename', 'rotate', 'verify', 'disable', 'enable', 'revoke', 'syncNumbers']) expect(svc[fn]).not.toHaveBeenCalled();
  });

  it('returns detail with usage', async () => {
    const res = await app.inject({ method: 'GET', url: `/super-admin/telephony-credentials/${ID}` });
    expect(res.json().usage).toEqual({ campaigns: 2, in_flight_calls: 1 });
  });

  it('rotates with the expected version and audits the new version', async () => {
    const res = await app.inject({
      method: 'PUT', url: `/super-admin/telephony-credentials/${ID}/secret`,
      payload: { fields: { auth_token: CANARY }, expected_version: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(svc.rotate).toHaveBeenCalledWith(ID, { fields: { auth_token: CANARY }, expectedVersion: 1, adminId: 'super-1' });
    expect(res.body).not.toContain(CANARY);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rotate_telephony_credential', details: expect.objectContaining({ secret_version: 2 }),
    }));
  });

  it.each(['verify', 'disable', 'enable'])('POST …/:id/%s calls the service and audits', async (action) => {
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/${action}` });
    expect(res.statusCode).toBe(200);
    expect(svc[action]).toHaveBeenCalledWith(ID, 'super-1');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: `${action}_telephony_credential` }));
  });

  it('a disable runs no inbound cascade: the credential keeps its links and routes (docs/inbound.md §8.2); nor does a refused one', async () => {
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/disable` });
    expect(res.statusCode).toBe(200);
    expect(svc.disable).toHaveBeenCalledWith(ID, 'super-1');
    expect(inb.reconcileCredential).not.toHaveBeenCalled();
    svc.disable!.mockResolvedValueOnce({ ok: false, code: 'invalid_transition', message: 'm' });
    expect((await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/disable` })).statusCode).toBe(409);
    expect(inb.reconcileCredential).not.toHaveBeenCalled();
    // Verify and enable run no cascade.
    await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/verify` });
    await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/enable` });
    expect(inb.reconcileCredential).not.toHaveBeenCalled();
  });

  it('revoke answers 409 inbound_enabled while inbound is enabled', async () => {
    svc.revoke!.mockResolvedValueOnce({ ok: false, code: 'inbound_enabled', message: 'Disable inbound before revoking it.' });
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/revoke` });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'inbound_enabled', message: 'Disable inbound before revoking it.' });
  });

  it('revoke answers 409 while a campaign pins it, and audits whether it shredded', async () => {
    svc.revoke!.mockResolvedValueOnce({ ok: false, code: 'in_use', message: '1 campaign(s)' });
    expect((await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/revoke` })).statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/revoke` });
    expect(ok.json().credential.status).toBe('revoked');
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'revoke_telephony_credential', details: expect.objectContaining({ shredded: true }),
    }));
  });

  it('passes list filters through', async () => {
    await app.inject({ method: 'GET', url: `/super-admin/telephony-credentials?tenant_id=${TENANT}&include_revoked=true` });
    expect(svc.list).toHaveBeenCalledWith({ tenantId: TENANT, includeRevoked: true });
    expect((await app.inject({ method: 'GET', url: '/super-admin/telephony-credentials?tenant_id=nope' })).statusCode).toBe(400);
  });
});

describe('POST /super-admin/telephony-credentials/:id/sync-numbers', () => {
  it('syncs as the signed-in admin, answers the credential and what changed, and audits it', async () => {
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/sync-numbers` });
    expect(res.statusCode).toBe(200);
    expect(svc.syncNumbers).toHaveBeenCalledWith(ID, 'super-1');
    // The numbers it retired leave inbound (docs/inbound.md §8.2).
    expect(inb.reconcileCredential).toHaveBeenCalledWith(ID, 'retired_by_sync', { adminId: 'super-1', adminEmail: 'admin@example.com' });
    expect(res.json()).toEqual({ credential: expect.objectContaining({ id: ID, status: 'active' }), sync: SYNC });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'sync_telephony_credential_numbers', resource_type: 'telephony_credential', resource_id: ID,
      details: expect.objectContaining({
        tenant_id: TENANT, listed: 4, active_numbers: 2, added: ['+14155550001'], retired: ['+14155550009'],
        conflicts: [{ phone_number: '+14155550005', reason: 'registered_elsewhere' }],
      }),
    }));
  });

  it.each([
    ['credential_not_active', 409], ['not_found', 404], ['carrier_rejected', 422], ['carrier_unreachable', 502],
    ['too_many_numbers', 422], ['credential_store_unavailable', 503], ['unknown_provider', 400],
  ])('a refusal %s answers %i, keeps its message and is not audited', async (code, status) => {
    svc.syncNumbers!.mockResolvedValue({ ok: false, code, message: 'service message' });
    const res = await app.inject({ method: 'POST', url: `/super-admin/telephony-credentials/${ID}/sync-numbers` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, message: 'service message' });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(inb.reconcileCredential).not.toHaveBeenCalled();
  });
});

describe('inbound routes (docs/inbound.md §8.1)', () => {
  const ACTOR = { adminId: 'super-1', adminEmail: 'admin@example.com' };
  it.each([
    ['GET', `/super-admin/telephony-credentials/${ID}/inbound`, 'state', [ID], INBOUND_STATE],
    ['POST', `/super-admin/telephony-credentials/${ID}/inbound/enable`, 'enable', [ID, ACTOR], INBOUND_STATE],
    ['POST', `/super-admin/telephony-credentials/${ID}/inbound/disable`, 'disable', [ID, ACTOR], INBOUND_STATE],
    ['POST', `/super-admin/telephony-credentials/${ID}/inbound/repoint`, 'repoint', [ID, ACTOR], INBOUND_STATE],
    ['GET', `/super-admin/phone-numbers/${NUMBER}/inbound`, 'numberState', [NUMBER], NUMBER_STATE],
    ['POST', `/super-admin/phone-numbers/${NUMBER}/inbound/link`, 'link', [NUMBER, ACTOR], NUMBER_STATE],
    ['POST', `/super-admin/phone-numbers/${NUMBER}/inbound/unlink`, 'unlink', [NUMBER, ACTOR], NUMBER_STATE],
  ] as const)('%s %s calls %s as the signed-in admin and answers its value', async (method, url, fn, args, body) => {
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(200);
    expect(inb[fn]).toHaveBeenCalledWith(...args);
    expect(res.json()).toEqual(body);
  });

  it('health answers the check', async () => {
    const res = await app.inject({ method: 'GET', url: `/super-admin/telephony-credentials/${ID}/inbound/health` });
    expect(res.statusCode).toBe(200);
    expect(res.json().health).toMatchObject({ health: 'ok', stored_urls_current: true });
    expect(inb.health).toHaveBeenCalledWith(ID);
  });

  it.each([
    ['/super-admin/telephony-credentials/nope/inbound/enable', 'not_found'],
    ['/super-admin/phone-numbers/nope/inbound/link', 'phone_number_not_found'],
  ])('POST %s answers 404 (%s) for a non-UUID id without calling the service', async (url, error) => {
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe(error);
    for (const fn of Object.keys(inb)) expect(inb[fn]).not.toHaveBeenCalled();
  });

  it.each([
    ['enable', 'inbound_unconfigured', 503], ['enable', 'inbound_enabled', 409], ['disable', 'inbound_numbers_linked', 409],
    ['repoint', 'carrier_unreachable', 502], ['link', 'phone_number_not_linkable', 409], ['link', 'carrier_number_missing', 409],
    ['unlink', 'phone_number_not_linked', 409], ['link', 'carrier_refused', 422],
  ])('%s refused with %s answers %i with the service`s message (a 5xx kept, not masked)', async (fn, code, status) => {
    inb[fn]!.mockResolvedValue({ ok: false, code, message: 'service message' });
    const url = ['link', 'unlink'].includes(fn)
      ? `/super-admin/phone-numbers/${NUMBER}/inbound/${fn}`
      : `/super-admin/telephony-credentials/${ID}/inbound/${fn}`;
    const res = await app.inject({ method: 'POST', url });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: code, message: 'service message' });
  });
});
