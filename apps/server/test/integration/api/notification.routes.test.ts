import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * `GET` / `PUT /notifications/preferences`
 * through the REAL route plugin at the platform plugin's prefix, behind the real
 * `sessionMiddleware` and `tenantContextMiddleware` (the real Redis cache
 * included), on real Postgres 5436 and Redis 6383 db 1, with only Firebase's
 * `verifyIdToken` mocked. The plugin is registered on its own rather than
 * through `buildApp`, so the suite does not depend on every other route
 * module compiling.
 *
 * What it pins: these routes have NO permission floor, so an `agent`
 * — level 5, below `viewer` — reaches its own preferences. With agency's
 * one-event catalog it can receive nothing (`agency.campaign.completed` floors
 * at `agency.supervise` = `account_admin`), so GET is an empty list rather than
 * a 403, and a PUT is accepted and stored against the session user. The
 * supervisor in the same tenant is the contrast, and the deleted digest
 * preview answers 404.
 */

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(async () => {}),
  verifyIdToken: h.verifyIdToken,
}));

import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { getTestRedis, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';
import { redisCache } from '../../../src/cache/redis-cache.js';
import { notificationRoutes } from '../../../src/api/routes/notification.routes.js';

let app: FastifyInstance;

describe('/notifications/preferences through the real app (integration)', () => {
  let tenantId: string;
  let accountId: string;
  let agentId: string;
  let supervisorId: string;

  beforeAll(async () => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    redisCache.init(getTestRedis());
    app = Fastify();
    // The prefix `apps/server/src/api/platform.plugin.ts` registers it under.
    await app.register(notificationRoutes, { prefix: '/notifications' });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    h.verifyIdToken.mockReset();

    const tenant = await insertTenant();
    const account = await insertAccount({ tenant_id: tenant.id });
    const agent = await insertUser({ firebase_uid: 'fb-agent', email: 'agent@acme.example' });
    const supervisor = await insertUser({ firebase_uid: 'fb-supervisor', email: 'sup@acme.example' });
    await insertMembership({ user_id: agent.id, tenant_id: tenant.id, account_id: account.id, role: 'agent' });
    await insertMembership({
      user_id: supervisor.id, tenant_id: tenant.id, account_id: account.id, role: 'account_admin',
    });
    tenantId = tenant.id;
    accountId = account.id;
    agentId = agent.id;
    supervisorId = supervisor.id;
  });

  afterAll(async () => {
    await app.close();
    await closeTestRedis();
    await closePool();
  });

  function signInAs(uid: string, email: string) {
    h.verifyIdToken.mockResolvedValue({ uid, email, email_verified: true });
    return { authorization: `Bearer token-${uid}`, 'x-tenant-id': tenantId, 'x-account-id': accountId };
  }

  async function storedFor(userId: string) {
    const { rows } = await getPool().query(
      `SELECT user_id, tenant_id, event_key, channel, enabled, frequency
         FROM user_notification_preferences WHERE user_id = $1`,
      [userId],
    );
    return rows;
  }

  it('an agent GETs its own preferences: 200 and an empty list, not a 403', async () => {
    const headers = signInAs('fb-agent', 'agent@acme.example');
    const res = await app.inject({ method: 'GET', url: '/notifications/preferences', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ events: [] });
  });

  it('an agent PUTs its own preferences: 200, stored against the session user', async () => {
    const headers = signInAs('fb-agent', 'agent@acme.example');
    const res = await app.inject({
      method: 'PUT',
      url: '/notifications/preferences',
      headers,
      payload: { user_id: supervisorId, preferences: [{ event_key: 'agency.campaign.completed', enabled: false }] },
    });
    expect(res.statusCode).toBe(200);
    // The agent cannot receive the event, so the response lists nothing…
    expect(res.json()).toEqual({ preferences: [] });
    // …but the row is stored (inert until a promotion), under the SESSION user.
    expect(await storedFor(agentId)).toEqual([{
      user_id: agentId, tenant_id: tenantId, event_key: 'agency.campaign.completed',
      channel: 'email', enabled: false, frequency: null,
    }]);
    expect(await storedFor(supervisorId)).toEqual([]);
  });

  it('a supervisor sees the agency notice, at its default and then at its saved value', async () => {
    const headers = signInAs('fb-supervisor', 'sup@acme.example');
    const before = await app.inject({ method: 'GET', url: '/notifications/preferences', headers });
    expect(before.statusCode).toBe(200);
    expect(before.json().events).toEqual([expect.objectContaining({
      key: 'agency.campaign.completed', category: 'agency', cadence: 'immediate',
      enabled: true, frequency: null, is_default: true,
    })]);

    const put = await app.inject({
      method: 'PUT',
      url: '/notifications/preferences',
      headers,
      payload: { preferences: [{ event_key: 'agency.campaign.completed', enabled: false }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ preferences: [{
      event_key: 'agency.campaign.completed', channel: 'email', enabled: false, frequency: null, is_default: false,
    }] });

    const after = await app.inject({ method: 'GET', url: '/notifications/preferences', headers });
    expect(after.json().events).toEqual([expect.objectContaining({
      key: 'agency.campaign.completed', enabled: false, is_default: false,
    })]);
  });

  it('refuses a deleted catalog key with a 400 naming it', async () => {
    const headers = signInAs('fb-supervisor', 'sup@acme.example');
    const res = await app.inject({
      method: 'PUT',
      url: '/notifications/preferences',
      headers,
      payload: { preferences: [{ event_key: 'usage.digest', enabled: false }] },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('usage.digest');
    expect(await storedFor(supervisorId)).toEqual([]);
  });

  it('still requires a session: no bearer token is a 401', async () => {
    const res = await app.inject({
      method: 'GET', url: '/notifications/preferences', headers: { 'x-tenant-id': tenantId },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /notifications/digests/preview is not registered (credits usage digest)', async () => {
    const headers = signInAs('fb-supervisor', 'sup@acme.example');
    const res = await app.inject({
      method: 'POST', url: '/notifications/digests/preview', headers, payload: { frequency: 'weekly' },
    });
    expect(res.statusCode).toBe(404);
  });
});
