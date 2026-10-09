import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * NEW (magick-agency, Phase 8): `platformProfileRouteAuth`, the `ProfileRouteAuth` lane D's
 * call-analysis profile routes run behind at `/proxy/call-analysis-profiles` — master's
 * `proxy-call-analysis-profiles.routes.ts` chain collapsed (session → tenant-context →
 * `agency.analytics` capability → `agency.analysis_profiles.read|write` → core's account
 * requirement). The real `requirePermission` runs over the contract's matrix; the session and
 * tenant-context middlewares and the settings repository are stubbed.
 */

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  tenant: vi.fn(),
  findSettings: vi.fn(),
}));

vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: mocks.session }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: mocks.tenant }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findSettings },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { platformProfileRouteAuth } from '../../../src/api/profile-route-auth.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';

function asMember(role: MembershipRole, accountId: string | null = ACCOUNT) {
  mocks.session.mockImplementation(async (request: Record<string, unknown>) => {
    request['user'] = { id: 'u1' };
  });
  mocks.tenant.mockImplementation(async (request: Record<string, unknown>) => {
    request['tenantId'] = TENANT;
    request['accountId'] = accountId ?? undefined;
    request['membership'] = { role, account_id: accountId, status: 'active' };
  });
}

async function build(): Promise<{ app: FastifyInstance; seen: Array<{ tenant: string; account: string }> }> {
  const auth = platformProfileRouteAuth();
  const app = Fastify({ logger: false });
  const seen: Array<{ tenant: string; account: string }> = [];
  app.addHook('preHandler', auth.preHandler);
  const handler = async (request: Parameters<typeof auth.getTenantId>[0]) => {
    seen.push({ tenant: auth.getTenantId(request), account: auth.getAccountId(request) });
    return { ok: true };
  };
  app.get('/p', handler);
  app.post('/p', handler);
  app.put('/p/:id', handler);
  app.delete('/p/:id', handler);
  await app.ready();
  return { app, seen };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSettings.mockResolvedValue({ analyze_calls: true, allow_recording: false });
});

describe('platformProfileRouteAuth', () => {
  it('runs the session middleware first, and stops on its refusal', async () => {
    mocks.session.mockImplementation(async (_request: unknown, reply: { code(n: number): { send(b: unknown): void } }) => {
      reply.code(401).send({ error: 'Unauthorized' });
    });
    const { app, seen } = await build();
    const res = await app.inject({ method: 'GET', url: '/p' });
    expect(res.statusCode).toBe(401);
    expect(mocks.tenant).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it('stops on a tenant-context refusal', async () => {
    mocks.session.mockResolvedValue(undefined);
    mocks.tenant.mockImplementation(async (_request: unknown, reply: { code(n: number): { send(b: unknown): void } }) => {
      reply.code(403).send({ error: 'Forbidden' });
    });
    const { app, seen } = await build();
    expect((await app.inject({ method: 'GET', url: '/p' })).statusCode).toBe(403);
    expect(mocks.findSettings).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it("answers core's 400 when there is no account (core's authMiddleware required one)", async () => {
    asMember('account_admin', null);
    const { app, seen } = await build();
    const res = await app.inject({ method: 'GET', url: '/p' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Bad Request', message: 'Missing required header: x-mgkvc-account' });
    expect(mocks.findSettings).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  it.each([
    ['the column is false', { analyze_calls: false }],
    ['the column is NULL (the documented default is off)', { analyze_calls: null }],
    ['there is no settings row', null],
  ])('refuses with master capability_disabled body when %s', async (_label, row) => {
    asMember('tenant_owner');
    mocks.findSettings.mockResolvedValue(row);
    const { app, seen } = await build();
    const res = await app.inject({ method: 'GET', url: '/p' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
    expect(mocks.findSettings).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(seen).toEqual([]);
  });

  it('fails CLOSED when the settings read throws', async () => {
    asMember('tenant_owner');
    mocks.findSettings.mockRejectedValue(new Error('pool down'));
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/p' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
  });

  it('checks the capability BEFORE the permission, in master order', async () => {
    asMember('agent');
    mocks.findSettings.mockResolvedValue({ analyze_calls: false });
    const { app } = await build();
    const res = await app.inject({ method: 'GET', url: '/p' });
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.analytics' });
  });

  it('reads at agency.analysis_profiles.read (viewer) and refuses an agent', async () => {
    asMember('agent');
    const { app } = await build();
    const refused = await app.inject({ method: 'GET', url: '/p' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().message).toBe('Insufficient permissions. Required: agency.analysis_profiles.read');
    asMember('viewer');
    expect((await app.inject({ method: 'GET', url: '/p' })).statusCode).toBe(200);
  });

  it.each(['POST', 'PUT', 'DELETE'] as const)(
    '%s needs agency.analysis_profiles.write (account_admin): an operator is refused, an account_admin is not',
    async (method) => {
      const url = method === 'POST' ? '/p' : `/p/${ACCOUNT}`;
      asMember('operator');
      const { app } = await build();
      const refused = await app.inject({ method, url });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toBe('Insufficient permissions. Required: agency.analysis_profiles.write');
      asMember('account_admin');
      expect((await app.inject({ method, url })).statusCode).toBe(200);
    },
  );

  it("hands the handler the session's tenant and account", async () => {
    asMember('viewer');
    const { app, seen } = await build();
    await app.inject({ method: 'GET', url: '/p' });
    expect(seen).toEqual([{ tenant: TENANT, account: ACCOUNT }]);
  });
});
