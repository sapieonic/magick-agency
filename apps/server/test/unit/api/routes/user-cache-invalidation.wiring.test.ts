import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WIRING tests: prove POST /auth/session actually CALLS invalidateUserCache with
 * the correct arguments after a successful user write — and NOT when the request
 * is rejected before any write.
 *
 * Two write paths:
 *  - Path 1 (existing firebase user, phone backfill): invalidateUserCache(existingUser.id, existingUser.firebase_uid)
 *  - Path 2/3 (email-matched user, account-linking raw UPDATE): invalidateUserCache(emailUser.id, emailUser.firebase_uid)
 *    CORRECTNESS: it must pass the OLD firebase_uid (emailUser.firebase_uid), NOT the new decoded uid.
 */

const DECODED_UID = 'uid-new-123';

const inv = vi.hoisted(() => ({
  invalidateUserCache: vi.fn().mockResolvedValue(undefined),
}));

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  findByFirebaseUid: vi.fn(),
  findByEmail: vi.fn(),
  updateUser: vi.fn().mockResolvedValue(undefined),
  listByUserId: vi.fn().mockResolvedValue([]),
  findAllByUserId: vi.fn().mockResolvedValue([]),
  getEffective: vi.fn().mockResolvedValue({}),
  poolQuery: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (_req: any) => {},
  invalidateUserCache: inv.invalidateUserCache,
}));

vi.mock('../../../../src/auth/firebase.js', () => ({
  verifyIdToken: mocks.verifyIdToken,
}));

vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: mocks.findByFirebaseUid,
    findByEmail: mocks.findByEmail,
    update: mocks.updateUser,
  },
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { listByUserId: mocks.listByUserId },
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findAllByUserId: mocks.findAllByUserId },
}));
vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() }),
  }),
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import { authRoutes } from '../../../../src/api/routes/auth.routes.js';

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdToken.mockResolvedValue({
    uid: DECODED_UID, email: 'a@b.com', name: 'A', picture: null, email_verified: true,
  });
});

describe('auth.routes — user cache invalidation wiring', () => {
  describe('Path 1: existing firebase user with phone backfill', () => {
    it('invalidates the user cache with (existingUser.id, existingUser.firebase_uid)', async () => {
      mocks.findByFirebaseUid.mockResolvedValue({
        id: 'u-1',
        firebase_uid: DECODED_UID,
        phone_number: '0000000000',
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'tok', phone_number: '9998887777' },
      });

      expect(res.statusCode).toBe(200);
      expect(mocks.updateUser).toHaveBeenCalledWith('u-1', { phone_number: '9998887777' });
      expect(inv.invalidateUserCache).toHaveBeenCalledTimes(1);
      expect(inv.invalidateUserCache).toHaveBeenCalledWith('u-1', DECODED_UID);
    });

    it('does NOT invalidate when the phone is not a placeholder (no write happened)', async () => {
      mocks.findByFirebaseUid.mockResolvedValue({
        id: 'u-1',
        firebase_uid: DECODED_UID,
        phone_number: '1234567890', // already a real number → no backfill
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'tok', phone_number: '9998887777' },
      });

      expect(res.statusCode).toBe(200);
      expect(mocks.updateUser).not.toHaveBeenCalled();
      expect(inv.invalidateUserCache).not.toHaveBeenCalled();
    });
  });

  describe('Path 2/3: email-matched user, account-linking UPDATE', () => {
    it('invalidates with the OLD firebase_uid (emailUser.firebase_uid), not the new decoded uid', async () => {
      // Path 1 miss, then re-fetch after UPDATE returns the adopted user.
      mocks.findByFirebaseUid
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'u-2', firebase_uid: DECODED_UID });
      mocks.findByEmail.mockResolvedValue({
        id: 'u-2',
        firebase_uid: 'pending_old-stub',
        email: 'a@b.com',
      });
      mocks.poolQuery.mockResolvedValue({
        rows: [{ id: 'u-2', firebase_uid: DECODED_UID, email: 'a@b.com' }],
        rowCount: 1,
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: { id_token: 'tok' },
      });

      expect(res.statusCode).toBe(200);
      expect(mocks.poolQuery).toHaveBeenCalled(); // the account-linking UPDATE ran
      expect(inv.invalidateUserCache).toHaveBeenCalledTimes(1);
      expect(inv.invalidateUserCache).toHaveBeenCalledWith('u-2', 'pending_old-stub');
      // Correctness: must NOT pass the freshly-decoded uid
      expect(inv.invalidateUserCache).not.toHaveBeenCalledWith('u-2', DECODED_UID);
    });

    it('does NOT invalidate when the request body is invalid (400 before any write)', async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/auth/session',
        payload: {}, // missing id_token → 400
      });

      expect(res.statusCode).toBe(400);
      expect(mocks.verifyIdToken).not.toHaveBeenCalled();
      expect(inv.invalidateUserCache).not.toHaveBeenCalled();
    });
  });
});
