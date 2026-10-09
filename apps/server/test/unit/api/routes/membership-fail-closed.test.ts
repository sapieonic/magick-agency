import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * The equivalence-and-hardening test for the caller-role checks in `user.routes.ts` and
 * `invites.routes.ts`.
 *
 * A check written as `request.membership && !canManage…(…)` would let a request that
 * reached the handler WITHOUT `request.membership` skip the role comparison and go on to
 * write. In production that cannot happen, because `requirePermission` (which runs first)
 * already 403s a request with no membership — so such a check would rely on hook order for
 * its safety. These checks have no short-circuit: no membership fails closed with the
 * same 403.
 *
 * Here `requirePermission` is stubbed to PASS and nothing sets
 * `request.membership`, which is exactly the state a short-circuit would let
 * through. Every one of the five sites must refuse with its own 403 body and
 * write nothing. The last describe shows the change is invisible when a
 * membership IS present (the equivalence half).
 */

const mocks = vi.hoisted(() => ({
  membershipRepository: {
    findByUserAndTenant: vi.fn(),
    findAnyByUserAndTenant: vi.fn(),
    findByIdInTenant: vi.fn(),
    create: vi.fn(),
    reactivateWithRole: vi.fn(),
    updateRoleGuardingLastOwner: vi.fn(),
    removeGuardingLastOwner: vi.fn(),
  },
  userRepository: {
    findByProvenEmail: vi.fn(),
    resolveByProvenEmail: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
  },
  accountRepository: { findByIdInTenant: vi.fn() },
  tenantRepository: { findById: vi.fn() },
  redisCache: { del: vi.fn().mockResolvedValue(undefined) },
  issueInvite: vi.fn(),
  closeAllForUser: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
  invalidateUserCache: vi.fn(),
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// The state under test: the permission check PASSES and no membership is set.
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: mocks.userRepository,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepository,
}));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({
  agencyCampaignAgentRepository: { closeAllForUser: mocks.closeAllForUser },
}));
// Q5: `delForRevocation` forwards to the `del` mock and reports success.
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  redisCache: { ...mocks.redisCache, delForRevocation: async (...k: string[]) => { await mocks.redisCache.del(...k); return true; } },
}));
vi.mock('../../../../src/invites/invite-issuer.js', () => ({
  issueInvite: mocks.issueInvite,
  roleGetsTokenInvite: (role: string) => role === 'agent',
}));
vi.mock('../../../../src/audit/platform/audit-logger.js', () => ({
  platformAuditLogger: { log: mocks.auditLog },
}));

import Fastify from 'fastify';
import { userRoutes } from '../../../../src/api/routes/user.routes.js';
import { inviteRoutes } from '../../../../src/api/routes/invites.routes.js';

const TENANT = '44444444-4444-4444-8444-444444444444';
const TARGET_USER = '55555555-5555-4555-8555-555555555555';
const TARGET_MEMBERSHIP = '66666666-6666-4666-8666-666666666666';

function targetRow(role: string) {
  return {
    id: TARGET_MEMBERSHIP,
    user_id: TARGET_USER,
    tenant_id: TENANT,
    account_id: null,
    role,
    status: 'active',
    invited_by: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

async function buildApp(membership?: { role: string; account_id: string | null }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: any) => {
    request.user = { id: 'caller-1' };
    request.tenantId = TENANT;
    if (membership) request.membership = membership;
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(inviteRoutes, { prefix: '/invites' });
  await app.ready();
  return app;
}

function expectNothingWritten() {
  expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
  expect(mocks.membershipRepository.reactivateWithRole).not.toHaveBeenCalled();
  expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  expect(mocks.userRepository.create).not.toHaveBeenCalled();
  expect(mocks.issueInvite).not.toHaveBeenCalled();
  expect(mocks.closeAllForUser).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.redisCache.del.mockResolvedValue(undefined);
  mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetRow('viewer')]);
  mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
  mocks.membershipRepository.findByIdInTenant.mockResolvedValue(targetRow('agent'));
  mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'none' });
  mocks.closeAllForUser.mockResolvedValue([]);
});

describe('missing request.membership fails closed (no `request.membership && …` short-circuit)', () => {
  it('POST /users/invite: 403 "Cannot invite with a role equal to or above your own", nothing written', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/users/invite',
      payload: { email: 'x@corp.test', role: 'agent' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot invite with a role equal to or above your own' });
    expectNothingWritten();
  });

  it('PUT /users/:id/role: 403 "Cannot manage a user …" (the current-role check), nothing written', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT', url: `/users/${TARGET_USER}/role`, payload: { role: 'operator' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot manage a user with a role equal to or above your own' });
    expectNothingWritten();
  });

  it('DELETE /users/:id/membership: 403 "Cannot manage a user …", nothing written, staffing untouched', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot manage a user with a role equal to or above your own' });
    expectNothingWritten();
  });

  it('POST /invites/resend: 403 "Cannot resend …", no invite issued', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/invites/resend', payload: { membership_id: TARGET_MEMBERSHIP },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot resend an invitation for a role equal to or above your own' });
    expectNothingWritten();
  });
});

describe('PUT /users/:id/role — the NEW-role check also fails closed on its own', () => {
  it('a caller outranking the CURRENT role but not the NEW one is refused by the second check', async () => {
    // tenant_admin may manage a viewer, but may not assign tenant_admin.
    const app = await buildApp({ role: 'tenant_admin', account_id: null });
    const res = await app.inject({
      method: 'PUT', url: `/users/${TARGET_USER}/role`, payload: { role: 'tenant_admin' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/equal to or above your own/);
    expectNothingWritten();
  });
});

describe('with a membership present the fail-closed check is invisible (same behaviour as before)', () => {
  it('POST /invites/resend by a tenant_owner for an agent proceeds to issue', async () => {
    mocks.issueInvite.mockResolvedValue({
      invite: { id: 'inv-1' }, inviteEmail: { sent: false, reason: 'not_configured' }, signInUrl: 'https://x/agency/join/t',
    });
    mocks.userRepository.findById.mockResolvedValue({ id: TARGET_USER, email: 'agent@corp.test', firebase_uid: 'pending_x' });
    const app = await buildApp({ role: 'tenant_owner', account_id: null });
    const res = await app.inject({
      method: 'POST', url: '/invites/resend', payload: { membership_id: TARGET_MEMBERSHIP },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it('DELETE /users/:id/membership by a tenant_owner for a viewer reaches the guarded remove', async () => {
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: undefined });
    const app = await buildApp({ role: 'tenant_owner', account_id: null });
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });
    expect(res.statusCode).not.toBe(403);
    expect(mocks.membershipRepository.removeGuardingLastOwner).toHaveBeenCalled();
  });
});
