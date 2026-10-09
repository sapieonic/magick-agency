import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyIdToken, type DecodedFirebaseToken } from './firebase.js';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { redisCache } from '../cache/redis-cache.js';
import { createChildLogger } from '@magick-agency/observability';
import { authAttemptsTotal } from '@magick-agency/observability/metrics/platform';
import type { UserRecord } from '@magick-agency/db/models/user.model';

const log = createChildLogger({ component: 'session-middleware' });

const USER_CACHE_TTL = 20 * 60; // 20 minutes

/**
 * Invalidate the cached user record after any write to the users table.
 * The same user is cached under TWO namespaces — `cache:user:fb:{uid}`
 * (Firebase path) and `cache:user:id:{id}` (API-key path) — so both must be
 * cleared. Most important field is `status`: without this, a deactivated user
 * keeps authenticating until the 20-minute TTL expires.
 */
export async function invalidateUserCache(userId: string, firebaseUid?: string | null): Promise<void> {
  const keys = [`cache:user:id:${userId}`];
  if (firebaseUid) keys.push(`cache:user:fb:${firebaseUid}`);
  await redisCache.del(...keys);
}

declare module 'fastify' {
  interface FastifyRequest {
    firebaseToken?: DecodedFirebaseToken;
    user?: UserRecord;
    /*
     * PORT NOTE (magick-agency): master's `apiKeyTenantId` and `apiKey` fields are
     * removed with the platform API-key branch below (decision #5: no platform
     * API keys in v1). `request.user` is therefore always the Firebase-verified
     * person; nothing on this request can be a credential's creator.
     */
  }
}

/**
 * Session middleware: extract Bearer token → verify Firebase → load user → attach request.user.
 */
export async function sessionMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authHeader = request.headers['authorization'];
  const platformKey = request.headers['x-platform-key'] as string | undefined;

  // Try Firebase Bearer token first
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = await verifyIdToken(token);
      request.firebaseToken = decoded;

      // Load user — try Redis cache first, fall through to DB
      const userCacheKey = `cache:user:fb:${decoded.uid}`;
      let user = await redisCache.get<UserRecord>(userCacheKey);
      if (!user) {
        user = await userRepository.findByFirebaseUid(decoded.uid);
        if (user) await redisCache.set(userCacheKey, user, USER_CACHE_TTL);
      }
      if (!user) {
        authAttemptsTotal.inc({ method: 'firebase', status: 'user_not_found' });
        return reply.code(401).send({ error: 'Unauthorized', message: 'User not found. Complete sign-up first.' });
      }

      if (user.status !== 'active') {
        authAttemptsTotal.inc({ method: 'firebase', status: 'inactive' });
        return reply.code(403).send({ error: 'Forbidden', message: 'User account is inactive' });
      }

      request.user = user;
      authAttemptsTotal.inc({ method: 'firebase', status: 'success' });
      return;
    } catch (err) {
      log.warn({ err }, 'Firebase token verification failed');
      authAttemptsTotal.inc({ method: 'firebase', status: 'invalid_token' });
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
    }
  }

  /*
   * PORT NOTE (magick-agency): master's `X-Platform-Key` fallback (lookup hash →
   * `platform_api_keys` → creator's user record) is DELETED — decision #5, no
   * platform API keys. The 401 below is master's, with the message no longer
   * offering a key header that would not be read.
   */
  authAttemptsTotal.inc({ method: 'none', status: 'missing' });
  return reply.code(401).send({ error: 'Unauthorized', message: 'Missing authentication. Provide a Bearer token.' });
}
