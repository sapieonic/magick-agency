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
}));

import { superAdminTelephonyCredentialRoutes } from '../../../../src/api/routes/super-admin-telephony-credentials.routes.js';

const ID = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CANARY = 'canaryTokenValue0123456789';
const ROW = {
  id: ID, tenant_id: TENANT, provider: 'plivo', label: 'Main', status: 'active', account_ref: 'MA1',
  public_config: {}, secret_version: 1, secret_hint: '6789', verified_at: null, last_error: null,
  created_by: null, updated_by: null, created_at: new Date(0), updated_at: new Date(0), revoked_at: null, shredded_at: null,
};

let svc: Record<string, ReturnType<typeof vi.fn>> & { storeAvailable: boolean };
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
  } as never;
  app = Fastify();
  await app.register(superAdminTelephonyCredentialRoutes, { prefix: '/super-admin', service: () => svc as never });
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
    expect(res.json()).toMatchObject({ error: code });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', ''], ['PATCH', ''], ['PUT', '/secret'], ['POST', '/verify'], ['POST', '/disable'], ['POST', '/enable'], ['POST', '/revoke'],
  ])('%s …/:id%s answers 404 for a non-UUID id without calling the service', async (method, suffix) => {
    const res = await app.inject({ method: method as 'GET', url: `/super-admin/telephony-credentials/x'1${suffix}`, payload: method === 'GET' || method === 'POST' ? undefined : { label: 'x', fields: {}, expected_version: 1 } });
    expect(res.statusCode).toBe(404);
    for (const fn of ['get', 'rename', 'rotate', 'verify', 'disable', 'enable', 'revoke']) expect(svc[fn]).not.toHaveBeenCalled();
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
