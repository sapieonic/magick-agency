import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';

/**
 * `POST /accounts` through the REAL middleware chain: session (Firebase verification
 * stubbed, the user looked up for real), tenant context (membership selection, the
 * Redis membership cache) and RBAC (the contract's PERMISSION_MATRIX). The route's unit
 * test replaces all three; this is the file that proves the rule the route relies on:
 *
 *  - with no `X-Account-Id`, a person holding a tenant-wide admin seat beside a lower
 *    account seat is judged on the tenant-wide seat, and with `X-Account-Id` on the
 *    account seat (`selectMembership`);
 *  - an admin seat scoped to one account is refused `tenant_wide_membership_required`;
 *  - the new account starts at zero concurrent calls, and the creator's refreshed session
 *    carries it in the settings map (decision AA4).
 */

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(async () => {}),
  verifyIdToken: h.verifyIdToken,
}));

import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertTenant, insertAccount, insertUser, insertMembership } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_REDIS_URL, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';

let app: FastifyInstance;
let redis: Redis;

describe('POST /accounts through the real middleware (integration)', () => {
  let tenant: { id: string };
  let defaultAccount: { id: string };

  beforeAll(async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    redis = new Redis(TEST_REDIS_URL);
    app = await buildApp({ ctx: { config, pool, redis } });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    h.verifyIdToken.mockReset();
    tenant = await insertTenant();
    defaultAccount = await insertAccount({ tenant_id: tenant.id, name: 'Default', slug: 'default' });
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
    await closeTestRedis();
    await closePool();
  });

  /** A user signed in as themselves, holding `seats` in the tenant. */
  async function person(seats: Array<{ role: string; account_id: string | null }>) {
    const user = await insertUser();
    for (const seat of seats) await insertMembership({ user_id: user.id, tenant_id: tenant.id, ...seat });
    return user as { id: string; firebase_uid: string; email: string };
  }

  function create(user: { firebase_uid: string; email: string }, name: string, accountHeader?: string) {
    h.verifyIdToken.mockResolvedValue({ uid: user.firebase_uid, email: user.email, email_verified: true });
    return app.inject({
      method: 'POST',
      url: '/accounts',
      headers: {
        authorization: 'Bearer token',
        'x-tenant-id': tenant.id,
        ...(accountHeader ? { 'x-account-id': accountHeader } : {}),
      },
      payload: { name },
    });
  }

  it('a tenant-wide owner creates an account that starts at zero calls and lists after Default', async () => {
    const owner = await person([{ role: 'tenant_owner', account_id: null }]);

    const res = await create(owner, 'Renewals');

    expect(res.statusCode).toBe(201);
    const { account } = res.json();
    const { rows: settings } = await getPool().query(
      'SELECT max_concurrent_calls FROM account_settings WHERE tenant_id = $1 AND account_id = $2',
      [tenant.id, account.id],
    );
    expect(settings).toEqual([{ max_concurrent_calls: 0 }]);

    // The list the console's switcher reads: oldest first, so Default stays the landing account.
    const list = await app.inject({
      method: 'GET', url: '/accounts', headers: { authorization: 'Bearer token', 'x-tenant-id': tenant.id },
    });
    expect(list.json().accounts.map((a: { name: string }) => a.name)).toEqual(['Default', 'Renewals']);

    // The refreshed session (the console's `refreshSession`) carries the new account's
    // effective settings, so its governance map is not empty for it.
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: 'Bearer token' } });
    expect(me.statusCode).toBe(200);
    expect(me.json().settings[account.id]).toEqual(expect.objectContaining({ account_id: account.id, max_concurrent_calls: 0 }));
  });

  it('judges a tenant-wide admin seat beside an agent seat on the tenant-wide seat when no account is named', async () => {
    const mixed = await person([
      { role: 'tenant_admin', account_id: null },
      { role: 'agent', account_id: defaultAccount.id },
    ]);

    const res = await create(mixed, 'Collections');

    expect(res.statusCode).toBe(201);
  });

  it('judges the same person on the agent seat when X-Account-Id names that account (403)', async () => {
    const mixed = await person([
      { role: 'tenant_admin', account_id: null },
      { role: 'agent', account_id: defaultAccount.id },
    ]);

    const res = await create(mixed, 'Collections', defaultAccount.id);

    expect(res.statusCode).toBe(403);
    const { rows } = await getPool().query(`SELECT 1 FROM accounts WHERE name = 'Collections'`);
    expect(rows).toEqual([]);
  });

  it('refuses a tenant_admin seat scoped to one account (403 tenant_wide_membership_required)', async () => {
    const scoped = await person([{ role: 'tenant_admin', account_id: defaultAccount.id }]);

    const res = await create(scoped, 'Elsewhere');

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('tenant_wide_membership_required');
  });

  it('refuses a tenant-wide account_admin on the real floor (403)', async () => {
    const accountAdmin = await person([{ role: 'account_admin', account_id: null }]);

    const res = await create(accountAdmin, 'Elsewhere');

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBeUndefined();
  });

  it('refuses a member of another tenant, whatever their role there', async () => {
    const other = await insertTenant();
    const stranger = await insertUser() as { id: string; firebase_uid: string; email: string };
    await insertMembership({ user_id: stranger.id, tenant_id: other.id, role: 'tenant_owner', account_id: null });

    const res = await create(stranger, 'Takeover');

    expect(res.statusCode).toBe(403);
    const { rows } = await getPool().query('SELECT 1 FROM accounts WHERE tenant_id = $1 AND name = $2', [tenant.id, 'Takeover']);
    expect(rows).toEqual([]);
  });
});
