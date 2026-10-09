import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `/notifications/preferences` — a person's own subscriptions.
 *
 * Two properties are worth pinning, and neither had a test.
 *
 * 1. **The catalog is filtered to what the caller can RECEIVE.** It was not: the
 *    handler mapped `NOTIFICATION_EVENTS` unconditionally, so a `viewer` — well
 *    below `usage.digest`'s `account_admin` floor — was shown a live "Usage
 *    digest · On · Default" toggle with a frequency picker for mail that could
 *    never reach them. The route's own docstring asserted the opposite, which is
 *    how it survived review: a comment describing an intention nobody implemented.
 * 2. **The caller can only ever address themselves.** There is no `user_id`
 *    parameter and the subject is `request.user.id`, taken server-side. That is
 *    the whole security argument for having no `requirePermission` here, and it
 *    was asserted nowhere.
 *
 * The catalog holds only `agency.campaign.completed` (floor `agency.supervise` =
 * `account_admin`), so the floor cases assert on that event. `usage.digest` and
 * `campaign.completed` are unknown keys (a 400). There are no broadcast events, no
 * `POST /digests/preview` route and no platform API keys (decision #5). The `agent`
 * cases at the end show there is no permission floor on these routes.
 */

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  tenantContext: vi.fn(),
  findForUser: vi.fn(),
  upsertMany: vi.fn(),
  findByUserAndTenant: vi.fn(),
  findTenantById: vi.fn(),
  findAccountByIdInTenant: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/config/index.js', () => ({
  config: { brand: { name: 'Magick Agency', accent: '#7c5cfc' }, consoleBaseUrl: 'https://app.test' },
}));
vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: mocks.session }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: mocks.tenantContext,
}));
vi.mock('../../../../src/db/repositories/notification-preference.repository.js', () => ({
  notificationPreferenceRepository: { findForUser: mocks.findForUser, upsertMany: mocks.upsertMany },
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findByUserAndTenant: mocks.findByUserAndTenant },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

import Fastify from 'fastify';
import { notificationRoutes } from '../../../../src/api/routes/notification.routes.js';

const USER = 'user-1';
const TENANT = '11111111-1111-4111-8111-111111111111';

function membership(role: string, accountId: string | null = null) {
  return { user_id: USER, tenant_id: TENANT, role, account_id: accountId, status: 'active' };
}

describe('/notifications/preferences', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.findForUser.mockResolvedValue([]);
    mocks.upsertMany.mockResolvedValue(undefined);
    mocks.session.mockImplementation(async (req: Record<string, unknown>) => {
      req.user = { id: USER };
    });
    mocks.tenantContext.mockImplementation(async (req: Record<string, unknown>) => {
      req.tenantId = TENANT;
    });

    app = Fastify();
    await app.register(notificationRoutes, { prefix: '/notifications' });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function get() {
    const res = await app.inject({ method: 'GET', url: '/notifications/preferences' });
    return { status: res.statusCode, keys: (res.json().events ?? []).map((e: { key: string }) => e.key) };
  }

  describe('the catalog is filtered to what the caller can receive', () => {
    it('offers an account_admin the usage digest', async () => {
      // Asserts the agency notice, the event at the `account_admin` floor.
      mocks.findByUserAndTenant.mockResolvedValue([membership('account_admin')]);
      const { status, keys } = await get();
      expect(status).toBe(200);
      expect(keys).toContain('agency.campaign.completed');
    });

    it('offers a tenant_owner everything', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('tenant_owner')]);
      const { keys } = await get();
      // The catalog has one event.
      expect(keys).toEqual(expect.arrayContaining([
        'agency.campaign.completed',
      ]));
    });

    /** The defect: a toggle that changes nothing is a promise the product does not keep. */
    it('does NOT offer a viewer the usage digest', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('viewer')]);
      const { keys } = await get();
      expect(keys).not.toContain('usage.digest');
      expect(keys).not.toContain('agency.campaign.completed');
    });

    it('does NOT offer an operator the usage digest', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('operator')]);
      const { keys } = await get();
      expect(keys).not.toContain('usage.digest');
      // `usage.digest` is absent for every role here, so the floor is asserted on
      // the agency notice too.
      expect(keys).not.toContain('agency.campaign.completed');
    });

    it('takes the WIDEST of several memberships', async () => {
      // A person can hold a tenant-level row and an account-scoped one. Hiding
      // an event they can receive through either is as wrong as showing one they
      // cannot receive at all.
      mocks.findByUserAndTenant.mockResolvedValue([
        membership('viewer', 'acct-1'),
        membership('account_admin'),
      ]);
      const { keys } = await get();
      expect(keys).toContain('agency.campaign.completed');
    });
  });

  describe('the caller can only address themselves', () => {
    it('takes the subject from the session, never from the query', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('account_admin')]);
      await app.inject({ method: 'GET', url: '/notifications/preferences?user_id=somebody-else' });
      expect(mocks.findForUser).toHaveBeenCalledWith(USER, TENANT);
    });

    it('writes against the session user, never a body-supplied one', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('account_admin')]);
      const res = await app.inject({
        method: 'PUT', url: '/notifications/preferences',
        payload: { user_id: 'somebody-else', preferences: [{ event_key: 'agency.campaign.completed', enabled: false }] },
      });
      expect(res.statusCode).toBeLessThan(500);
      expect(mocks.upsertMany).toHaveBeenCalled();
      const [rows] = mocks.upsertMany.mock.calls[0] as [Array<Record<string, unknown>>];
      // Every row is stamped with the SESSION user and tenant. The body's
      // `user_id` is not a parameter of this route and must not become one.
      for (const row of rows) {
        expect(row.user_id).toBe(USER);
        expect(row.tenant_id).toBe(TENANT);
      }
    });

    it('400s with no user or tenant on the request', async () => {
      mocks.session.mockImplementation(async () => {});
      mocks.tenantContext.mockImplementation(async () => {});
      const res = await app.inject({ method: 'GET', url: '/notifications/preferences' });
      expect(res.statusCode).toBe(400);
    });
  });

  /**
   * ── PUT answers with the SAME filtered list GET serves ──────────────────
   *
   * The GET filter only held until somebody pressed Save. This handler resolved
   * against the whole catalog, so the save response carried `usage.digest`
   * (default on, weekly) to a role that cannot receive it — and a page following
   * the ordinary "save, then replace local state from the response" pattern grew
   * the toggle-that-does-nothing straight back on the first click.
   */
  describe('the PUT response is filtered too', () => {
    async function put(preferences: Array<Record<string, unknown>>) {
      const res = await app.inject({
        method: 'PUT', url: '/notifications/preferences', payload: { preferences },
      });
      return {
        status: res.statusCode,
        keys: (res.json().preferences ?? []).map((p: { event_key: string }) => p.event_key),
      };
    }

    it('does NOT echo the usage digest back to a viewer', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('viewer')]);
      const { status, keys } = await put([
        { event_key: 'agency.campaign.completed', channel: 'email', enabled: false },
      ]);
      expect(status).toBe(200);
      expect(keys).not.toContain('usage.digest');
      expect(keys).not.toContain('agency.campaign.completed');
    });

    it('echoes the same keys GET would serve, for the same caller', async () => {
      // The strongest form of the assertion: not a hand-written list, but the
      // two handlers agreeing. A filter added to one and not the other fails here.
      for (const role of ['agent', 'viewer', 'operator', 'account_admin', 'tenant_owner']) {
        mocks.findByUserAndTenant.mockResolvedValue([membership(role)]);
        const { keys: getKeys } = await get();
        const { keys: putKeys } = await put([
        { event_key: 'agency.campaign.completed', channel: 'email', enabled: false },
        ]);
        expect(putKeys).toEqual(getKeys);
      }
    });

    it('still ACCEPTS a stored key the caller can no longer receive', async () => {
      // A demotion must not 400 a stale row or delete it — the preference stays
      // stored and inert, and comes back when the role does. Only the response
      // is filtered; validation is unchanged.
      //
      // The key a viewer cannot receive is the agency notice, which is immediate
      // and so takes no frequency.
      mocks.findByUserAndTenant.mockResolvedValue([membership('viewer')]);
      const { status } = await put([
        { event_key: 'agency.campaign.completed', channel: 'email', enabled: false },
      ]);
      expect(status).toBe(200);
      expect(mocks.upsertMany).toHaveBeenCalled();
      const [rows] = mocks.upsertMany.mock.calls[0] as [Array<Record<string, unknown>>];
      expect(rows.map((r) => r.event_key)).toContain('agency.campaign.completed');
    });
  });

  /**
   * An `agent` reaches its own preferences.
   *
   * These routes carry no `requirePermission`, so the lowest role — `agent`,
   * level 5, below `viewer` — is served like any other. With agency's one-event
   * catalog it can receive nothing (`agency.supervise` floors at `account_admin`),
   * so GET is an empty list, not a 403, and a PUT is accepted and stored.
   */
  describe('an agent', () => {
    it('GETs its own preferences: 200, an empty list', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('agent')]);
      const res = await app.inject({ method: 'GET', url: '/notifications/preferences' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
      expect(mocks.findForUser).toHaveBeenCalledWith(USER, TENANT);
    });

    it('PUTs its own preferences: 200, stored against the session user', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('agent')]);
      const res = await app.inject({
        method: 'PUT', url: '/notifications/preferences',
        payload: { preferences: [{ event_key: 'agency.campaign.completed', enabled: false }] },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ preferences: [] });
      expect(mocks.upsertMany).toHaveBeenCalledWith([
        {
          user_id: USER, tenant_id: TENANT, event_key: 'agency.campaign.completed',
          channel: 'email', enabled: false, frequency: null,
        },
      ]);
    });
  });

  describe('deleted routes', () => {
    it('POST /digests/preview is not registered (there is no credits usage digest)', async () => {
      mocks.findByUserAndTenant.mockResolvedValue([membership('tenant_owner')]);
      const res = await app.inject({
        method: 'POST', url: '/notifications/digests/preview', payload: { frequency: 'weekly' },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
