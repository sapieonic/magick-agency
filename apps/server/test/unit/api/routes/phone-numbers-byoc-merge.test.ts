import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * `GET /phone-numbers` returns the platform phone-number assignments. BYOC (the tenant's
 * own carrier numbers) is out of scope, so the route has no BYOC half and no row carries
 * `is_byoc` (the contracts' `TenantPhoneAssignment` has no such field). The two
 * account-scope cases pin the assignment query, and the permission is
 * `agency.phone_numbers.read`.
 */

const mocks = vi.hoisted(() => ({
  findAvailableForAccount: vi.fn(),
  findByTenantId: vi.fn(),
  findTagsForAssignment: vi.fn(),
  requirePermission: vi.fn(),
  accountId: 'acct-a' as string | undefined,
  membershipAccountId: null as string | null | undefined,
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (_req: FastifyRequest, _reply: FastifyReply) => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (req: any) => {
    req.tenantId = 'tenant-a';
    req.accountId = mocks.accountId;
    req.membership = { role: 'tenant_admin', account_id: mocks.membershipAccountId };
  },
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: (permission: string) => {
    mocks.requirePermission(permission);
    return async (_req: FastifyRequest, _reply: FastifyReply) => {};
  },
}));
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({
  tenantPhoneAssignmentRepository: {
    findAvailableForAccount: mocks.findAvailableForAccount,
    findByTenantId: mocks.findByTenantId,
    findTagsForAssignment: mocks.findTagsForAssignment,
    findById: vi.fn(),
    tagToAccount: vi.fn(),
    untagFromAccount: vi.fn(),
    setAccountDefault: vi.fn(),
  },
}));

import Fastify from 'fastify';
import { phoneNumberRoutes } from '../../../../src/api/routes/phone-number.routes.js';

const platformRow = {
  assignment_id: 'assign-1',
  phone_number: '+918046733449',
  label: 'Platform stock',
  provider_name: 'vobiz',
  provider_display_name: 'Vaani',
  capabilities: ['VOICE'],
  region: 'IN',
  max_concurrent_calls: 10,
  is_default: true,
};

describe('GET /phone-numbers — BYOC merge', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.accountId = 'acct-a';
    mocks.membershipAccountId = null;
    mocks.findTagsForAssignment.mockResolvedValue([]);
    mocks.findAvailableForAccount.mockResolvedValue([platformRow]);
    mocks.findByTenantId.mockResolvedValue([platformRow]);

    app = Fastify();
    await app.register(phoneNumberRoutes, { prefix: '/phone-numbers' });
    await app.ready();
  });

  it('carries no is_byoc on a platform row (BYOC is out of scope; the contract removed the field)', async () => {
    const res = await app.inject({ method: 'GET', url: '/phone-numbers' });

    expect(res.statusCode).toBe(200);
    const numbers = res.json().phone_numbers;
    expect(numbers).toHaveLength(1);
    expect(numbers[0]).not.toHaveProperty('is_byoc');
    expect(numbers[0]).toEqual({ ...platformRow, account_tags: [] });
    expect(mocks.requirePermission).toHaveBeenCalledWith('agency.phone_numbers.read');
  });

  it('passes no account id for a tenant-level member, and uses the tenant-wide assignment query', async () => {
    mocks.accountId = undefined;

    await app.inject({ method: 'GET', url: '/phone-numbers' });

    expect(mocks.findByTenantId).toHaveBeenCalledWith('tenant-a');
    expect(mocks.findAvailableForAccount).not.toHaveBeenCalled();
  });

  it('an account-scoped caller who OMITS X-Account-Id still gets the ACCOUNT-scoped query, not the tenant-wide one', async () => {
    // Reviewer-caught bug: `X-Account-Id` is optional, and `tenantContextMiddleware`
    // legally falls through to the caller's own membership when it is omitted —
    // so `request.accountId` (the header) stayed `undefined` while
    // `request.membership.account_id` correctly held the caller's real scope.
    // The route branched on the header alone, so this fell all the way through
    // to `findByTenantId` (every account's assignments) plus `findTagsForAssignment`
    // (which joins `accounts.name`) for every one of them.
    mocks.accountId = undefined;
    mocks.membershipAccountId = 'acct-a';

    await app.inject({ method: 'GET', url: '/phone-numbers' });

    expect(mocks.findAvailableForAccount).toHaveBeenCalledWith('tenant-a', 'acct-a');
    expect(mocks.findByTenantId).not.toHaveBeenCalled();
  });

  it('an account-scoped caller naming their own account via the header is unaffected', async () => {
    mocks.accountId = 'acct-a';
    mocks.membershipAccountId = 'acct-a';

    await app.inject({ method: 'GET', url: '/phone-numbers' });

    expect(mocks.findAvailableForAccount).toHaveBeenCalledWith('tenant-a', 'acct-a');
    expect(mocks.findByTenantId).not.toHaveBeenCalled();
  });

  describe('account_tags is narrowed to the effective account (sibling tag-metadata leak)', () => {
    /**
     * `findTagsForAssignment` answers for the ASSIGNMENT, not for one account —
     * a shared/untagged number can be tagged to several accounts at once.
     * `findAvailableForAccount` correctly limits which PHONE ROWS an
     * account-scoped caller sees, but the tag list riding along on each row
     * was never narrowed the same way: a caller whose own account legitimately
     * has access to a number still received every sibling account's
     * `account_id`/`account_name` for that same row.
     */
    const tagsForBothAccounts = [
      { id: 'tag-own', assignment_id: 'assign-1', account_id: 'acct-a', account_name: 'Own Account' },
      { id: 'tag-sibling', assignment_id: 'assign-1', account_id: 'acct-b', account_name: 'Sibling Account' },
    ];

    it('an account-scoped caller sees only their OWN account’s tag', async () => {
      mocks.membershipAccountId = 'acct-a';
      mocks.findTagsForAssignment.mockResolvedValue(tagsForBothAccounts);

      const res = await app.inject({ method: 'GET', url: '/phone-numbers' });
      const numbers = res.json().phone_numbers;

      expect(numbers).toHaveLength(1);
      expect(numbers[0].account_tags).toEqual([tagsForBothAccounts[0]]);
    });

    it('a TENANT-WIDE caller still sees every tag, unfiltered', async () => {
      mocks.accountId = undefined;
      mocks.membershipAccountId = null;
      mocks.findTagsForAssignment.mockResolvedValue(tagsForBothAccounts);

      const res = await app.inject({ method: 'GET', url: '/phone-numbers' });
      const numbers = res.json().phone_numbers;

      expect(numbers).toHaveLength(1);
      expect(numbers[0].account_tags).toEqual(tagsForBothAccounts);
    });
  });
});
