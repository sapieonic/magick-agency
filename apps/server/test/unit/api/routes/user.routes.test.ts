import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests for `POST /users/invite`'s `account_id` boundary check —
 * the root-cause fix for the account.repository.ts `findByIds` cross-tenant
 * leak (agency happy-path security follow-up, item 1).
 *
 * Before this fix, `account_id` was caller-supplied and written straight onto
 * the new membership row alongside `tenant_id = request.tenantId` with no
 * check that the two agreed. `memberships.account_id` is `REFERENCES
 * accounts(id)` (migration 001) with no composite FK back to the tenant, so
 * nothing in the schema caught a mismatch: a tenant_admin of tenant A could
 * invite a user against an `account_id` belonging to tenant B, producing a
 * membership row that crosses a tenant boundary. `GET /accounts/mine` is what
 * exposed this downstream (see account.routes.test.ts), but this is the
 * actual place it should be refused.
 *
 * **The double exposes `findByIdInTenant` and nothing else, on purpose.** The
 * first version of this file mocked `findById` — the deliberately-unscoped
 * method the repository's own docstring tells tenant-facing callers not to use —
 * so it asserted the right status codes while legitimizing the wrong call, and
 * would have gone on passing forever. With only the scoped method present, a
 * route that reverts to `findById` calls `undefined` and every case in here
 * throws, so the shape of the double is the guard.
 */

const mocks = vi.hoisted(() => ({
  membershipRepository: {
    findByUserAndTenant: vi.fn(),
    findAnyByUserAndTenant: vi.fn(),
    create: vi.fn(),
    reactivateWithRole: vi.fn(),
    // Deliberately NOT `updateRole` / `remove` / `countByTenantAndRole`. Those
    // are the read-then-write pair that let two concurrent owner demotions each
    // see the other's owner and commit, leaving a tenant with none — and no
    // customer route can put an owner back, since both role schemas exclude
    // `tenant_owner`. Same principle as the `findById` note above: with only
    // the guarded methods present, a route that reverts to the racy pair calls
    // `undefined` and every case below fails loudly.
    updateRoleGuardingLastOwner: vi.fn(),
    removeGuardingLastOwner: vi.fn(),
  },
  userRepository: {
    findByProvenEmail: vi.fn(),
    resolveByProvenEmail: vi.fn(),
    create: vi.fn(),
  },
  accountRepository: {
    findByIdInTenant: vi.fn(),
  },
  redisCache: {
    del: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// Real behaviour, not a blanket stub: `user.invite` is not the thing under
// test here, but leaving it real costs nothing and keeps the fixture honest.
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
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  // Q5 (Manas, 2026-10-09): revocation deletes go through `delForRevocation` (retried, reports
  // failure); this double forwards to the `del` mock and reports success, so the assertions on
  // `del` still observe the key.
  redisCache: { ...mocks.redisCache, delForRevocation: async (...k: string[]) => { await mocks.redisCache.del(...k); return true; } },
}));

import Fastify from 'fastify';
import { userRoutes } from '../../../../src/api/routes/user.routes.js';

// The validator requires `account_id: z.string().uuid()`, so every fixture
// below has to be UUID-shaped or the request 400s at schema validation —
// before ever reaching the check under test — and reports as a confusing
// false negative (a Zod `details` body, not the `message` these tests assert).
const TENANT = 'tenant-1';
// No OTHER_TENANT id is needed any more: the route never sees a foreign row, so
// there is no `tenant_id` on a fixture for the route to compare against. The
// foreign case is expressed the way the database expresses it — the scoped
// lookup finds nothing.
const ACCOUNT_OWN_TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_NONEXISTENT = '33333333-3333-4333-8333-333333333333';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_OWN_TENANT,
    tenant_id: TENANT,
    name: 'Acct One',
    slug: 'acct-one',
    settings: {},
    status: 'active',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

async function buildApp(
  membershipRole = 'tenant_admin',
  membershipAccountId?: string | null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: any) => {
    request.user = { id: 'inviter-1' };
    request.tenantId = TENANT;
    request.membership = membershipAccountId !== undefined
      ? { role: membershipRole, account_id: membershipAccountId }
      : { role: membershipRole };
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
  return app;
}

describe('user.routes — POST /invite account_id tenant boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue({ id: 'm-new', user_id: 'u-1', tenant_id: TENANT, account_id: null, role: 'viewer' });
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'none' });
    mocks.userRepository.create.mockResolvedValue({ id: 'u-1', email: 'new@test.com' });
  });

  it('refuses an account_id belonging to another tenant', async () => {
    /**
     * The exact hole: caller supplies an account_id from a DIFFERENT tenant.
     *
     * The scoped lookup is what makes this a `null` rather than a foreign row
     * plus a comparison, so the fixture returns `null` even though the id does
     * exist somewhere — that IS the behaviour of `WHERE id = $1 AND tenant_id =
     * $2`. The assertion that matters is the argument list below: the caller's
     * own tenant is in the query, so tenant B's row is never materialized here.
     */
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_OTHER_TENANT },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/does not belong to this tenant/);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
    // Both ids, in order. `findByIdInTenant(id)` with the tenant dropped would
    // be a syntactically valid call that scopes nothing.
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT_OTHER_TENANT, TENANT);
  });

  it('refuses an account_id that does not exist at all, with the SAME message as a tenant mismatch', async () => {
    // Deliberately indistinguishable from the mismatch case — a different
    // message would let a caller probe whether an id exists in another tenant.
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_NONEXISTENT },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/does not belong to this tenant/);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT_NONEXISTENT, TENANT);
  });

  it('answers a foreign account_id and a nonexistent one byte-identically', async () => {
    /**
     * The oracle property, asserted rather than described. With the scoped
     * lookup the two cases are one `null` and cannot diverge, but this is the
     * test that would catch a future "helpful" 404-vs-400 split or a message
     * that names which of the two happened.
     */
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp();

    const foreign = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_OTHER_TENANT },
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_NONEXISTENT },
    });

    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.body).toBe(missing.body);
  });

  it('accepts an account_id that genuinely belongs to the caller\'s own tenant', async () => {
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(account({ id: ACCOUNT_OWN_TENANT, tenant_id: TENANT }));

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_OWN_TENANT },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith(ACCOUNT_OWN_TENANT, TENANT);
    expect(mocks.membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: ACCOUNT_OWN_TENANT, tenant_id: TENANT }),
      { requireProvenEmail: 'new@test.com' },
    );
  });

  it('never calls accountRepository when no account_id is supplied (tenant-wide invite)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.accountRepository.findByIdInTenant).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: null }),
      { requireProvenEmail: 'new@test.com' },
    );
  });
});

describe('user.routes — POST /invite account-scope enforcement (sibling-account IDOR)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue({ id: 'm-new', user_id: 'u-1', tenant_id: TENANT, account_id: ACCOUNT_OWN_TENANT, role: 'viewer' });
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'none' });
    mocks.userRepository.create.mockResolvedValue({ id: 'u-1', email: 'new@test.com' });
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(account({ id: ACCOUNT_OWN_TENANT, tenant_id: TENANT }));
  });

  it('refuses (403) an account-scoped account_admin who OMITS account_id — would invite tenant-wide', async () => {
    // `canManageRole` only compares ROLES, so without this check an
    // account-scoped `account_admin` could hand out a membership that
    // reaches every account in the tenant, wider than their own authority.
    const app = await buildApp('account_admin', ACCOUNT_OWN_TENANT);

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
  });

  it('refuses (403) an account-scoped account_admin naming a SIBLING account', async () => {
    const app = await buildApp('account_admin', ACCOUNT_OWN_TENANT);

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_OTHER_TENANT },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
  });

  it('allows an account-scoped account_admin naming their OWN account', async () => {
    const app = await buildApp('account_admin', ACCOUNT_OWN_TENANT);

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer', account_id: ACCOUNT_OWN_TENANT },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: ACCOUNT_OWN_TENANT }),
      { requireProvenEmail: 'new@test.com' },
    );
  });

  it('a TENANT-WIDE membership may still invite tenant-wide or into any account', async () => {
    const app = await buildApp('account_admin'); // no account_id ⇒ tenant-wide

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: null }),
      { requireProvenEmail: 'new@test.com' },
    );
  });
});

describe('user.routes — POST /invite reactivates a leftover membership', () => {
  /**
   * Offboarding leaves the row (`status = 'revoked'`). Asking `findByUserAndTenant`
   * — which filters `active` — then INSERTing is the unique-constraint 500 this
   * suite exists to keep from coming back. Same hole as super-admin add.
   */
  const leftover = {
    id: 'm-revoked',
    user_id: 'u-1',
    tenant_id: TENANT,
    account_id: null as string | null,
    role: 'operator',
    status: 'revoked',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: 'u-1', email: 'back@test.com' } });
    mocks.membershipRepository.reactivateWithRole.mockResolvedValue({
      ...leftover, status: 'active', role: 'viewer',
    });
    mocks.membershipRepository.create.mockResolvedValue({ id: 'm-new' });
  });

  it('reactivates a revoked tenant-level membership with the new role', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([leftover]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.reactivateWithRole).toHaveBeenCalledWith('m-revoked', 'viewer', TENANT, { requireProvenEmail: 'back@test.com' });
    expect(mocks.redisCache.del).toHaveBeenCalledWith('cache:membership:u-1:tenant-1');
    expect(res.json().membership.role).toBe('viewer');
    expect(res.json().membership.status).toBe('active');
  });

  it('reactivates an inactive leftover the same way', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([
      { ...leftover, status: 'inactive' },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'agent' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.reactivateWithRole).toHaveBeenCalledWith('m-revoked', 'agent', TENANT, { requireProvenEmail: 'back@test.com' });
  });

  it('still 409s when the matching membership is already active', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([
      { ...leftover, status: 'active' },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(mocks.membershipRepository.reactivateWithRole).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
  });

  it('does not treat an account-scoped leftover as the tenant-wide invite', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([
      { ...leftover, account_id: ACCOUNT_OWN_TENANT },
    ]);
    mocks.membershipRepository.create.mockResolvedValue({
      id: 'm-new', user_id: 'u-1', tenant_id: TENANT, account_id: null, role: 'viewer',
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.reactivateWithRole).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ account_id: null }),
      { requireProvenEmail: 'back@test.com' },
    );
  });

  it('reactivates a revoked membership scoped to the invited account', async () => {
    mocks.accountRepository.findByIdInTenant.mockResolvedValue({
      id: ACCOUNT_OWN_TENANT, tenant_id: TENANT,
    });
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([
      { ...leftover, account_id: ACCOUNT_OWN_TENANT },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer', account_id: ACCOUNT_OWN_TENANT },
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.membershipRepository.create).not.toHaveBeenCalled();
    expect(mocks.membershipRepository.reactivateWithRole).toHaveBeenCalledWith('m-revoked', 'viewer', TENANT, { requireProvenEmail: 'back@test.com' });
  });

  it('409s when a concurrent reactivate already flipped the leftover to active', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([leftover]);
    mocks.membershipRepository.reactivateWithRole.mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(mocks.redisCache.del).not.toHaveBeenCalled();
  });

  /**
   * ── Three reasons nothing was written, and they are not one sentence ──────
   * The re-read after a refused write decides only the WORDING. Two of the
   * three reasons are races on the user row rather than on the membership, and
   * they send the reader to different people:
   *
   *   * flagged     — the address resolves to somebody who has not proven it.
   *                   Their problem; they verify and the invitation works.
   *   * rebound     — a VERIFIED claim rewrote `users.email` to its own
   *                   address, so the row is no longer this address's at all.
   *                   Nobody is waiting on a verification, and retrying works.
   *   * raced write — the ordinary #280 case: somebody else took the leftover.
   */
  it('names the UNVERIFIED holder when the row was flagged underneath the write', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue(null);
    mocks.userRepository.resolveByProvenEmail
      .mockResolvedValueOnce({ status: 'found', user: { id: 'u-1', email: 'back@test.com' } })
      .mockResolvedValueOnce({ status: 'unproven_conflict' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('unverified_address_holder');
    expect(mocks.redisCache.del).not.toHaveBeenCalled();
  });

  it('names the REBOUND address when a verified claim took it mid-write', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue(null);
    /**
     * The address now resolves to nothing: the row that held it was rewritten
     * to the claimant's own verified address. Sending the admin to chase a
     * verification here would be advice about the wrong person, so this must
     * not come back as `unverified_address_holder`.
     */
    mocks.userRepository.resolveByProvenEmail
      .mockResolvedValueOnce({ status: 'found', user: { id: 'u-1', email: 'back@test.com' } })
      .mockResolvedValueOnce({ status: 'none' });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('address_rebound_during_invite');
    expect(res.json().message).toMatch(/send the invitation again/i);
    expect(mocks.redisCache.del).not.toHaveBeenCalled();
  });

  it('names the rebound address when it resolves to a DIFFERENT row than the one written to', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue(null);
    // A fresh stub for the address already exists by the time we re-read. Still
    // not our row, so still not a membership we may write.
    mocks.userRepository.resolveByProvenEmail
      .mockResolvedValueOnce({ status: 'found', user: { id: 'u-1', email: 'back@test.com' } })
      .mockResolvedValueOnce({ status: 'found', user: { id: 'u-2', email: 'back@test.com' } });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('address_rebound_during_invite');
  });

  it('still reports the plain membership conflict when the row never changed', async () => {
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([leftover]);
    mocks.membershipRepository.reactivateWithRole.mockResolvedValue(null);
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({
      status: 'found', user: { id: 'u-1', email: 'back@test.com' },
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'back@test.com', role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBeUndefined();
    expect(res.json().message).toMatch(/already has a membership/i);
  });
});

const TARGET_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TARGET_MEMBERSHIP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function targetMembership(role: string) {
  return {
    id: TARGET_MEMBERSHIP,
    user_id: TARGET_USER,
    tenant_id: TENANT,
    account_id: null,
    role,
    status: 'active',
  };
}

describe('user.routes — PUT /:id/role current-role check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: true, value: targetMembership('viewer') });
  });

  it('refuses a tenant_admin demoting a tenant_owner to viewer', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/equal to or above your own/);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('refuses a tenant_admin demoting a peer tenant_admin', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_admin')]);

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('lets a tenant_owner demote a tenant_admin', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_admin')]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: true, value: targetMembership('operator') });

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'operator' },
    });

    expect(res.statusCode).toBe(200);
    // The role read for the RBAC check is passed back in as the expected role,
    // so the write is a compare-and-swap rather than a blind UPDATE.
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'tenant_admin', 'operator');
  });

  it('lets a tenant_owner demote a co-owner when another owner remains', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: true, value: targetMembership('tenant_admin') });

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'tenant_admin' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'tenant_owner', 'tenant_admin');
  });

  it('refuses demoting the last tenant_owner', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: false, reason: 'last_owner' });

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'tenant_admin' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/last tenant owner/);
  });

  it('409s when the target was re-roled between the RBAC check and the write', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: false, reason: 'role_changed' });

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    // Not a 200: `canManageExistingRole` was decided against a role the target
    // no longer holds, so the verdict does not carry.
    expect(res.statusCode).toBe(409);
  });

  it('404s when the membership was revoked between the read and the write', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: false, reason: 'not_found' });

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('user.routes — DELETE /:id/membership current-role check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: true });
  });

  it('refuses a tenant_admin removing a tenant_owner even when another owner remains', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${TARGET_USER}/membership`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toMatch(/equal to or above your own/);
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('refuses a tenant_admin removing a peer tenant_admin', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_admin')]);

    const app = await buildApp('tenant_admin');
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${TARGET_USER}/membership`,
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('lets a tenant_owner remove a tenant_admin', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_admin')]);

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${TARGET_USER}/membership`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'tenant_admin');
  });

  it('lets a tenant_owner remove a co-owner when another owner remains', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${TARGET_USER}/membership`,
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'tenant_owner');
  });

  it('refuses removing the last tenant_owner', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('tenant_owner')]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: false, reason: 'last_owner' });

    const app = await buildApp('tenant_owner');
    const res = await app.inject({
      method: 'DELETE',
      url: `/users/${TARGET_USER}/membership`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/last tenant owner/);
  });
});

/**
 * A user can hold a tenant-wide membership (`account_id = NULL`) AND an
 * account-scoped one, because invite's duplicate check is per account context.
 * `findByUserAndTenant` has no `ORDER BY`, so which one came back first was
 * Postgres's choice — and it decided both which row got written and which role
 * the caller was checked against. Each case below submits the SAME pair in both
 * heap orders and demands the same answer.
 */
describe('user.routes — a target holding more than one membership', () => {
  const OTHER_MEMBERSHIP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function scopedMembership(role: string) {
    return { ...targetMembership(role), id: OTHER_MEMBERSHIP, account_id: ACCOUNT_OWN_TENANT };
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
  });

  for (const reversed of [false, true]) {
    const label = reversed ? 'owner row last' : 'owner row first';

    it(`refuses a tenant_admin against a tenant_owner + operator pair (${label})`, async () => {
      const rows = [targetMembership('tenant_owner'), scopedMembership('operator')];
      mocks.membershipRepository.findByUserAndTenant.mockResolvedValue(reversed ? rows.reverse() : rows);
      mocks.membershipRepository.updateRoleGuardingLastOwner
        .mockResolvedValue({ ok: true, value: targetMembership('viewer') });

      const app = await buildApp('tenant_admin');
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${TARGET_USER}/role`,
        payload: { role: 'viewer' },
      });

      expect(res.statusCode).toBe(403);
      expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
    });

    it(`writes the strongest-role membership, not the first row (${label})`, async () => {
      const rows = [targetMembership('tenant_admin'), scopedMembership('operator')];
      mocks.membershipRepository.findByUserAndTenant.mockResolvedValue(reversed ? rows.reverse() : rows);
      mocks.membershipRepository.updateRoleGuardingLastOwner
        .mockResolvedValue({ ok: true, value: targetMembership('viewer') });

      const app = await buildApp('tenant_owner');
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${TARGET_USER}/role`,
        payload: { role: 'viewer' },
      });

      expect(res.statusCode).toBe(200);
      expect(mocks.membershipRepository.updateRoleGuardingLastOwner)
        .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'tenant_admin', 'viewer');
    });
  }
});

/**
 * `PUT /:id/role` and `DELETE /:id/membership` — account-scope enforcement
 * (sibling-account / tenant-wide-target IDOR).
 *
 * `canManageExistingRole` compares ROLES only, so nothing upstream checked
 * that an account-scoped `tenant_admin`'s own account agreed with the target
 * membership's `account_id` — an account-scoped caller could manage (demote,
 * promote, remove) a membership scoped to a SIBLING account, or a
 * TENANT-WIDE one that reaches every account including the caller's own.
 */
describe('user.routes — PUT /:id/role and DELETE /:id/membership account-scope enforcement', () => {
  function accountScopedTarget(role: string, accountId: string) {
    return { ...targetMembership(role), account_id: accountId };
  }

  /**
   * Reviewer-caught bug: `primaryMembership()` picked by ROLE STRENGTH across
   * the whole tenant BEFORE the account-scope check ran, so a target who is
   * `operator` on the caller's own account but a STRONGER role on a sibling
   * account got the sibling row picked first — and refused as out-of-scope,
   * even though the in-scope row was perfectly manageable. Invite's own
   * duplicate check means at most one row per account, so this is exactly
   * the two-membership shape that check has to get right: filter to the
   * caller's account BEFORE picking primary, not after.
   */
  const IN_SCOPE_MEMBERSHIP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.redisCache.del.mockResolvedValue(undefined);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: true, value: targetMembership('viewer') });
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: true });
  });

  it('PUT /:id/role — 404s an account-scoped caller against a TENANT-WIDE target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('PUT /:id/role — 404s an account-scoped caller against a SIBLING account\'s target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      accountScopedTarget('operator', ACCOUNT_OTHER_TENANT),
    ]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('PUT /:id/role — allows an account-scoped caller against their OWN account\'s target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      accountScopedTarget('operator', ACCOUNT_OWN_TENANT),
    ]);
    mocks.membershipRepository.updateRoleGuardingLastOwner
      .mockResolvedValue({ ok: true, value: accountScopedTarget('viewer', ACCOUNT_OWN_TENANT) });

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'operator', 'viewer');
  });

  it('PUT /:id/role — a TENANT-WIDE caller is unaffected — may manage any target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);

    const app = await buildApp('tenant_admin'); // no account_id ⇒ tenant-wide
    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).toHaveBeenCalled();
  });

  for (const reversed of [false, true]) {
    const label = reversed ? 'stronger row first' : 'stronger row last';

    it(`PUT /:id/role — manages the IN-SCOPE row even when a STRONGER sibling-account row outranks it (${label})`, async () => {
      const inScope = { ...accountScopedTarget('operator', ACCOUNT_OWN_TENANT), id: IN_SCOPE_MEMBERSHIP };
      const outOfScope = accountScopedTarget('account_admin', ACCOUNT_OTHER_TENANT); // id: TARGET_MEMBERSHIP
      const rows = [outOfScope, inScope];
      mocks.membershipRepository.findByUserAndTenant.mockResolvedValue(reversed ? rows.reverse() : rows);
      mocks.membershipRepository.updateRoleGuardingLastOwner
        .mockResolvedValue({ ok: true, value: { ...inScope, role: 'viewer' } });

      const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
      const res = await app.inject({
        method: 'PUT',
        url: `/users/${TARGET_USER}/role`,
        payload: { role: 'viewer' },
      });

      // Before the fix: primaryMembership picked `outOfScope` (account_admin
      // outranks operator) first, then the scope check 404'd it — refusing a
      // caller who plainly had a manageable row in their own account.
      expect(res.statusCode).toBe(200);
      expect(mocks.membershipRepository.updateRoleGuardingLastOwner)
        .toHaveBeenCalledWith(IN_SCOPE_MEMBERSHIP, TENANT, 'operator', 'viewer');
    });
  }

  it('DELETE /:id/membership — 404s an account-scoped caller against a TENANT-WIDE target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(404);
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('DELETE /:id/membership — 404s an account-scoped caller against a SIBLING account\'s target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      accountScopedTarget('operator', ACCOUNT_OTHER_TENANT),
    ]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(404);
    expect(mocks.membershipRepository.removeGuardingLastOwner).not.toHaveBeenCalled();
  });

  it('DELETE /:id/membership — allows an account-scoped caller against their OWN account\'s target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      accountScopedTarget('operator', ACCOUNT_OWN_TENANT),
    ]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner)
      .toHaveBeenCalledWith(TARGET_MEMBERSHIP, TENANT, 'operator');
  });

  it('DELETE /:id/membership — a TENANT-WIDE caller is unaffected — may manage any target', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([targetMembership('operator')]);

    const app = await buildApp('tenant_admin'); // no account_id ⇒ tenant-wide
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner).toHaveBeenCalled();
  });

  it('DELETE /:id/membership — removes the IN-SCOPE row even when a STRONGER sibling-account row outranks it', async () => {
    const inScope = { ...accountScopedTarget('operator', ACCOUNT_OWN_TENANT), id: IN_SCOPE_MEMBERSHIP };
    const outOfScope = accountScopedTarget('account_admin', ACCOUNT_OTHER_TENANT); // id: TARGET_MEMBERSHIP
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([outOfScope, inScope]);

    const app = await buildApp('tenant_admin', ACCOUNT_OWN_TENANT);
    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.removeGuardingLastOwner)
      .toHaveBeenCalledWith(IN_SCOPE_MEMBERSHIP, TENANT, 'operator');
  });
});
