/*
 * PORT NOTE (magick-agency): ported from master test/unit/auth/session.middleware.test.ts@a1f0756a
 * (12 cases → 8). The 4 platform-API-key cases are deleted (decision #5).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  findByFirebaseUid: vi.fn(),
  findById: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock('../../../src/auth/firebase.js', () => ({
  verifyIdToken: mocks.verifyIdToken,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: {
    findByFirebaseUid: mocks.findByFirebaseUid,
    findById: mocks.findById,
  },
}));
// PORT NOTE (magick-agency): master's `platform-api-key.repository` and
// `utils/crypto` (`hashApiKey`) mocks are removed — the middleware no longer
// imports either (decision #5).
vi.mock('../../../src/cache/redis-cache.js', () => ({
  redisCache: { get: mocks.cacheGet, set: mocks.cacheSet, del: mocks.cacheDel },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@magick-agency/observability/metrics/platform', () => ({
  authAttemptsTotal: { inc: vi.fn() },
}));

import { sessionMiddleware, invalidateUserCache } from '../../../src/auth/session.middleware.js';

const activeUser = {
  id: 'u-1', firebase_uid: 'fb-uid-1', email: 'a@b.com', phone_number: '0000000000',
  display_name: null, avatar_url: null, status: 'active' as const,
  created_at: new Date(), updated_at: new Date(),
};
const inactiveUser = { ...activeUser, status: 'inactive' as const };


function makeReply() {
  const reply: any = { code: vi.fn(), send: vi.fn() };
  reply.code.mockReturnValue(reply);
  return reply;
}

function makeRequest(overrides: Record<string, unknown> = {}): any {
  return { headers: {}, ...overrides };
}

describe('sessionMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null);
  });

  // ─── Firebase Bearer token path ─────────────────────────────
  describe('Firebase auth path', () => {
    it('should load user from DB on cache miss and cache the result', async () => {
      mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
      mocks.findByFirebaseUid.mockResolvedValue(activeUser);

      const req = makeRequest({ headers: { authorization: 'Bearer valid-token' } });
      await sessionMiddleware(req, makeReply());

      expect(req.user).toEqual(activeUser);
      expect(mocks.findByFirebaseUid).toHaveBeenCalledWith('fb-uid-1');
      expect(mocks.cacheSet).toHaveBeenCalledWith(
        'cache:user:fb:fb-uid-1',
        activeUser,
        20 * 60,
      );
    });

    it('should return cached user without hitting DB or writing back to cache', async () => {
      mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
      // First cacheGet call returns the cached user
      mocks.cacheGet.mockResolvedValueOnce(activeUser);

      const req = makeRequest({ headers: { authorization: 'Bearer valid-token' } });
      await sessionMiddleware(req, makeReply());

      expect(req.user).toEqual(activeUser);
      expect(mocks.findByFirebaseUid).not.toHaveBeenCalled();
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('should return 401 when user not found (even from cache miss)', async () => {
      mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
      mocks.cacheGet.mockResolvedValue(null);
      mocks.findByFirebaseUid.mockResolvedValue(null);

      const reply = makeReply();
      await sessionMiddleware(
        makeRequest({ headers: { authorization: 'Bearer valid-token' } }),
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(401);
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('should return 403 when cached user is inactive', async () => {
      mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-uid-1' });
      mocks.cacheGet.mockResolvedValueOnce(inactiveUser);

      const reply = makeReply();
      await sessionMiddleware(
        makeRequest({ headers: { authorization: 'Bearer valid-token' } }),
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('should return 401 on Firebase token verification failure', async () => {
      mocks.verifyIdToken.mockRejectedValue(new Error('expired'));

      const reply = makeReply();
      await sessionMiddleware(
        makeRequest({ headers: { authorization: 'Bearer bad-token' } }),
        reply,
      );

      expect(reply.code).toHaveBeenCalledWith(401);
    });
  });

  // PORT NOTE (magick-agency): master's 'API key auth path' block (4 cases: load
  // and cache a key, cached key, 401 unknown key, 401 expired key) is deleted with
  // the `X-Platform-Key` branch (decision #5, no platform API keys).

  // ─── No credentials ─────────────────────────────────────────
  describe('no credentials', () => {
    it('should return 401 when no auth header or API key', async () => {
      const reply = makeReply();
      await sessionMiddleware(makeRequest(), reply);
      expect(reply.code).toHaveBeenCalledWith(401);
    });
  });
});

describe('invalidateUserCache', () => {
  beforeEach(() => vi.clearAllMocks());

  it('should clear both the id and firebase-uid namespaces', async () => {
    await invalidateUserCache('u-1', 'fb-uid-1');
    expect(mocks.cacheDel).toHaveBeenCalledWith('cache:user:id:u-1', 'cache:user:fb:fb-uid-1');
  });

  it('should clear only the id namespace when no firebase uid is given', async () => {
    await invalidateUserCache('u-1');
    expect(mocks.cacheDel).toHaveBeenCalledWith('cache:user:id:u-1');
  });
});
