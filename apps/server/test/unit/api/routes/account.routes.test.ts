import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Route-level tests for `GET /accounts/mine`: an `agent`-role user can never resolve their
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
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  // Real behaviour, not a blanket stub: /accounts (GET, plain list) must
  // still 403 an agent, which is the exact defect this fix works around
  // rather than removes. Only /mine must reach the handler unconditionally.
  requirePermission: (permission: string) => async (request: any, reply: any) => {
    const role = request.membership?.role;
    const floor: Record<string, number> = {
      agent: 5, viewer: 10, operator: 20, account_admin: 30, tenant_admin: 40, tenant_owner: 50,
    };
    const requiredFloor: Record<string, number> = { 'account.read': 10, 'account.create': 40, 'account.update': 30, 'account.delete': 40 };
    if (!role || (floor[role] ?? 0) < (requiredFloor[permission] ?? 0)) {
      return reply.code(403).send({ error: 'Forbidden', message: `Requires ${permission}` });
    }
  },
}));

vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('../../../../src/audit/platform/audit-logger.js', () => ({
  platformAuditLogger: mocks.audit,
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

/**
 * `POST /accounts` — a tenant admin adds an account. The helper it calls
 * (`createTenantAccount`) runs for real against the mocked repository; the slug
 * index's own behaviour is pinned against Postgres in
 * `test/integration/api/create-account.test.ts`.
 */
describe('account.routes — POST /accounts', () => {
  const created = (input: { tenant_id: string; name: string; slug: string }) =>
    account({ id: 'acct-new', tenant_id: input.tenant_id, name: input.name, slug: input.slug });

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.accountRepository.findByTenantId.mockResolvedValue([account({ name: 'Default', slug: 'default' })]);
    mocks.accountRepository.create.mockImplementation(async (input: { tenant_id: string; name: string; slug: string }) => created(input));
  });

  async function post(membership: { role: string; account_id?: string | null } | undefined, body: unknown) {
    const app = await buildApp(membership ? { membership } : {});
    const res = await app.inject({ method: 'POST', url: '/accounts', payload: body as Record<string, unknown> });
    await app.close();
    return res;
  }

  it.each(['tenant_admin', 'tenant_owner'])('a tenant-wide %s creates the account (201, trimmed name, slug from the name)', async (role) => {
    const res = await post({ role, account_id: null }, { name: '  East Coast Sales  ' });

    expect(res.statusCode).toBe(201);
    expect(res.json().account).toMatchObject({ id: 'acct-new', name: 'East Coast Sales', slug: 'east-coast-sales', tenant_id: TENANT });
    expect(mocks.accountRepository.create).toHaveBeenCalledWith({ tenant_id: TENANT, name: 'East Coast Sales', slug: 'east-coast-sales' });
  });

  it('writes an account.created audit row filed under the new account', async () => {
    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(201);
    expect(mocks.audit.log).toHaveBeenCalledTimes(1);
    expect(mocks.audit.log).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT,
      account_id: 'acct-new',
      action: 'account.created',
      resource_type: 'account',
      resource_id: 'acct-new',
      details: { name: 'Renewals', slug: 'renewals' },
      actor_type: 'human',
      user_id: 'user-1',
    }));
  });

  it.each(['account_admin', 'operator', 'viewer', 'agent'])('refuses a %s (403) and writes nothing', async (role) => {
    const res = await post({ role, account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(403);
    expect(mocks.accountRepository.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it('refuses a tenant_admin whose seat is scoped to one account (403 tenant_wide_membership_required)', async () => {
    const res = await post({ role: 'tenant_admin', account_id: 'acct-1' }, { name: 'Renewals' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'tenant_wide_membership_required' });
    expect(mocks.accountRepository.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing name', {}],
    ['a blank name', { name: '   ' }],
    ['a name over 100 characters', { name: 'x'.repeat(101) }],
    ['a name with a control character', { name: 'Sales\nTeam' }],
    ['a non-string name', { name: 42 }],
  ])('answers 400 for %s', async (_label, body) => {
    const res = await post({ role: 'tenant_admin', account_id: null }, body);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Bad Request');
    expect(mocks.accountRepository.create).not.toHaveBeenCalled();
  });

  it('accepts a name of exactly 100 characters', async () => {
    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'x'.repeat(100) });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a name a live account already has, ignoring case and spacing (409 account_name_taken)', async () => {
    mocks.accountRepository.findByTenantId.mockResolvedValue([account({ name: 'East  Coast Sales', slug: 'east-coast-sales' })]);

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'east coast SALES' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'Conflict', code: 'account_name_taken' });
    expect(mocks.accountRepository.create).not.toHaveBeenCalled();
    expect(mocks.audit.log).not.toHaveBeenCalled();
  });

  it('suffixes the slug when another name already holds it', async () => {
    mocks.accountRepository.findByTenantId.mockResolvedValue([account({ name: 'Sales!', slug: 'sales' })]);

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Sales?' });

    expect(res.statusCode).toBe(201);
    expect(res.json().account.slug).toMatch(/^sales-[0-9a-f]{6}$/);
  });

  it('falls back to an "account" slug for a name with no ASCII letters or digits', async () => {
    const res = await post({ role: 'tenant_admin', account_id: null }, { name: '営業' });

    expect(res.statusCode).toBe(201);
    expect(res.json().account).toMatchObject({ name: '営業', slug: 'account' });
  });

  it('a create that loses the slug race to the same name is name_taken, not a second account', async () => {
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'idx_accounts_tenant_slug_active' });
    mocks.accountRepository.create.mockRejectedValueOnce(conflict);
    mocks.accountRepository.findByTenantId
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([account({ name: 'Renewals', slug: 'renewals' })]);

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('account_name_taken');
    expect(mocks.accountRepository.create).toHaveBeenCalledTimes(1);
  });

  it('a create that loses the slug race to a different name retries with a suffixed slug', async () => {
    const conflict = Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'idx_accounts_tenant_slug_active' });
    mocks.accountRepository.create.mockRejectedValueOnce(conflict);
    mocks.accountRepository.findByTenantId
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([account({ name: 'Renewals!', slug: 'renewals' })]);

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(201);
    expect(mocks.accountRepository.create).toHaveBeenCalledTimes(2);
    expect(mocks.accountRepository.create.mock.calls[1]![0].slug).toMatch(/^renewals-[0-9a-f]{6}$/);
  });

  it('does not swallow a database error that is not the slug index', async () => {
    mocks.accountRepository.create.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '23503' }));

    const res = await post({ role: 'tenant_admin', account_id: null }, { name: 'Renewals' });

    expect(res.statusCode).toBe(500);
    expect(mocks.accountRepository.create).toHaveBeenCalledTimes(1);
  });
});
