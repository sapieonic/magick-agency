/*
 * PORT NOTE (magick-agency): ported from master test/unit/api/middleware/tenant-context.middleware.test.ts@a1f0756a
 * (33 cases → 24). The 9 platform-API-key cases are deleted (decision #5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findByUserAndTenant: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelByPattern: vi.fn(),
  resolveTenantAccountNames: vi.fn(),
  getCachedAccountRecord: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findByUserAndTenant: mocks.findByUserAndTenant },
}));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  redisCache: { get: mocks.cacheGet, set: mocks.cacheSet, del: vi.fn(), delByPattern: mocks.cacheDelByPattern },
}));
// Name resolution is exercised by its own unit suite; stub it here so these
// tests stay focused on membership resolution/caching.
vi.mock('../../../../src/services/tenant-name-resolver.js', () => ({
  resolveTenantAccountNames: mocks.resolveTenantAccountNames,
  // Used by the X-Account-Id ownership check. Stubbed rather than faked: the
  // question this middleware asks is "does this record's tenant match the header",
  // and the record's provenance is the resolver suite's business.
  getCachedAccountRecord: mocks.getCachedAccountRecord,
}));

import {
  tenantContextMiddleware,
  invalidateTenantMembershipCache,
} from '../../../../src/api/middleware/tenant-context.middleware.js';

const activeMembership = (overrides = {}) => ({
  id: 'm-1', user_id: 'u-1', tenant_id: 't-1', account_id: null,
  role: 'operator', status: 'active', invited_by: null,
  created_at: new Date(), updated_at: new Date(),
  ...overrides,
});

function makeReply() {
  const reply: any = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  return reply;
}

function makeRequest(overrides: Record<string, unknown> = {}): any {
  return { headers: {}, ...overrides };
}

describe('tenantContextMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantAccountNames.mockResolvedValue({});
    // Default: the named account really is in the named tenant. The cases that
    // matter override this — a middleware whose default was "no account exists"
    // would make every pre-existing test pass for the wrong reason.
    mocks.getCachedAccountRecord.mockResolvedValue({ id: 'a-1', tenant_id: 't-1', name: 'Acct' });
  });

  describe('missing X-Tenant-Id header', () => {
    it('should return 400 when X-Tenant-Id is not provided', async () => {
      const reply = makeReply();
      await tenantContextMiddleware(makeRequest(), reply);
      expect(reply.code).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ error: 'Bad Request' }));
    });
  });

  // PORT NOTE (magick-agency): master's 'API key authentication path' block (6
  // cases) is deleted with the platform-API-key branch (decision #5).

  describe('Firebase user authentication path', () => {
    it('should return 401 when there is no user on request', async () => {
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' } });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(401);
    });

    it('should return 403 when user has no memberships in tenant', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([]);
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('member') }));
    });

    it('should attach tenantId and membership when membership found', async () => {
      const m = activeMembership();
      mocks.findByUserAndTenant.mockResolvedValue([m]);
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());
      expect(req.tenantId).toBe('t-1');
      expect(req.membership).toEqual(m);
    });

    it('should return 403 when matched membership is not active', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership({ status: 'revoked' })]);
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);
      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('should resolve and attach tenant/account names to the request', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);
      mocks.resolveTenantAccountNames.mockResolvedValue({ tenantName: 'Acme', accountName: 'West' });
      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-1' },
        user: { id: 'u-1' },
      });
      await tenantContextMiddleware(req, makeReply());
      expect(mocks.resolveTenantAccountNames).toHaveBeenCalledWith('t-1', 'a-1');
      expect(req.tenantName).toBe('Acme');
      expect(req.accountName).toBe('West');
    });
  });

  describe('membership selection with accountId', () => {
    it('should prefer account-level membership over tenant-level when X-Account-Id provided', async () => {
      const tenantMembership = activeMembership({ id: 'm-tenant', account_id: null });
      const accountMembership = activeMembership({ id: 'm-account', account_id: 'a-1' });
      mocks.findByUserAndTenant.mockResolvedValue([tenantMembership, accountMembership]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(req.membership?.id).toBe('m-account');
      expect(req.accountId).toBe('a-1');
    });

    it('should fall back to tenant-level membership (account_id=null) when no account membership found', async () => {
      const tenantMembership = activeMembership({ id: 'm-tenant', account_id: null });
      mocks.findByUserAndTenant.mockResolvedValue([tenantMembership]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-other' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(req.membership?.id).toBe('m-tenant');
    });
  });

  describe('membership selection without accountId', () => {
    it('should use tenant-level membership (account_id=null) when no X-Account-Id', async () => {
      const tenantMembership = activeMembership({ id: 'm-tenant', account_id: null });
      const accountMembership = activeMembership({ id: 'm-account', account_id: 'a-1' });
      mocks.findByUserAndTenant.mockResolvedValue([accountMembership, tenantMembership]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(req.membership?.id).toBe('m-tenant');
    });

    it('should fall back to first membership when no tenant-level membership exists', async () => {
      const accountMembership = activeMembership({ id: 'm-account', account_id: 'a-1' });
      mocks.findByUserAndTenant.mockResolvedValue([accountMembership]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(req.membership?.id).toBe('m-account');
    });

    /**
     * Two account-scoped memberships and no tenant-wide one, no X-Account-Id.
     * This used to be `memberships[0]` over an unordered query, so the account
     * — and every account-scoped filter downstream — was whatever heap order
     * returned, and could flip across a membership-cache refresh (an ingest job
     * created under A would 404 for its own creator once they resolved to B).
     */
    it('picks the OLDEST account-scoped membership regardless of the order rows arrive in', async () => {
      const older = activeMembership({ id: 'm-older', account_id: 'a-1', created_at: new Date('2026-01-01T00:00:00Z') });
      const newer = activeMembership({ id: 'm-newer', account_id: 'a-2', created_at: new Date('2026-06-01T00:00:00Z') });

      for (const rows of [[older, newer], [newer, older]]) {
        mocks.findByUserAndTenant.mockResolvedValueOnce(rows);
        const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
        await tenantContextMiddleware(req, makeReply());
        expect(req.membership?.id).toBe('m-older');
      }
    });

    it('applies the same order to a CACHED array, which comes back with string dates in any order', async () => {
      // Arrays cached before the repository gained its ORDER BY are unordered,
      // and anything cached went through JSON, so `created_at` is a string.
      mocks.cacheGet.mockResolvedValueOnce([
        { ...activeMembership({ id: 'm-newer', account_id: 'a-2' }), created_at: '2026-06-01T00:00:00.000Z' },
        { ...activeMembership({ id: 'm-older', account_id: 'a-1' }), created_at: '2026-01-01T00:00:00.000Z' },
      ]);
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());
      expect(req.membership?.id).toBe('m-older');
      expect(mocks.findByUserAndTenant).not.toHaveBeenCalled();
    });

    it('breaks a created_at tie on id, so equal timestamps are still deterministic', async () => {
      const at = new Date('2026-01-01T00:00:00Z');
      const b = activeMembership({ id: 'm-b', account_id: 'a-2', created_at: at });
      const a = activeMembership({ id: 'm-a', account_id: 'a-1', created_at: at });
      mocks.findByUserAndTenant.mockResolvedValueOnce([b, a]);
      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());
      expect(req.membership?.id).toBe('m-a');
    });

    // PORT NOTE (magick-agency): master's 'uses the same selection on the
    // platform-API-key branch' is deleted (decision #5).
  });

  /**
   * ─── `X-Account-Id` MUST BELONG TO `X-Tenant-Id` ──────────────────────────
   *
   * The header was assigned to `request.accountId` verbatim, and the only check
   * near it was the tenant-wide membership fallback above — which succeeds for
   * any tenant-wide member of the tenant they named. So a legitimate tenant-wide
   * member of A could send `X-Tenant-Id: A` with `X-Account-Id: <an account of
   * B>` and every downstream consumer took the foreign id as fact: the agency
   * ingest job stamped it onto core's roster rows, `proxyToCore` forwarded B's
   * resolved display name to core, and PostHog filed A's events under B's group.
   *
   * The invite fix closed the door that needed a cross-tenant membership row.
   * This is the door that needed none.
   */
  describe('X-Account-Id tenant ownership', () => {
    const foreignAccount = { id: 'a-foreign', tenant_id: 't-2', name: "Someone else's" };

    it('refuses an account belonging to another tenant', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);
      mocks.getCachedAccountRecord.mockResolvedValue(foreignAccount);

      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-foreign' },
        user: { id: 'u-1' },
      });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
      // Nothing downstream may see the foreign id — the whole exposure was that
      // writers stored it and the resolver leaked its name.
      expect(req.accountId).toBeUndefined();
      expect(req.tenantId).toBeUndefined();
    });

    it('is not satisfied by a tenant-wide membership, which is how it went unnoticed', async () => {
      // A tenant-wide membership row has `account_id: null`, so there is nothing
      // for the membership check to compare an account against. It answers "may
      // this user act in this tenant" and cannot answer "is this account in it".
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership({ account_id: null })]);
      mocks.getCachedAccountRecord.mockResolvedValue(foreignAccount);

      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-foreign' },
        user: { id: 'u-1' },
      });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('refuses an unknown or deleted account rather than passing the id through', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);
      mocks.getCachedAccountRecord.mockResolvedValue(null);

      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-gone' },
        user: { id: 'u-1' },
      });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('refuses a malformed id instead of 500ing on Postgres 22P02', async () => {
      // The header is client-supplied and the column is UUID, so a junk value
      // raises `invalid_text_representation`. That must not become a 500 — and it
      // must certainly not skip the check on its way there.
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);
      const err = Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
      mocks.getCachedAccountRecord.mockRejectedValue(err);

      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'not-a-uuid' },
        user: { id: 'u-1' },
      });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('propagates a genuine database fault rather than calling it Forbidden', async () => {
      // A connection error is ours, not the caller's. Reporting it as 403 would
      // turn an outage into an authorization mystery.
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);
      mocks.getCachedAccountRecord.mockRejectedValue(new Error('Connection terminated'));

      const req = makeRequest({
        headers: { 'x-tenant-id': 't-1', 'x-account-id': 'a-1' },
        user: { id: 'u-1' },
      });
      await expect(tenantContextMiddleware(req, makeReply())).rejects.toThrow('Connection terminated');
    });

    // PORT NOTE (magick-agency): master's 'applies on the platform-API-key path
    // too' is deleted (decision #5).

    it('costs nothing when no account is named', async () => {
      // The overwhelmingly common request shape; it must not add a lookup.
      mocks.findByUserAndTenant.mockResolvedValue([activeMembership()]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(mocks.getCachedAccountRecord).not.toHaveBeenCalled();
      expect(req.tenantId).toBe('t-1');
    });
  });

  describe('membership cache', () => {
    it('should return cached memberships without hitting DB or writing back to cache', async () => {
      const m = activeMembership();
      mocks.cacheGet.mockResolvedValue([m]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(req.membership).toEqual(m);
      expect(mocks.findByUserAndTenant).not.toHaveBeenCalled();
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('should write memberships to cache after DB lookup', async () => {
      const m = activeMembership();
      mocks.cacheGet.mockResolvedValue(null);
      mocks.findByUserAndTenant.mockResolvedValue([m]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(mocks.cacheSet).toHaveBeenCalledWith(
        'cache:membership:u-1:t-1',
        [m],
        30 * 60,
      );
    });

    it('should not cache empty membership lists', async () => {
      mocks.cacheGet.mockResolvedValue(null);
      mocks.findByUserAndTenant.mockResolvedValue([]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      const reply = makeReply();
      await tenantContextMiddleware(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('should fall through to DB when cache returns null', async () => {
      mocks.cacheGet.mockResolvedValue(null);
      const m = activeMembership();
      mocks.findByUserAndTenant.mockResolvedValue([m]);

      const req = makeRequest({ headers: { 'x-tenant-id': 't-1' }, user: { id: 'u-1' } });
      await tenantContextMiddleware(req, makeReply());

      expect(mocks.findByUserAndTenant).toHaveBeenCalledWith('u-1', 't-1');
      expect(req.membership).toEqual(m);
    });

    // PORT NOTE (magick-agency): master's 'should skip cache for API key auth
    // path' is deleted (decision #5).
  });
});

describe('invalidateTenantMembershipCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('busts every member of the tenant via a tenant-suffixed pattern', async () => {
    // Key layout is cache:membership:{userId}:{tenantId}, so the tenant is the suffix.
    await invalidateTenantMembershipCache('t-1');
    expect(mocks.cacheDelByPattern).toHaveBeenCalledWith('cache:membership:*:t-1');
  });
});
