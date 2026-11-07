// `GET /proxy/agency/carriers` (decisions B18–B22): the service's own carriers, then the
// tenant's ACTIVE credentials on active carriers that take them, with id, carrier and label
// only. Which kind a carrier is comes from its credential spec, not its name. The RBAC floor
// (`agency.campaigns.read`) is pinned by `proxy-agency-campaigns.routes.test.ts`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mocks = vi.hoisted(() => ({
  providers: vi.fn(),
  credentials: vi.fn(),
  dialReady: vi.fn((_provider: string) => true),
}));

// Whether a carrier can dial from this server (PL12) is its own module's question
// (`carrier-dial-readiness.test.ts`); here it is scripted.
vi.mock('../../../../src/telephony/carrier-dial-readiness.js', () => ({ carrierDialReady: mocks.dialReady }));

vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../../src/db/repositories/telephony-provider.repository.js', () => ({
  telephonyProviderRepository: { findAll: mocks.providers },
}));
vi.mock('@magick-agency/db/repositories/telephony-credential.repository', () => ({
  telephonyCredentialRepository: { list: mocks.credentials },
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({ tenantPhoneAssignmentRepository: {} }));

import { registerCarrierRoutes } from '../../../../src/api/routes/proxy-agency-campaigns/carriers.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

const cred = (o: Record<string, unknown>) => ({
  id: 'c', tenant_id: TENANT, provider: 'plivo', label: 'L', status: 'active', account_ref: 'MAXXXXXXXXXXXXXXXXXX',
  public_config: { auth_id: 'MAXXXXXXXXXXXXXXXXXX' }, secret_hint: '6789', ...o,
});

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.dialReady.mockImplementation(() => true);
  mocks.providers.mockResolvedValue([{ name: 'plivo', status: 'active' }, { name: 'voicelink', status: 'active' }]);
  mocks.credentials.mockResolvedValue([
    cred({ id: 'cred-1', label: 'Main' }),
    cred({ id: 'cred-2', label: 'Spare', status: 'disabled' }),
    cred({ id: 'cred-3', label: 'Broken', status: 'invalid' }),
    cred({ id: 'cred-4', label: 'Second' }),
  ]);
  app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as { tenantId: string }).tenantId = TENANT; });
  await app.register(registerCarrierRoutes, { prefix: '/proxy/agency' });
  await app.ready();
});

describe('GET /proxy/agency/carriers', () => {
  it('lists the service carrier, then the tenant\'s active credentials; never the account id, config or hint', async () => {
    const res = await app.inject({ method: 'GET', url: '/proxy/agency/carriers' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      carriers: [
        { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' },
        { telephony_provider: 'plivo', telephony_credential_id: 'cred-1', label: 'Main', status: 'active' },
        { telephony_provider: 'plivo', telephony_credential_id: 'cred-4', label: 'Second', status: 'active' },
      ],
    });
    expect(mocks.providers).toHaveBeenCalledWith('active');
    // The tenant's own credentials only (the repository filters by tenant; revoked are excluded there).
    expect(mocks.credentials).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(res.body).not.toContain('MAXXXXXXXXXXXXXXXXXX');
    expect(res.body).not.toContain('6789');
  });

  it('a carrier whose provider row is inactive is not listed, nor are credentials on it', async () => {
    mocks.providers.mockResolvedValue([{ name: 'voicelink', status: 'active' }]);
    const res = await app.inject({ method: 'GET', url: '/proxy/agency/carriers' });
    expect(res.json().carriers).toEqual([
      { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' },
    ]);
  });

  it('a tenant-account carrier that cannot dial from this server (no webhook base) offers none of its accounts (PL12)', async () => {
    mocks.dialReady.mockImplementation((provider: string) => provider !== 'plivo');
    const res = await app.inject({ method: 'GET', url: '/proxy/agency/carriers' });
    expect(res.json().carriers).toEqual([
      { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' },
    ]);
    expect(mocks.dialReady).toHaveBeenCalledWith('plivo');
  });

  it('a tenant with no credentials sees only the service carrier', async () => {
    mocks.credentials.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/proxy/agency/carriers' });
    expect(res.json().carriers).toHaveLength(1);
  });
});
