import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests for the account routes: `GET /accounts` (its account-scope
 * confinement), `GET /accounts/mine` and `POST /accounts`.
 *
 * `GET /accounts/mine`: an `agent`-role user can never resolve their
 * account via `GET /accounts` (floors at `account.read` = `viewer`, and
 * `agent` sits below `viewer` in ROLE_HIERARCHY by design), so the console's
 * `TenantContext` never sets an active account and the feature-flag context
 * spins forever. `/mine` is authentication-only — no `requirePermission` call
 * — and returns exactly the caller's own memberships resolved to accounts,
 * never the tenant's full list.
 */

const mocks = vi.hoisted(() => ({
  accountRepository: {
    findByTenantId: vi.fn(),
    findByIds: vi.fn(),
    findByIdInTenant: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
  },
  membershipRepository: {
    findByUserAndTenant: vi.fn(),
  },
  audit: { log: vi.fn() },
  createTenantAccount: vi.fn(),
}));

// Auth/tenant-context stubbed — these tests are about the route's own
// authorization decision (or deliberate absence of one for /mine), not the
// middleware chain that resolves tenant/user in production.
vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// RBAC is NOT mocked: `requirePermission` is pure (the membership's role against the
// contract's PERMISSION_MATRIX), so every floor asserted here is the real one. An agent
// must still be 403'd by the plain list route; only /mine skips the check.
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('../../../../src/audit/platform/audit-logger.js', () => ({
  platformAuditLogger: mocks.audit,
}));
// The write itself (transaction, tenant lock, name rule, slug) is `createTenantAccount`'s,
// covered on real Postgres in `test/integration/api/account.routes.test.ts`; here it is the
// route's job that is pinned: who may call, what is validated, what each outcome answers.
vi.mock('../../../../src/api/routes/helpers/create-account.js', () => ({
  createTenantAccount: mocks.createTenantAccount,
}));
import Fastify from 'fastify';
import { accountRoutes } from '../../../../src/api/routes/account.routes.js';

const TENANT = 'tenant-1';

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
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

/** `request.user`/`request.tenantId`/`request.membership` are set here rather
 * than by the (stubbed) real middleware, mirroring how they'd be populated in
 * production for the scenario under test. */
async function buildApp(context: {
  user?: { id: string } | undefined;
  tenantId?: string;
  membership?: { role: string; account_id?: string | null };
} = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request: any) => {
    request.user = 'user' in context ? context.user : { id: 'user-1' };
    request.tenantId = context.tenantId ?? TENANT;
    if (context.membership) request.membership = context.membership;
  });
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.ready();
  return app;
}

describe('account.routes — GET /accounts/mine', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) — several tests rely on a mock NOT
    // carrying over a previous test's mockResolvedValue.
    vi.resetAllMocks();
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    mocks.accountRepository.findByIds.mockResolvedValue([]);
    mocks.accountRepository.findByTenantId.mockResolvedValue([]);
  });

  it('returns the accounts an agent membership points at, with no permission check', async () => {
    // The defect this fixes: an `agent` role (level 5) fails `account.read`
    // (floors at `viewer`, level 10) on the plain list route.
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      { id: 'm1', user_id: 'user-1', tenant_id: TENANT, account_id: 'acct-1', role: 'agent', status: 'active', invited_by: null, created_at: new Date(), updated_at: new Date() },
    ]);
    mocks.accountRepository.findByIds.mockResolvedValue([account()]);

    const app = await buildApp({ membership: { role: 'agent' } });
    const res = await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [{ id: 'acct-1', name: 'Acct One', tenant_id: TENANT }] });
    expect(mocks.accountRepository.findByIds).toHaveBeenCalledWith(['acct-1'], TENANT);
    expect(mocks.accountRepository.findByTenantId).not.toHaveBeenCalled();
    await app.close();
  });

  it('the same agent is 403d by the plain list route — this fix does not widen account.read', async () => {
    const app = await buildApp({ membership: { role: 'agent' } });
    const res = await app.inject({ method: 'GET', url: '/accounts' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('resolves a tenant-wide (account_id=NULL) membership to every account in the tenant', async () => {
    // Mirrors the existing rule in tenant-context.middleware.ts and the RBAC
    // layer: a NULL account_id membership grants access to all accounts.
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      { id: 'm1', user_id: 'user-1', tenant_id: TENANT, account_id: null, role: 'tenant_admin', status: 'active', invited_by: null, created_at: new Date(), updated_at: new Date() },
    ]);
    mocks.accountRepository.findByTenantId.mockResolvedValue([
      account({ id: 'acct-1', name: 'One' }),
      account({ id: 'acct-2', name: 'Two' }),
    ]);

    const app = await buildApp({ membership: { role: 'tenant_admin' } });
    const res = await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json().accounts).toHaveLength(2);
    expect(mocks.accountRepository.findByIds).not.toHaveBeenCalled();
    await app.close();
  });

  it('de-duplicates account ids across multiple memberships', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      { id: 'm1', user_id: 'user-1', tenant_id: TENANT, account_id: 'acct-1', role: 'agent', status: 'active', invited_by: null, created_at: new Date(), updated_at: new Date() },
      { id: 'm2', user_id: 'user-1', tenant_id: TENANT, account_id: 'acct-1', role: 'viewer', status: 'active', invited_by: null, created_at: new Date(), updated_at: new Date() },
    ]);
    mocks.accountRepository.findByIds.mockResolvedValue([account()]);

    const app = await buildApp({ membership: { role: 'agent' } });
    await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(mocks.accountRepository.findByIds).toHaveBeenCalledWith(['acct-1'], TENANT);
    await app.close();
  });

  it('returns an empty list for a caller with no memberships in this tenant, rather than throwing', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);

    const app = await buildApp({ membership: { role: 'agent' } });
    const res = await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [] });
    expect(mocks.accountRepository.findByIds).toHaveBeenCalledWith([], TENANT);
    await app.close();
  });

  // There are no platform API keys (decision #5); the route keeps its `!request.user`
  // guard, and this pins it.
  it('degrades to an empty list under pure API-key auth with no associated user', async () => {
    const app = await buildApp({ user: undefined });
    const res = await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [] });
    expect(mocks.membershipRepository.findByUserAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('never returns another tenant\'s accounts', async () => {
    // request.tenantId is proven to belong to the caller upstream by
    // tenantContextMiddleware; this asserts the handler threads it through to
    // BOTH the membership lookup AND the account lookup. The account lookup
    // matters independently: `memberships.account_id` has no composite FK
    // back to the membership's own tenant_id, so a
    // cross-tenant membership row is possible upstream of this route (see
    // `accountRepository.findByIds`'s docstring and the `POST /users/invite`
    // fix in `user.routes.ts`) — this route's OWN defence is passing
    // `tenantId` into `findByIds` as an independent filter, not trusting that
    // every membership row it reads is already tenant-clean.
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      { id: 'm1', user_id: 'user-1', tenant_id: 'tenant-other', account_id: 'acct-cross-tenant', role: 'agent', status: 'active', invited_by: null, created_at: new Date(), updated_at: new Date() },
    ]);

    const app = await buildApp({ tenantId: 'tenant-other', membership: { role: 'agent' } });
    await app.inject({ method: 'GET', url: '/accounts/mine' });

    expect(mocks.membershipRepository.findByUserAndTenant).toHaveBeenCalledWith('user-1', 'tenant-other');
    // The bug this pins: findByIds used to be called with ONLY the id array —
    // no tenant argument at all — so a cross-tenant membership row resolved
    // straight through to that other tenant's account. Asserting the full
    // argument list (not just "was called") is what makes this fail if the
    // tenantId argument is ever dropped again.
    expect(mocks.accountRepository.findByIds).toHaveBeenCalledWith(['acct-cross-tenant'], 'tenant-other');
    await app.close();
  });
});

describe('account.routes — GET /accounts account-scope enforcement (sibling-account enumeration)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('confines an account-scoped caller to their OWN account, not the whole tenant list', async () => {
    // `account.read` proves the caller's ROLE only, and `findByTenantId` had
    // no account predicate — an account-scoped `viewer` got every sibling
    // account's full row, including `settings.default_pipeline`. The same
    // enumeration the original PUT finding used, via a read instead of a write.
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(account({ id: 'acct-a', name: 'Mine' }));
    const app = await buildApp({ membership: { role: 'viewer', account_id: 'acct-a' } });

    const res = await app.inject({ method: 'GET', url: '/accounts' });

    expect(res.statusCode).toBe(200);
    expect(res.json().accounts).toEqual([expect.objectContaining({ id: 'acct-a', name: 'Mine' })]);
    expect(mocks.accountRepository.findByIdInTenant).toHaveBeenCalledWith('acct-a', TENANT);
    expect(mocks.accountRepository.findByTenantId).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns an empty list rather than throwing if the scoped account has since vanished', async () => {
    mocks.accountRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp({ membership: { role: 'viewer', account_id: 'acct-a' } });

    const res = await app.inject({ method: 'GET', url: '/accounts' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accounts: [] });
    await app.close();
  });

  it('a TENANT-WIDE membership is unaffected — sees the full tenant list', async () => {
    mocks.accountRepository.findByTenantId.mockResolvedValue([
      account({ id: 'acct-a', name: 'One' }),
      account({ id: 'acct-b', name: 'Two' }),
    ]);
    const app = await buildApp({ membership: { role: 'viewer', account_id: null } });

    const res = await app.inject({ method: 'GET', url: '/accounts' });

    expect(res.statusCode).toBe(200);
    expect(res.json().accounts).toHaveLength(2);
    expect(mocks.accountRepository.findByIdInTenant).not.toHaveBeenCalled();
    await app.close();
  });
});

/** `POST /accounts`: a tenant admin adds an account. */
describe('account.routes — POST /accounts', () => {
  const created = account({ id: 'acct-new', name: 'East Coast Sales', slug: 'east-coast-sales' });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.createTenantAccount.mockResolvedValue({ status: 'created', account: created });
  });

  async function post(membership: { role: string; account_id?: string | null } | undefined, body: unknown) {
    const app = await buildApp(membership ? { membership } : {});
    const res = await app.inject({ method: 'POST', url: '/accounts', payload: body as Record<string, unknown> });
    await app.close();
    return res;
  }

  it.each(['tenant_admin', 'tenant_owner'])('a tenant-wide %s creates it: 201 with the row, the name trimmed', async (role) => {
    const res = await post({ role, account_id: null }, { name: '  East Coast Sales  ' });

    expect(res.statusCode).toBe(201);
    expect(res.json().account).toMatchObject({ id: 'acct-new', name: 'East Coast Sales', slug: 'east-coast-sales' });
    expect(mocks.createTenantAccount).toHaveBeenCalledWith(TENANT, 'East Coast Sales', expect.anything());
  });

  it('starts the account at zero concurrent calls: capacity is a super-admin act (decision AA4)', async () => {
    await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(mocks.createTenantAccount).toHaveBeenCalledWith(TENANT, 'Renewals', { initialMaxConcurrentCalls: 0 });
  });

  it('writes an account.created audit row filed under the new account', async () => {
    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'East Coast Sales' });

    expect(res.statusCode).toBe(201);
    expect(mocks.audit.log).toHaveBeenCalledTimes(1);
    expect(mocks.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT,
      account_id: 'acct-new',
      action: 'account.created',
      resource_type: 'account',
      resource_id: 'acct-new',
      details: { name: 'East Coast Sales', slug: 'east-coast-sales' },
      actor_type: 'human',
      user_id: 'user-1',
    }));
  });

  it.each(['account_admin', 'operator', 'viewer', 'agent'])('the real RBAC floor refuses a %s (403) and nothing is written', async (role) => {
    const res = await post({ role, account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(403);
    expect(mocks.createTenantAccount).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it('refuses a request with no membership at all (403)', async () => {
    const res = await post(undefined, { name: 'Renewals' });
    expect(res.statusCode).toBe(403);
    expect(mocks.createTenantAccount).not.toHaveBeenCalled();
  });

  it('refuses a tenant_admin whose seat is scoped to one account (403 tenant_wide_membership_required)', async () => {
    const res = await post({ role: 'tenant_admin', account_id: 'acct-1' }, { name: 'Renewals' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'tenant_wide_membership_required' });
    expect(res.json().message).toMatch(/access to the whole workspace/);
    expect(mocks.createTenantAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['a name over 100 characters', { name: 'x'.repeat(101) }],
    ['a name with a newline', { name: 'Sales\nTeam' }],
    ['a name with a zero-width space', { name: 'Sales\u200b' }],
    ['a name with a bidi override', { name: '\u202eselaS' }],
    ['a name with a line separator', { name: 'Sales\u2028Team' }],
    ['a name with a C1 control', { name: 'Sales\u0085' }],
    ['a non-string name', { name: 42 }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await post({ role: 'tenant_admin', account_id: null }, body);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
    expect(mocks.createTenantAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly 100 characters', 'x'.repeat(100)],
    ['accents', 'Crème Brûlée'],
    ['another script', '営業チーム'],
    ['inner punctuation and spaces', 'North & South — Renewals'],
  ])('accepts a name with %s', async (_label, name) => {
    const res = await post({ role: 'tenant_admin', account_id: null }, { name });
    expect(res.statusCode).toBe(201);
    expect(mocks.createTenantAccount).toHaveBeenCalledWith(TENANT, name, { initialMaxConcurrentCalls: 0 });
  });

  it('answers 409 account_name_taken when the helper reports the name taken, and audits nothing', async () => {
    mocks.createTenantAccount.mockResolvedValue({ status: 'name_taken' });

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: 'account_name_taken' });
    expect(res.json().message).toContain('"Renewals"');
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it('answers 404 when the tenant was deleted under the request', async () => {
    mocks.createTenantAccount.mockResolvedValue({ status: 'tenant_not_found' });

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(404);
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it('does not swallow a database error', async () => {
    mocks.createTenantAccount.mockRejectedValue(Object.assign(new Error('boom'), { code: '23503' }));

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(500);
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });
});
