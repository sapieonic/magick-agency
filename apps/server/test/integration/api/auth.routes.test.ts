/*
 * Auth routes on real Postgres (5436, the test DB) through `initDbPool`: the
 * repositories import `@magick-agency/db`'s `connection.ts` directly, so the pool
 * must be the real singleton. Firebase `verifyIdToken` stays mocked.
 *
 *  - Session path 4 (a new user with no membership) is a REFUSAL: 403
 *    `no_membership`, and nothing is written to `users`, `tenants`, `accounts` or
 *    `memberships` (there is no signup provisioning: no credits, API key or phone).
 *  - GET /me returns `settings`, the real per-account map from `account_settings`;
 *    the fail-open case makes the real map builder throw through a spy.
 *  - There is no signup-pool number assignment, so no phone-assignment cases.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import {
  insertTenant,
  insertAccount,
  insertUser,
  insertMembership,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  sessionMiddleware: vi.fn(),
  buildSettingsMap: vi.fn(),
}));

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../../src/auth/firebase.js', () => ({
  verifyIdToken: mocks.verifyIdToken,
}));

// Partial mock: `packages/db`'s pool imports `logger`
// from the same package, so only `createChildLogger` is replaced.
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: mocks.sessionMiddleware,
  invalidateUserCache: vi.fn(),
}));

// A spy that runs the REAL settings-map builder unless a test makes it throw.
vi.mock('../../../src/settings/agency-account-settings.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/settings/agency-account-settings.js')>();
  mocks.buildSettingsMap.mockImplementation(real.buildAgencyAccountSettingsMap);
  return { ...real, buildAgencyAccountSettingsMap: mocks.buildSettingsMap };
});

vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    delByPattern: vi.fn().mockResolvedValue(undefined),
  },
}));

// ── Import the route under test (after mocks are registered) ───────────────

const { authRoutes } = await import('../../../src/api/routes/auth.routes.js');
const { userRepository } = await import('@magick-agency/db/repositories/user.repository');

// ── Test suite ─────────────────────────────────────────────────────────────

const { buildAgencyAccountSettingsMap: realBuildSettingsMap } = await vi.importActual<
  typeof import('../../../src/settings/agency-account-settings.js')
>('../../../src/settings/agency-account-settings.js');

/** Row counts of the four identity tables — path 4 must leave all of them alone. */
async function identityRowCounts() {
  const { rows } = await getTestPool().query(
    `SELECT (SELECT count(*)::int FROM users) AS users,
            (SELECT count(*)::int FROM tenants) AS tenants,
            (SELECT count(*)::int FROM accounts) AS accounts,
            (SELECT count(*)::int FROM memberships) AS memberships`,
  );
  return rows[0] as { users: number; tenants: number; accounts: number; memberships: number };
}

describe('auth routes (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    // The settings spy is reset to the real builder.
    mocks.buildSettingsMap.mockImplementation(realBuildSettingsMap);
  });

  // ────────────────────────────────────────────────────────────────────────
  // POST /session
  // ────────────────────────────────────────────────────────────────────────

  describe('POST /session', () => {
    // Path 4 REFUSES a user with no membership and writes nothing (no
    // auto-provisioning, no signup bonus, no signup-pool phone assignment).
    it('refuses a new user (403 no_membership) and writes no user, tenant, account or membership', async () => {
      const firebaseUid = 'fb-new-user-001';
      const email = 'newuser@example.com';

      mocks.verifyIdToken.mockResolvedValue({
        uid: firebaseUid,
        email,
        name: 'New User',
        picture: 'https://example.com/avatar.jpg',
        email_verified: true,
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'valid-firebase-token' },
      });

      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body).toEqual({
        error: 'Forbidden',
        code: 'no_membership',
        message: expect.any(String),
      });
      expect(body.message.length).toBeGreaterThan(20);

      expect(await identityRowCounts()).toEqual({ users: 0, tenants: 0, accounts: 0, memberships: 0 });
      expect(await userRepository.findByFirebaseUid(firebaseUid)).toBeNull();

      await app.close();
    });

    it('returns existing user session (200) when user found by firebase_uid', async () => {
      const tenant = await insertTenant();
      const user = await insertUser({
        firebase_uid: 'fb-existing-001',
        email: 'existing@example.com',
        phone_number: '+15551234567',
      });
      await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        role: 'tenant_owner',
      });

      mocks.verifyIdToken.mockResolvedValue({
        uid: 'fb-existing-001',
        email: 'existing@example.com',
        name: 'Existing User',
        picture: null,
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'valid-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.is_new).toBe(false);
      expect(body.user.id).toBe(user.id);
      expect(body.user.firebase_uid).toBe('fb-existing-001');
      expect(body.tenants).toHaveLength(1);
      expect(body.tenants[0].id).toBe(tenant.id);
      expect(body.memberships).toHaveLength(1);

      // There is no API key to provision. Nothing new was written.
      expect(await identityRowCounts()).toMatchObject({ users: 1, tenants: 1, memberships: 1 });

      await app.close();
    });

    describe('path 1 repairs a row flagged by an unverified invite claim', () => {
      /**
       * `users.email_unverified` flags a row whose identity was bound without proving its
       * address, and every by-address reuse path then refuses it. The repair was
       * documented as happening on path 2 — which the flagged population never
       * reaches, because the claim wrote their own `firebase_uid` onto the row,
       * so they resolve HERE forever. Left unrepaired the flag is permanent, and
       * since `firebase_uid` is UNIQUE a second workspace's invite writes a
       * duplicate stub that can never be bound: `identity_in_use` for an
       * `agent`, and no activation route at all for every other role.
       */
      async function insertFlaggedUser(email: string) {
        const user = await insertUser({
          firebase_uid: 'fb-flagged-001',
          email,
          phone_number: '+15551230000',
        });
        await getTestPool().query(
          'UPDATE users SET email_unverified = true WHERE id = $1',
          [user.id],
        );
        return user;
      }

      async function postSession(decoded: Record<string, unknown>) {
        mocks.verifyIdToken.mockResolvedValue(decoded);
        const app = Fastify();
        await app.register(authRoutes, { prefix: '/auth' });
        await app.ready();
        const res = await app.inject({
          method: 'POST',
          url: '/auth/session',
          payload: { id_token: 'valid-token' },
        });
        await app.close();
        return res;
      }

      async function flagOf(userId: string) {
        const { rows } = await getTestPool().query(
          'SELECT email_unverified FROM users WHERE id = $1',
          [userId],
        );
        return rows[0]?.email_unverified;
      }

      it('CLEARS the flag when the bound identity presents a verified token for the address', async () => {
        const tenant = await insertTenant();
        const user = await insertFlaggedUser('agent@work.test');
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        const res = await postSession({
          uid: 'fb-flagged-001',
          email: 'agent@work.test',
          email_verified: true,
          name: null,
          picture: null,
        });

        expect(res.statusCode).toBe(200);
        expect(await flagOf(user.id)).toBe(false);
        // Which is the whole point: the address is reusable again, so a second
        // workspace inviting them resolves to THIS row instead of writing a
        // duplicate stub nothing can ever bind.
        expect((await userRepository.findByProvenEmail('agent@work.test'))?.id).toBe(user.id);
      });

      it('does NOT clear it for an UNVERIFIED token — path 1 is the arm that signs those in', async () => {
        const tenant = await insertTenant();
        const user = await insertFlaggedUser('agent@work.test');
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        const res = await postSession({
          uid: 'fb-flagged-001',
          email: 'agent@work.test',
          email_verified: false,
          name: null,
          picture: null,
        });

        // Still signed in — the flag bars REUSE, it is not a punishment.
        expect(res.statusCode).toBe(200);
        expect(await flagOf(user.id)).toBe(true);
        expect(await userRepository.findByProvenEmail('agent@work.test')).toBeNull();
      });

      it('does NOT clear it when the verified address is not the one on the row', async () => {
        const tenant = await insertTenant();
        const user = await insertFlaggedUser('agent@work.test');
        await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'agent' });

        const res = await postSession({
          uid: 'fb-flagged-001',
          email: 'someone-else@personal.test',
          email_verified: true,
          name: null,
          picture: null,
        });

        expect(res.statusCode).toBe(200);
        // Proving a DIFFERENT inbox says nothing about the address this row is
        // keyed under, which is the only question the flag asks.
        expect(await flagOf(user.id)).toBe(true);
      });
    });

    it('activates a pending stub user (200) when email matches a pending_ UID', async () => {
      const tenant = await insertTenant();
      const stubUser = await insertUser({
        firebase_uid: 'pending_abc123',
        email: 'stub@example.com',
        display_name: null,
        phone_number: '0000000000',
      });
      await insertMembership({
        user_id: stubUser.id,
        tenant_id: tenant.id,
        role: 'operator',
      });

      const newFirebaseUid = 'fb-real-uid-999';
      mocks.verifyIdToken.mockResolvedValue({
        uid: newFirebaseUid,
        email: 'stub@example.com',
        name: 'Activated User',
        picture: 'https://example.com/pic.jpg',
        email_verified: true,
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'valid-token', phone_number: '+15559876543' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.is_new).toBe(false);
      expect(body.user.firebase_uid).toBe(newFirebaseUid);
      expect(body.user.email).toBe('stub@example.com');
      // display_name should be filled in via COALESCE
      expect(body.user.display_name).toBe('Activated User');
      // phone_number should be updated from placeholder
      expect(body.user.phone_number).toBe('+15559876543');
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0].role).toBe('operator');

      // There is no API key to provision. The stub was activated in place.
      expect(await identityRowCounts()).toMatchObject({ users: 1, memberships: 1 });

      await app.close();
    });

    it('refuses an unverified token (403) rather than activating a pending stub', async () => {
      const tenant = await insertTenant();
      const stubUser = await insertUser({
        firebase_uid: 'pending_unverified_takeover',
        email: 'unverified-stub@example.com',
        display_name: null,
        phone_number: '0000000000',
      });
      await insertMembership({
        user_id: stubUser.id,
        tenant_id: tenant.id,
        role: 'tenant_owner',
      });

      mocks.verifyIdToken.mockResolvedValue({
        uid: 'fb-attacker-unverified',
        email: 'unverified-stub@example.com',
        name: 'Attacker',
        email_verified: false,
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'unverified-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('email_unverified');

      const pool = getTestPool();
      const row = await pool.query('SELECT firebase_uid FROM users WHERE id = $1', [stubUser.id]);
      expect(row.rows[0].firebase_uid).toBe('pending_unverified_takeover');

      await app.close();
    });

    it('adopts new firebase UID (200) when email matches existing user with different UID', async () => {
      const tenant = await insertTenant();
      const existingUser = await insertUser({
        firebase_uid: 'fb-old-uid-111',
        email: 'reregister@example.com',
        display_name: 'Original Name',
        phone_number: '+15551112222',
      });
      await insertMembership({
        user_id: existingUser.id,
        tenant_id: tenant.id,
        role: 'tenant_admin',
      });

      const newUid = 'fb-new-uid-222';
      mocks.verifyIdToken.mockResolvedValue({
        uid: newUid,
        email: 'reregister@example.com',
        name: 'Updated Name',
        picture: null,
        email_verified: true,
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'valid-token' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.is_new).toBe(false);
      expect(body.user.firebase_uid).toBe(newUid);
      expect(body.user.email).toBe('reregister@example.com');
      // display_name should keep existing (COALESCE keeps non-null)
      expect(body.user.display_name).toBe('Original Name');
      // phone_number should keep existing (not placeholder)
      expect(body.user.phone_number).toBe('+15551112222');

      await app.close();
    });

    it('returns 400 when id_token is missing', async () => {
      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details.length).toBeGreaterThan(0);

      // verifyIdToken should never be called on validation failure
      expect(mocks.verifyIdToken).not.toHaveBeenCalled();

      await app.close();
    });

    it('returns 400 when id_token is empty string', async () => {
      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: '' },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe('Bad Request');

      await app.close();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // The four session paths, each through the real route on real Postgres
  // (session path 4 never creates a tenant).
  // ────────────────────────────────────────────────────────────────────────

  describe('session paths 1–4', () => {
    async function postSession(decoded: Record<string, unknown>, payload: Record<string, unknown> = { id_token: 't' }) {
      mocks.verifyIdToken.mockResolvedValue(decoded);
      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();
      const res = await app.inject({ method: 'POST', url: '/auth/session', payload });
      await app.close();
      return res;
    }

    it('path 1 — a bound uid signs in and gets the settings map for every account it reaches', async () => {
      const tenant = await insertTenant();
      const a1 = await insertAccount({ tenant_id: tenant.id });
      const a2 = await insertAccount({ tenant_id: tenant.id });
      await insertAccount({ tenant_id: tenant.id, status: 'deleted' });
      const user = await insertUser({ firebase_uid: 'fb-path-1', email: 'p1@example.com' });
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: null, role: 'tenant_owner' });
      await getTestPool().query(
        `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, allow_recording, analyze_calls)
         VALUES ($1, $2, 9, true, NULL)`,
        [tenant.id, a1.id],
      );

      const res = await postSession({ uid: 'fb-path-1', email: 'p1@example.com', email_verified: true });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.is_new).toBe(false);
      expect(body.user.id).toBe(user.id);
      expect(Object.keys(body.settings).sort()).toEqual([a1.id, a2.id].sort());
      expect(body.settings[a1.id]).toMatchObject({ max_concurrent_calls: 9, allow_recording: true, analyze_calls: false });
      expect(body.settings[a2.id]).toMatchObject({ max_concurrent_calls: 5, allow_recording: false, analyze_calls: false });
      expect(await identityRowCounts()).toEqual({ users: 1, tenants: 1, accounts: 3, memberships: 1 });
    });

    it('path 2 — a verified email activates the pending_ stub in place, writing no new row', async () => {
      const tenant = await insertTenant();
      const account = await insertAccount({ tenant_id: tenant.id });
      const stub = await insertUser({ firebase_uid: 'pending_path2', email: 'p2@example.com', phone_number: '0000000000' });
      await insertMembership({ user_id: stub.id, tenant_id: tenant.id, account_id: account.id, role: 'agent' });

      const res = await postSession({ uid: 'fb-path-2', email: 'p2@example.com', email_verified: true });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.id).toBe(stub.id);
      expect(body.user.firebase_uid).toBe('fb-path-2');
      expect(Object.keys(body.settings)).toEqual([account.id]);
      const { rows } = await getTestPool().query('SELECT firebase_uid FROM users WHERE id = $1', [stub.id]);
      expect(rows[0].firebase_uid).toBe('fb-path-2');
      expect(await identityRowCounts()).toEqual({ users: 1, tenants: 1, accounts: 1, memberships: 1 });
    });

    it('path 3 — a re-registered uid is adopted by proven email; the old uid no longer resolves', async () => {
      const tenant = await insertTenant();
      const user = await insertUser({ firebase_uid: 'fb-path-3-old', email: 'p3@example.com' });
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, role: 'tenant_admin' });

      const res = await postSession({ uid: 'fb-path-3-new', email: 'p3@example.com', email_verified: true });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.id);
      expect(res.json().user.firebase_uid).toBe('fb-path-3-new');
      expect(await userRepository.findByFirebaseUid('fb-path-3-old')).toBeNull();
      expect((await userRepository.findByFirebaseUid('fb-path-3-new'))?.id).toBe(user.id);
      expect(await identityRowCounts()).toEqual({ users: 1, tenants: 1, accounts: 0, memberships: 1 });
    });

    it('path 4 — a verified stranger is refused 403 no_membership and the database is untouched', async () => {
      // Pre-existing, unrelated rows: path 4 must not add to any table.
      const tenant = await insertTenant();
      const other = await insertUser({ firebase_uid: 'fb-someone-else', email: 'else@example.com' });
      await insertMembership({ user_id: other.id, tenant_id: tenant.id, role: 'tenant_owner' });
      const before = await identityRowCounts();

      const res = await postSession({ uid: 'fb-stranger', email: 'stranger@example.com', email_verified: true, name: 'Stranger' });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('no_membership');
      expect(await identityRowCounts()).toEqual(before);
      expect(await userRepository.findByFirebaseUid('fb-stranger')).toBeNull();
      expect(await userRepository.findByEmail('stranger@example.com')).toBeNull();
    });

    it('path 4 — a phone-only token (no email) is refused the same way and writes nothing', async () => {
      const res = await postSession({ uid: 'fb-phone-only' }, { id_token: 't', phone_number: '+15550001111' });

      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('no_membership');
      expect(await identityRowCounts()).toEqual({ users: 0, tenants: 0, accounts: 0, memberships: 0 });
    });

    it('path 4 leaves no trace: a stub created afterwards for that address is matched by path 2', async () => {
      const first = await postSession({ uid: 'fb-late-invitee', email: 'late@example.com', email_verified: true });
      expect(first.statusCode).toBe(403);

      // A super-admin / team admin then adds them (a pending_ stub + membership).
      const tenant = await insertTenant();
      const stub = await insertUser({ firebase_uid: 'pending_late', email: 'late@example.com' });
      await insertMembership({ user_id: stub.id, tenant_id: tenant.id, role: 'viewer' });

      const second = await postSession({ uid: 'fb-late-invitee', email: 'late@example.com', email_verified: true });

      expect(second.statusCode).toBe(200);
      expect(second.json().user.id).toBe(stub.id);
      expect(await identityRowCounts()).toMatchObject({ users: 1, memberships: 1 });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // GET /me
  // ────────────────────────────────────────────────────────────────────────

  describe('GET /me', () => {
    it('returns current user with tenants and memberships', async () => {
      const tenant = await insertTenant();
      const account = await insertAccount({ tenant_id: tenant.id });
      const user = await insertUser({
        firebase_uid: 'fb-me-001',
        email: 'me@example.com',
        display_name: 'Me User',
      });
      await insertMembership({
        user_id: user.id,
        tenant_id: tenant.id,
        account_id: account.id,
        role: 'account_admin',
      });

      // Mock sessionMiddleware to inject user from x-test-user-id header
      mocks.sessionMiddleware.mockImplementation(async (request: any) => {
        const pool = getTestPool();
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [
          request.headers['x-test-user-id'],
        ]);
        request.user = result.rows[0];
      });

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { 'x-test-user-id': user.id },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.user.id).toBe(user.id);
      expect(body.user.email).toBe('me@example.com');
      expect(body.tenants).toHaveLength(1);
      expect(body.tenants[0].id).toBe(tenant.id);
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0].role).toBe('account_admin');

      // The response carries the per-account `settings` map: here the one account the membership reaches,
      // with no settings row, so every field is a default.
      expect(body).not.toHaveProperty('governance');
      expect(body.settings).toEqual({
        [account.id]: {
          tenant_id: tenant.id,
          account_id: account.id,
          allow_recording: false,
          analyze_calls: false,
          max_concurrent_calls: 5,
          webrtc_max_duration_seconds: 1800,
          updated_at: expect.any(String),
        },
      });

      await app.close();
    });

    // The throw is injected into the real settings-map builder.
    it('sends settings: {} (fail-open) and still 200 when the resolver throws', async () => {
      const tenant = await insertTenant();
      const account = await insertAccount({ tenant_id: tenant.id });
      const user = await insertUser({ firebase_uid: 'fb-me-failopen', email: 'failopen@example.com' });
      await insertMembership({ user_id: user.id, tenant_id: tenant.id, account_id: account.id, role: 'operator' });

      mocks.sessionMiddleware.mockImplementation(async (request: any) => {
        const pool = getTestPool();
        const result = await pool.query('SELECT * FROM users WHERE id = $1', [request.headers['x-test-user-id']]);
        request.user = result.rows[0];
      });
      mocks.buildSettingsMap.mockRejectedValueOnce(new Error('db down'));

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { 'x-test-user-id': user.id } });

      // A settings hiccup must NOT break login — fail-open to an empty map.
      expect(res.statusCode).toBe(200);
      expect(res.json().settings).toEqual({});

      await app.close();
    });

    it('returns 401 when sessionMiddleware does not set user', async () => {
      // sessionMiddleware does not set request.user
      mocks.sessionMiddleware.mockImplementation(async () => {});

      const app = Fastify();
      await app.register(authRoutes, { prefix: '/auth' });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBe('Unauthorized');

      await app.close();
    });
  });
});
