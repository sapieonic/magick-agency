/* PORT NOTE (magick-agency): ported from master test/unit/api/routes/super-admin-accounts.test.ts@a1f0756a
 * (26 cases → 19, plus 5 equivalence cases ported from core
 * test/unit/api/routes/feature-flags-internal.test.ts@4850d1d9 "Internal S2S — provider concurrency
 * control plane" and 14 NEW equivalence cases for core's handler now running in-process).
 *
 * HOP COLLAPSE: master's tests mocked `coreInternalRequest`; core's `GET/PUT /internal/account-concurrency`
 * and `/utilization` now run inside the super-admin route, so the same behaviours are asserted against
 * `providerConcurrencyRepository` (getAllocation / switchToLegacy / replaceProviderBreakdown),
 * `accountSettingsRepository.invalidate`, the `seams/concurrency-control.ts` seam (stubbed with
 * `setConcurrencyControl`), core's `auditLogger` row and master's super-admin audit row. `it` names are
 * master's / core's, verbatim, even where they still say "core".
 *
 * Deleted (7): "should report unavailable rather than fabricate a limit when core returns 404" (a core
 * non-200 has no in-process counterpart: `getAllocation` returns an allocation or throws, and the throw is
 * the two cases after it); "rejects unknown providers before calling core" (telephony-provider catalog
 * check, deleted with the catalog); both `retry-sync` cases (no second service to re-sync); all three
 * `provider_concurrency_unsynced_accounts refresh` cases (drift gauge deleted — nothing to drift).
 * Changed: `invalidateConcurrencyAllocation` (master's broadcast-cap cache, deleted) assertions become
 * core's own invalidations; the success body is core's allocation (`total_concurrency`; there is no
 * `max_concurrent_calls` on `AccountConcurrencyAllocation`); the GET detail has no `providers` catalog.
 * Core's `callManager.triggerDequeue()` assertion is dropped (AI call queue; no counterpart).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  superAdminMiddleware: vi.fn(async (request: any) => {
    request.superAdmin = { id: 'sa-1', email: 'admin@test.com', name: 'Admin', status: 'active' as const };
  }),
  tenantRepo: {
    findById: vi.fn(),
  },
  accountRepo: {
    findByTenantId: vi.fn(),
    findById: vi.fn(),
  },
  auditLog: vi.fn().mockResolvedValue(undefined),
  phoneAssignmentRepo: {
    findAvailableForAccount: vi.fn(),
  },
  // PORT NOTE (magick-agency): core's repositories, now called in-process
  // (core's test mocked the same three methods plus `accountSettingsRepository.invalidate`).
  concurrencyRepo: {
    getAllocation: vi.fn(),
    replaceProviderBreakdown: vi.fn(),
    switchToLegacy: vi.fn(),
  },
  invalidateAccountSettings: vi.fn(),
  // core's `auditLogger` (the `concurrency.allocation.updated` audit_logs row).
  coreAuditLog: vi.fn(),
  // The seam that replaces core's `callManager.accountConcurrencyGuard` /
  // `providerConcurrencyGuard`.
  control: {
    invalidateAccountLimit: vi.fn(),
    invalidateProviderLimits: vi.fn(),
    getAccountProviderCounts: vi.fn(),
    getAccountCount: vi.fn(),
    getDistributedAccountCount: vi.fn(),
  },
}));

vi.mock('../../../../src/auth/super-admin.middleware.js', () => ({
  superAdminMiddleware: mocks.superAdminMiddleware,
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepo,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepo,
}));
vi.mock('@magick-agency/db/repositories/super-admin.repository', () => ({
  superAdminRepository: { findByEmail: vi.fn(), findById: vi.fn(), create: vi.fn(), findAll: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/super-admin-audit.repository', () => ({
  superAdminAuditRepository: { log: mocks.auditLog },
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: {},
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: mocks.phoneAssignmentRepo,
}));
// The real `ConcurrencyAllocationVersionConflictError`: the route's `instanceof`
// must see the class the repository throws.
vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  providerConcurrencyRepository: mocks.concurrencyRepo,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { invalidate: mocks.invalidateAccountSettings },
}));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({
  agencyCampaignAgentRepository: {},
}));
vi.mock('../../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: mocks.coreAuditLog },
}));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  // Q5 (Manas, 2026-10-09): revocation deletes report success here.
  redisCache: { del: vi.fn(), delForRevocation: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../../src/invites/invite-issuer.js', () => ({
  issueInvite: vi.fn(),
}));
vi.mock('@magick-agency/db', () => ({
  getPool: vi.fn(),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/config/index.js', () => ({
  config: { superAdmin: { jwtSecret: 'test-secret-1234567890' } },
}));

import Fastify from 'fastify';
import { superAdminRoutes } from '../../../../src/api/routes/super-admin.routes.js';
import { ConcurrencyAllocationVersionConflictError } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { setConcurrencyControl, resetConcurrencyControl } from '../../../../src/seams/concurrency-control.js';

function makeAccount(overrides: Partial<{ id: string; tenant_id: string; name: string; slug: string; status: string }> = {}) {
  return {
    id: overrides.id ?? 'acc-1',
    tenant_id: overrides.tenant_id ?? 'tenant-1',
    name: overrides.name ?? 'Default',
    slug: overrides.slug ?? 'default',
    settings: {},
    status: overrides.status ?? 'active',
    created_at: new Date(),
    updated_at: new Date(),
  };
}

/** An `AccountConcurrencyAllocation` as `providerConcurrencyRepository` returns it. */
function allocation(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: 'tenant-1', account_id: 'acc-1', mode: 'legacy_total', version: 1,
    total_concurrency: 5, providers: [], ...overrides,
  };
}

describe('super-admin account concurrency routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.phoneAssignmentRepo.findAvailableForAccount.mockResolvedValue([]);
    mocks.control.invalidateAccountLimit.mockResolvedValue(undefined);
    mocks.control.invalidateProviderLimits.mockResolvedValue(undefined);
    mocks.control.getAccountProviderCounts.mockResolvedValue({ status: 'available', counts: new Map() });
    mocks.control.getAccountCount.mockResolvedValue(0);
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 0 });
    setConcurrencyControl(mocks.control);
    app = Fastify();
    await app.register(superAdminRoutes, { prefix: '/super-admin' });
    await app.ready();
  });

  afterEach(async () => {
    resetConcurrencyControl();
    await app.close();
  });

  // ── GET /super-admin/tenants/:id/accounts ──────────────────

  describe('GET /super-admin/tenants/:id/accounts', () => {
    it('should return 404 when tenant does not exist', async () => {
      mocks.tenantRepo.findById.mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/no-such/accounts' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Not Found');
    });

    it('should return empty accounts array when tenant has no accounts', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ accounts: [] });
    });

    it('should return accounts with concurrency from core', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([makeAccount()]);
      // PORT NOTE (magick-agency): core's `GET /internal/account-concurrency` body
      // is now `providerConcurrencyRepository.getAllocation`, called in-process.
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(
        allocation({ mode: 'legacy_total', version: 1, total_concurrency: 10 }),
      );

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });
      expect(res.statusCode).toBe(200);
      const { accounts } = res.json();
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toEqual({
        id: 'acc-1',
        name: 'Default',
        slug: 'default',
        status: 'active',
        max_concurrent_calls: 10,
        concurrency_status: 'available',
        concurrency: expect.objectContaining({ total_concurrency: 10 }),
      });
      expect(mocks.concurrencyRepo.getAllocation).toHaveBeenCalledWith('tenant-1', 'acc-1');
    });

    it('returns the provider breakdown and derived total from provider-aware core', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([makeAccount()]);
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({
        mode: 'provider_breakdown', version: 3, total_concurrency: 50,
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
      }));

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });

      expect(res.statusCode).toBe(200);
      expect(res.json().accounts[0]).toMatchObject({
        max_concurrent_calls: 50,
        concurrency: {
          mode: 'provider_breakdown', total_concurrency: 50,
        },
      });
    });

    // PORT NOTE (magick-agency): "should report unavailable rather than fabricate a
    // limit when core returns 404" is deleted — see the file header.

    it('should report unavailable when the internal core request fails', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([makeAccount()]);
      mocks.concurrencyRepo.getAllocation.mockRejectedValue(new Error('No core connection'));

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });
      expect(res.statusCode).toBe(200);
      expect(res.json().accounts[0]).toMatchObject({ max_concurrent_calls: null, concurrency_status: 'unavailable' });
    });

    it('should report unavailable when core throws', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([makeAccount()]);
      mocks.concurrencyRepo.getAllocation.mockRejectedValue(new Error('Connection refused'));

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });
      expect(res.statusCode).toBe(200);
      expect(res.json().accounts[0]).toMatchObject({ max_concurrent_calls: null, concurrency_status: 'unavailable' });
    });

    it('should handle multiple accounts with individual concurrency', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findByTenantId.mockResolvedValue([
        makeAccount({ id: 'acc-1', slug: 'sales' }),
        makeAccount({ id: 'acc-2', slug: 'support' }),
      ]);
      mocks.concurrencyRepo.getAllocation
        .mockResolvedValueOnce(allocation({ account_id: 'acc-1', version: 1, total_concurrency: 20 }))
        .mockResolvedValueOnce(allocation({ account_id: 'acc-2', version: 1, total_concurrency: 8 }));

      const res = await app.inject({ method: 'GET', url: '/super-admin/tenants/tenant-1/accounts' });
      const { accounts } = res.json();
      expect(accounts).toHaveLength(2);
      expect(accounts[0].max_concurrent_calls).toBe(20);
      expect(accounts[1].max_concurrent_calls).toBe(8);
    });
  });

  // ── PUT /super-admin/tenants/:id/accounts/:accountId/concurrency ──

  describe('PUT /super-admin/tenants/:id/accounts/:accountId/concurrency', () => {
    const url = '/super-admin/tenants/tenant-1/accounts/acc-1/concurrency';
    const validBody = { max_concurrent_calls: 15 };

    it('should return 400 for invalid body', async () => {
      const res = await app.inject({ method: 'PUT', url, payload: { max_concurrent_calls: 0 } });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['max_concurrent_calls'] }),
      ]));
    });

    it('should return 400 for non-integer', async () => {
      const res = await app.inject({ method: 'PUT', url, payload: { max_concurrent_calls: 3.5 } });
      expect(res.statusCode).toBe(400);
    });

    it('should return 400 when over max', async () => {
      const res = await app.inject({ method: 'PUT', url, payload: { max_concurrent_calls: 1001 } });
      expect(res.statusCode).toBe(400);
    });

    it('should return 404 when tenant not found', async () => {
      mocks.tenantRepo.findById.mockResolvedValue(null);

      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe('Tenant not found');
    });

    it('should return 404 when account not found', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(null);

      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe('Account not found');
    });

    it('should return 404 when account belongs to different tenant', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'other-tenant' }));

      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(404);
      expect(res.json().message).toBe('Account not found');
    });

    it('should proxy update to core and return result', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({ version: 2, total_concurrency: 5 }));
      mocks.concurrencyRepo.switchToLegacy.mockResolvedValue(allocation({ version: 3, total_concurrency: 15 }));

      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(200);
      // PORT NOTE (magick-agency): the body is core's allocation, whose total is
      // `total_concurrency` (master read core's extra `max_concurrent_calls`).
      expect(res.json().total_concurrency).toBe(15);
      // PORT NOTE (magick-agency): master's `invalidateConcurrencyAllocation`
      // (broadcast-cap cache) is deleted; core's settings-row invalidation is the
      // in-process cache that must be busted.
      expect(mocks.invalidateAccountSettings).toHaveBeenCalledWith('tenant-1', 'acc-1');

      // core's `PUT /internal/account-concurrency` body, now the repository write:
      // the legacy body is translated with the CURRENT version.
      expect(mocks.concurrencyRepo.switchToLegacy).toHaveBeenLastCalledWith({
        tenant_id: 'tenant-1', account_id: 'acc-1', expected_version: 2, max_concurrent_calls: 15,
      });
    });

    it('should log audit entry on success', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({ version: 1, total_concurrency: 5 }));
      mocks.concurrencyRepo.switchToLegacy.mockResolvedValue(allocation({ version: 2, total_concurrency: 15 }));

      await app.inject({ method: 'PUT', url, payload: validBody });

      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        admin_id: 'sa-1',
        action: 'update_account_concurrency',
        resource_type: 'account',
        resource_id: 'acc-1',
        details: expect.objectContaining({
          tenant_id: 'tenant-1',
          max_concurrent_calls: 15,
          before: expect.objectContaining({ total_concurrency: 5 }),
          after: expect.objectContaining({ total_concurrency: 15 }),
        }),
      }));
    });

    it('does not bust the cached allocation when core rejects the write', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({ version: 2, total_concurrency: 5 }));
      // core's 409: the versioned write lost the optimistic lock.
      mocks.concurrencyRepo.switchToLegacy.mockRejectedValue(new ConcurrencyAllocationVersionConflictError(3));
      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(409);
      expect(mocks.invalidateAccountSettings).not.toHaveBeenCalled();
      expect(mocks.control.invalidateAccountLimit).not.toHaveBeenCalled();
      expect(mocks.control.invalidateProviderLimits).not.toHaveBeenCalled();
    });

    it('should return 500 when core is unavailable', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.concurrencyRepo.getAllocation.mockRejectedValue(new Error('No core connection'));

      const res = await app.inject({ method: 'PUT', url, payload: validBody });
      expect(res.statusCode).toBe(503);
      expect(res.json().message).toBe('Current concurrency allocation is unavailable');
    });

    it('proxies a validated provider breakdown to the provider-aware core route', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.phoneAssignmentRepo.findAvailableForAccount.mockResolvedValue([
        { provider_name: 'vobiz' }, { provider_name: 'voicelink' },
      ]);
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({ version: 1, total_concurrency: 50 }));
      mocks.concurrencyRepo.replaceProviderBreakdown.mockResolvedValue(allocation({
        mode: 'provider_breakdown', version: 2, total_concurrency: 50,
      }));
      const body = {
        mode: 'provider_breakdown', version: 1,
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
        change_reason: 'Purchased carrier capacity',
      } as const;

      const res = await app.inject({ method: 'PUT', url, payload: body });

      expect(res.statusCode).toBe(200);
      expect(mocks.concurrencyRepo.replaceProviderBreakdown).toHaveBeenLastCalledWith({
        tenant_id: 'tenant-1', account_id: 'acc-1', expected_version: 1, providers: body.providers,
      });
      expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({
          before: expect.objectContaining({ mode: 'legacy_total' }),
          after: expect.objectContaining({ mode: 'provider_breakdown' }),
        }),
      }));
    });

    // PORT NOTE (magick-agency): "rejects unknown providers before calling core"
    // is deleted with the telephony-provider catalog — see the file header.
  });

  // PORT NOTE (magick-agency): `POST …/concurrency/retry-sync` (2 cases) is
  // deleted with the route — see the file header.

  describe('GET /super-admin/tenants/:id/accounts/:accountId/concurrency', () => {
    const url = '/super-admin/tenants/tenant-1/accounts/acc-1/concurrency';

    it('combines allocation, utilization, and the Master provider catalog', async () => {
      mocks.tenantRepo.findById.mockResolvedValue({ id: 'tenant-1' });
      mocks.accountRepo.findById.mockResolvedValue(makeAccount({ tenant_id: 'tenant-1' }));
      mocks.concurrencyRepo.getAllocation.mockResolvedValue(allocation({
        mode: 'provider_breakdown', version: 2, total_concurrency: 50,
      }));
      mocks.control.getAccountCount.mockResolvedValue(17);

      const res = await app.inject({ method: 'GET', url });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        allocation: { total_concurrency: 50 },
        utilization: { total: { in_use: 17 } },
      });
      // PORT NOTE (magick-agency): master's `providers` catalog (and
      // `entitlements` / `synchronization`) are removed from the contract.
      expect(res.json()).not.toHaveProperty('providers');
      expect(res.json()).not.toHaveProperty('entitlements');
      expect(res.json()).not.toHaveProperty('synchronization');
    });
  });
});

// PORT NOTE (magick-agency): master's `provider_concurrency_unsynced_accounts
// refresh` describe (3 cases) is deleted with the drift gauge — see the header.

/**
 * Ported from core test/unit/api/routes/feature-flags-internal.test.ts@4850d1d9,
 * describe "Internal S2S — provider concurrency control plane" (5 cases → 5).
 * Core called `PUT /internal/account-concurrency` / `GET …/utilization` with the
 * S2S token; the same handler now runs inside the super-admin route, so the
 * cases go through `PUT|GET /super-admin/tenants/t1/accounts/a1/concurrency`.
 * `callManager.accountConcurrencyGuard` / `providerConcurrencyGuard` are the seam;
 * `triggerDequeue` has no counterpart and its assertion is dropped. The provider
 * breakdown now also passes master's routed-number check, so every allocated
 * provider has a route in `beforeEach`.
 */
describe('Internal S2S — provider concurrency control plane', () => {
  let app: ReturnType<typeof Fastify>;
  const url = '/super-admin/tenants/t1/accounts/a1/concurrency';

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.tenantRepo.findById.mockResolvedValue({ id: 't1' });
    mocks.accountRepo.findById.mockResolvedValue(makeAccount({ id: 'a1', tenant_id: 't1' }));
    mocks.phoneAssignmentRepo.findAvailableForAccount.mockResolvedValue([
      { provider_name: 'vobiz' }, { provider_name: 'voicelink' },
    ]);
    mocks.concurrencyRepo.getAllocation.mockResolvedValue({
      tenant_id: 't1', account_id: 'a1', mode: 'legacy_total', version: 1,
      total_concurrency: 5, providers: [],
    });
    mocks.concurrencyRepo.replaceProviderBreakdown.mockResolvedValue({
      tenant_id: 't1', account_id: 'a1', mode: 'provider_breakdown', version: 2,
      total_concurrency: 50,
      providers: [
        { provider: 'vobiz', max_concurrent_calls: 30 },
        { provider: 'voicelink', max_concurrent_calls: 20 },
      ],
    });
    mocks.control.getAccountCount.mockResolvedValue(0);
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 0 });
    mocks.control.invalidateAccountLimit.mockResolvedValue(undefined);
    mocks.control.invalidateProviderLimits.mockResolvedValue(undefined);
    mocks.control.getAccountProviderCounts.mockResolvedValue({
      status: 'available', counts: new Map(),
    });
    setConcurrencyControl(mocks.control);
    app = Fastify();
    await app.register(superAdminRoutes, { prefix: '/super-admin' });
    await app.ready();
  });

  afterEach(async () => {
    resetConcurrencyControl();
    await app.close();
  });

  it('atomically migrates a drained account to a versioned provider breakdown', async () => {
    const res = await app.inject({
      method: 'PUT', url,
      payload: {
        mode: 'provider_breakdown', version: 1,
        change_reason: 'Purchased carrier capacity',
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.concurrencyRepo.replaceProviderBreakdown).toHaveBeenCalledWith({
      tenant_id: 't1', account_id: 'a1', expected_version: 1,
      providers: [
        { provider: 'vobiz', max_concurrent_calls: 30 },
        { provider: 'voicelink', max_concurrent_calls: 20 },
      ],
    });
    expect(mocks.control.invalidateAccountLimit).toHaveBeenCalledWith('t1', 'a1');
  });

  it('blocks legacy-to-provider migration while calls are active', async () => {
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 2 });
    const res = await app.inject({
      method: 'PUT', url,
      payload: {
        mode: 'provider_breakdown', version: 1,
        change_reason: 'Purchased carrier capacity',
        providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ active_calls: 2, current_version: 1 });
    expect(mocks.concurrencyRepo.replaceProviderBreakdown).not.toHaveBeenCalled();
  });

  it('fails closed when the distributed active-call count is unavailable', async () => {
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'unavailable' });
    const res = await app.inject({
      method: 'PUT', url,
      payload: {
        mode: 'provider_breakdown', version: 1,
        change_reason: 'Purchased carrier capacity',
        providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
      },
    });

    expect(res.statusCode).toBe(503);
    expect(mocks.concurrencyRepo.replaceProviderBreakdown).not.toHaveBeenCalled();
  });

  it('supports an explicitly audited force migration during a controlled drain', async () => {
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 2 });
    const res = await app.inject({
      method: 'PUT', url,
      payload: {
        mode: 'provider_breakdown', version: 1,
        force_migration: true,
        change_reason: 'Approved maintenance migration',
        providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.coreAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      eventData: expect.objectContaining({ force_migration: true }),
    }));
  });

  it('returns unknown utilization instead of false zero when Redis is unavailable', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue({
      tenant_id: 't1', account_id: 'a1', mode: 'provider_breakdown', version: 2,
      total_concurrency: 30,
      providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
    });
    mocks.control.getAccountProviderCounts.mockResolvedValue({
      status: 'unavailable', counts: new Map(),
    });
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.json().utilization).toMatchObject({
      status: 'unavailable', total: { allocated: 30, in_use: null, available: null },
      providers: [{ provider: 'vobiz', in_use: null, available: null }],
    });
  });
});

/**
 * NEW (magick-agency): equivalence cases for core `PUT /internal/account-concurrency`
 * (`internal.routes.ts:366-450`) and `GET …/utilization` (`:325-364`) running
 * in-process behind the super-admin route — the properties core's handler had that
 * no core or master test pinned, or that the collapse could break.
 */
describe('in-process core concurrency handler (equivalence)', () => {
  let app: ReturnType<typeof Fastify>;
  const url = '/super-admin/tenants/t1/accounts/a1/concurrency';
  const breakdownBody = {
    mode: 'provider_breakdown', version: 1,
    change_reason: 'Purchased carrier capacity',
    providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
  };
  const legacyAllocation = {
    tenant_id: 't1', account_id: 'a1', mode: 'legacy_total', version: 1,
    total_concurrency: 5, providers: [],
  };
  const breakdownAllocation = {
    tenant_id: 't1', account_id: 'a1', mode: 'provider_breakdown', version: 2,
    total_concurrency: 30, providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.tenantRepo.findById.mockResolvedValue({ id: 't1' });
    mocks.accountRepo.findById.mockResolvedValue(makeAccount({ id: 'a1', tenant_id: 't1' }));
    mocks.phoneAssignmentRepo.findAvailableForAccount.mockResolvedValue([{ provider_name: 'vobiz' }]);
    mocks.concurrencyRepo.getAllocation.mockResolvedValue(legacyAllocation);
    mocks.concurrencyRepo.replaceProviderBreakdown.mockResolvedValue(breakdownAllocation);
    mocks.concurrencyRepo.switchToLegacy.mockResolvedValue({ ...legacyAllocation, version: 2, total_concurrency: 15 });
    mocks.control.getAccountCount.mockResolvedValue(0);
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 0 });
    mocks.control.invalidateAccountLimit.mockResolvedValue(undefined);
    mocks.control.invalidateProviderLimits.mockResolvedValue(undefined);
    mocks.control.getAccountProviderCounts.mockResolvedValue({ status: 'available', counts: new Map() });
    setConcurrencyControl(mocks.control);
    app = Fastify();
    await app.register(superAdminRoutes, { prefix: '/super-admin' });
    await app.ready();
  });

  afterEach(async () => {
    resetConcurrencyControl();
    await app.close();
  });

  it('invalidates in core\'s order: settings row cache → account guard limit → provider guard limits', async () => {
    const res = await app.inject({ method: 'PUT', url, payload: breakdownBody });

    expect(res.statusCode).toBe(200);
    expect(mocks.invalidateAccountSettings).toHaveBeenCalledWith('t1', 'a1');
    expect(mocks.control.invalidateAccountLimit).toHaveBeenCalledWith('t1', 'a1');
    expect(mocks.control.invalidateProviderLimits).toHaveBeenCalledWith('t1', 'a1');
    const settingsAt = mocks.invalidateAccountSettings.mock.invocationCallOrder[0]!;
    const accountAt = mocks.control.invalidateAccountLimit.mock.invocationCallOrder[0]!;
    const providerAt = mocks.control.invalidateProviderLimits.mock.invocationCallOrder[0]!;
    const writeAt = mocks.concurrencyRepo.replaceProviderBreakdown.mock.invocationCallOrder[0]!;
    expect(writeAt).toBeLessThan(settingsAt);
    expect(settingsAt).toBeLessThan(accountAt);
    expect(accountAt).toBeLessThan(providerAt);
  });

  it('a legacy write invalidates the same three caches in the same order', async () => {
    const res = await app.inject({
      method: 'PUT', url,
      payload: { mode: 'legacy_total', version: 1, max_concurrent_calls: 15, change_reason: 'Raise the cap' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.concurrencyRepo.switchToLegacy).toHaveBeenCalledWith({
      tenant_id: 't1', account_id: 'a1', expected_version: 1, max_concurrent_calls: 15,
    });
    // A legacy write never reads the drain count (core only checked it on a
    // legacy → provider migration).
    expect(mocks.control.getDistributedAccountCount).not.toHaveBeenCalled();
    const settingsAt = mocks.invalidateAccountSettings.mock.invocationCallOrder[0]!;
    const accountAt = mocks.control.invalidateAccountLimit.mock.invocationCallOrder[0]!;
    const providerAt = mocks.control.invalidateProviderLimits.mock.invocationCallOrder[0]!;
    expect(settingsAt).toBeLessThan(accountAt);
    expect(accountAt).toBeLessThan(providerAt);
  });

  it('the migration drain check reads the ACCOUNT guard\'s distributed count, scoped to the account', async () => {
    await app.inject({ method: 'PUT', url, payload: breakdownBody });

    expect(mocks.control.getDistributedAccountCount).toHaveBeenCalledWith('t1', 'a1');
    // Not the runtime accessor, which substitutes a process-local count.
    expect(mocks.control.getAccountCount).not.toHaveBeenCalled();
  });

  it('force_migration also bypasses an unavailable distributed count', async () => {
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'unavailable' });
    const res = await app.inject({ method: 'PUT', url, payload: { ...breakdownBody, force_migration: true } });

    expect(res.statusCode).toBe(200);
    expect(mocks.concurrencyRepo.replaceProviderBreakdown).toHaveBeenCalled();
  });

  it('skips the drain check when the account is already in provider mode', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue(breakdownAllocation);
    mocks.control.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 9 });
    const res = await app.inject({ method: 'PUT', url, payload: { ...breakdownBody, version: 2 } });

    expect(res.statusCode).toBe(200);
    expect(mocks.control.getDistributedAccountCount).not.toHaveBeenCalled();
  });

  it('503 and 409 drain refusals write master\'s failed-audit row and nothing else', async () => {
    mocks.control.getDistributedAccountCount.mockResolvedValueOnce({ status: 'unavailable' });
    const unavailable = await app.inject({ method: 'PUT', url, payload: breakdownBody });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      error: 'Concurrency State Unavailable',
      message: 'Cannot safely migrate while the distributed active-call count is unavailable',
      current_version: 1,
    });

    mocks.control.getDistributedAccountCount.mockResolvedValueOnce({ status: 'available', count: 3 });
    const active = await app.inject({ method: 'PUT', url, payload: breakdownBody });
    expect(active.statusCode).toBe(409);
    expect(active.json()).toEqual({
      error: 'Active Calls',
      message: 'Provider-mode migration requires the account to drain active calls or an explicit force_migration confirmation',
      active_calls: 3,
      current_version: 1,
    });

    expect(mocks.auditLog).toHaveBeenCalledTimes(2);
    expect(mocks.auditLog).toHaveBeenNthCalledWith(1, {
      admin_id: 'sa-1', admin_email: 'admin@test.com',
      action: 'update_account_concurrency_failed', resource_type: 'account', resource_id: 'a1',
      details: { tenant_id: 't1', status: 503, before: legacyAllocation },
    });
    expect(mocks.auditLog).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: 'update_account_concurrency_failed',
      details: { tenant_id: 't1', status: 409, before: legacyAllocation },
    }));
    expect(mocks.coreAuditLog).not.toHaveBeenCalled();
    expect(mocks.invalidateAccountSettings).not.toHaveBeenCalled();
  });

  it('a version conflict answers core\'s 409 with current_version and writes the failed-audit row', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue(breakdownAllocation);
    mocks.concurrencyRepo.replaceProviderBreakdown.mockRejectedValue(new ConcurrencyAllocationVersionConflictError(7));

    const res = await app.inject({ method: 'PUT', url, payload: { ...breakdownBody, version: 2 } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      message: 'Concurrency allocation version is stale; current version is 7',
      current_version: 7,
    });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: 'sa-1', admin_email: 'admin@test.com',
      action: 'update_account_concurrency_failed', resource_type: 'account', resource_id: 'a1',
      details: { tenant_id: 't1', status: 409, before: breakdownAllocation },
    });
    expect(mocks.coreAuditLog).not.toHaveBeenCalled();
    expect(mocks.control.invalidateAccountLimit).not.toHaveBeenCalled();
  });

  it('an unexpected throw in the in-process half answers 500 and writes master\'s failed-audit row (master did on every core non-2xx)', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue(breakdownAllocation);
    mocks.concurrencyRepo.replaceProviderBreakdown.mockRejectedValue(new Error('connection terminated'));

    const res = await app.inject({ method: 'PUT', url, payload: { ...breakdownBody, version: 2 } });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'Internal Server Error', message: 'Failed to update account concurrency' });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      admin_id: 'sa-1', admin_email: 'admin@test.com',
      action: 'update_account_concurrency_failed', resource_type: 'account', resource_id: 'a1',
      details: { tenant_id: 't1', status: 500, before: breakdownAllocation },
    });
    expect(mocks.coreAuditLog).not.toHaveBeenCalled();
  });

  it('writes core\'s concurrency.allocation.updated audit_logs row with the super admin\'s email as actor', async () => {
    const res = await app.inject({ method: 'PUT', url, payload: breakdownBody });

    expect(res.statusCode).toBe(200);
    expect(mocks.coreAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.coreAuditLog).toHaveBeenCalledWith({
      tenantId: 't1',
      accountId: 'a1',
      eventType: 'concurrency.allocation.updated',
      eventCategory: 'system',
      severity: 'info',
      actor: 'admin@test.com',
      eventData: {
        before: legacyAllocation,
        after: breakdownAllocation,
        change_reason: 'Purchased carrier capacity',
      },
    });
    // ...and master's own super-admin row after it.
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'update_account_concurrency',
      details: { tenant_id: 't1', before: legacyAllocation, after: breakdownAllocation },
    }));
  });

  it('the legacy flat body records master\'s fixed change_reason on core\'s row', async () => {
    const res = await app.inject({ method: 'PUT', url, payload: { max_concurrent_calls: 15 } });

    expect(res.statusCode).toBe(200);
    expect(mocks.coreAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      actor: 'admin@test.com',
      eventData: expect.objectContaining({ change_reason: 'Legacy total updated from Super Admin' }),
    }));
    expect(mocks.coreAuditLog.mock.calls[0]![0].eventData).not.toHaveProperty('force_migration');
  });

  it('refuses the legacy flat body once the account is in provider mode', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue(breakdownAllocation);
    const res = await app.inject({ method: 'PUT', url, payload: { max_concurrent_calls: 15 } });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toBe('Use the versioned provider allocation editor for this account');
    expect(mocks.concurrencyRepo.switchToLegacy).not.toHaveBeenCalled();
  });

  it('refuses an allocated provider with no account-accessible number before any read or write', async () => {
    mocks.phoneAssignmentRepo.findAvailableForAccount.mockResolvedValue([]);
    const res = await app.inject({ method: 'PUT', url, payload: breakdownBody });

    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe('No active account-accessible phone number for: vobiz');
    expect(mocks.phoneAssignmentRepo.findAvailableForAccount).toHaveBeenCalledWith('t1', 'a1');
    expect(mocks.concurrencyRepo.getAllocation).not.toHaveBeenCalled();
    expect(mocks.concurrencyRepo.replaceProviderBreakdown).not.toHaveBeenCalled();
  });

  it('GET reads utilization through the seam: per-provider live counts and the account total', async () => {
    mocks.concurrencyRepo.getAllocation.mockResolvedValue({
      tenant_id: 't1', account_id: 'a1', mode: 'provider_breakdown', version: 4,
      total_concurrency: 30,
      providers: [
        { provider: 'vobiz', max_concurrent_calls: 30 },
        { provider: 'voicelink', max_concurrent_calls: 0 },
      ],
    });
    mocks.control.getAccountProviderCounts.mockResolvedValue({
      status: 'available', counts: new Map([['vobiz', 32], ['voicelink', 2]]),
    });
    mocks.control.getAccountCount.mockResolvedValue(34);

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(mocks.control.getAccountProviderCounts).toHaveBeenCalledWith('t1', 'a1');
    expect(mocks.control.getAccountCount).toHaveBeenCalledWith('t1', 'a1');
    expect(res.json().utilization).toMatchObject({
      mode: 'provider_breakdown',
      version: 4,
      status: 'available',
      total: { allocated: 30, in_use: 34, available: 0 },
      providers: [
        {
          provider: 'vobiz', allocated: 30, in_use: 32, available: 0,
          over_limit: 2, saturated: true, draining: false,
        },
        {
          provider: 'voicelink', allocated: 0, in_use: 2, available: 0,
          over_limit: 2, saturated: true, draining: true,
        },
      ].sort((a, b) => a.provider.localeCompare(b.provider)),
    });
    expect(typeof res.json().utilization.observed_at).toBe('string');
  });

  it('GET answers utilization null (allocation intact) when the seam throws', async () => {
    resetConcurrencyControl(); // the unwired default throws on every call

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ allocation: legacyAllocation, utilization: null });
  });
});
