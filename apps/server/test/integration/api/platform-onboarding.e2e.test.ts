import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-end onboarding: **a super-admin creates a tenant and adds a user, who
 * then signs in** — across the REAL routes (`buildApp` with a real context: Postgres
 * 5436, Redis 6383 test db), with only Firebase's `verifyIdToken` mocked (as
 * the other suites do).
 *
 * The walk:
 *  1. the first super-admin is created by `scripts/create-super-admin.ts`
 *     (`createSuperAdmin`, the CLI's body); `POST /super-admin/login` → JWT;
 *  2. `POST /super-admin/tenants` → tenant + default account + `pending_` owner stub,
 *     no pooled number;
 *  3. the owner signs in with a VERIFIED token for that address → session path 2
 *     adopts the stub; the session carries the tenant, the `tenant_owner` membership
 *     and the settings map for the default account;
 *  4. `POST /super-admin/tenants/:id/users` adds an `agent` on that account → a
 *     `pending_` stub + account membership + a minted invite (mail unconfigured);
 *  5. the agent claims the invite with an UNVERIFIED email/password token (an
 *     agent's ordinary first sign-in) → bound, flagged `email_unverified`, signed in;
 *     then `POST /auth/session` with the same uid is path 1;
 *  6. the agent reads `GET /accounts/mine` and is refused `GET /accounts` (level 5);
 *  7. a brand-new verified identity nobody invited is refused with 403
 *     `no_membership` and NOTHING is written (path 4 never creates a tenant).
 */

const h = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'e2e-super-admin-secret-0123456789';
  return { minted: [] as string[], verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(async () => {}),
  verifyIdToken: h.verifyIdToken,
}));

vi.mock('../../../src/notifications/invite-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/notifications/invite-token.js')>();
  return {
    ...actual,
    mintInviteToken: async (ttlDays?: number) => {
      const minted = await actual.mintInviteToken(ttlDays);
      h.minted.push(minted.token);
      return minted;
    },
  };
});

import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { createSuperAdmin } from '../../../scripts/create-super-admin.js';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { TEST_REDIS_URL, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';

const OWNER_EMAIL = 'owner@acme.example';
const AGENT_EMAIL = 'agent@acme.example';

let app: FastifyInstance;
let redis: Redis;

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

describe('platform onboarding end to end (integration, real routes)', () => {
  beforeAll(async () => {
    const pool = initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
    redis = new Redis(TEST_REDIS_URL);
    app = await buildApp({ ctx: { config, pool, redis } });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    h.minted.length = 0;
    h.verifyIdToken.mockReset();
  });

  // Drain the routes' fire-and-forget super-admin
  // audit writes before the next `truncateAll()`; an in-flight INSERT deadlocks
  // with the TRUNCATE (see test/helpers/drain-super-admin-audit.ts).
  const auditWrites = trackSuperAdminAuditWrites();
  afterEach(async () => {
    await auditWrites.drain();
  });

  afterAll(async () => {
    auditWrites.restore();
    await app.close();
    await redis.quit();
    await closeTestRedis();
    await closePool();
  });

  it('super-admin creates a tenant and adds a user, who then signs in', async () => {
    // 1 — a super-admin, created fresh, logs in.
    const root = await createSuperAdmin({
      email: 'root@agency.example', password: 'correct horse battery', name: 'Root', system: true,
    });
    expect(root.ok).toBe(true);
    const login = await app.inject({
      method: 'POST',
      url: '/super-admin/login',
      payload: { email: 'root@agency.example', password: 'correct horse battery' },
    });
    expect(login.statusCode).toBe(200);
    const saAuth = { authorization: `Bearer ${login.json().token as string}` };

    // 2 — tenant create: pending_ owner stub, default account, no pooled number.
    const created = await app.inject({
      method: 'POST',
      url: '/super-admin/tenants',
      headers: saAuth,
      payload: { name: 'Acme Collections', owner_email: OWNER_EMAIL, owner_name: 'Olive Owner' },
    });
    expect(created.statusCode).toBe(201);
    const tenantId = created.json().tenant.id as string;
    expect(created.json()).toEqual({ tenant: expect.objectContaining({ id: tenantId }), owner_email: OWNER_EMAIL });
    const stub = await getPool().query<{ firebase_uid: string }>(`SELECT firebase_uid FROM users WHERE email = $1`, [OWNER_EMAIL]);
    expect(stub.rows[0]!.firebase_uid.startsWith('pending_')).toBe(true);
    expect(await count(`SELECT count(*)::int AS n FROM tenant_phone_assignments WHERE tenant_id = $1`, [tenantId])).toBe(0);
    const account = await getPool().query<{ id: string }>(`SELECT id FROM accounts WHERE tenant_id = $1`, [tenantId]);
    const accountId = account.rows[0]!.id;

    // 3 — the owner signs in with a VERIFIED token: session path 2 adopts the stub.
    h.verifyIdToken.mockResolvedValue({ uid: 'fb-owner', email: OWNER_EMAIL, email_verified: true, name: 'Olive' });
    const ownerSession = await app.inject({ method: 'POST', url: '/auth/session', payload: { id_token: 'owner-token' } });
    expect(ownerSession.statusCode).toBe(200);
    const owner = ownerSession.json();
    expect(owner.is_new).toBe(false);
    expect(owner.user.firebase_uid).toBe('fb-owner');
    expect(owner.tenants.map((t: { id: string }) => t.id)).toEqual([tenantId]);
    expect(owner.memberships).toEqual([expect.objectContaining({ tenant_id: tenantId, role: 'tenant_owner', account_id: null })]);
    expect(Object.keys(owner.settings)).toEqual([accountId]);
    expect(owner.settings[accountId]).toEqual(expect.objectContaining({
      tenant_id: tenantId, account_id: accountId, allow_recording: false, analyze_calls: false,
    }));

    // 4 — the super-admin adds an agent on the account: stub + membership + invite.
    const added = await app.inject({
      method: 'POST',
      url: `/super-admin/tenants/${tenantId}/users`,
      headers: saAuth,
      payload: { email: AGENT_EMAIL, role: 'agent', name: 'Andy Agent', account_id: accountId },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().membership).toEqual(expect.objectContaining({ tenant_id: tenantId, account_id: accountId, role: 'agent', status: 'active' }));
    expect(h.minted).toHaveLength(1);

    // 5 — the agent claims with an UNVERIFIED email/password token (the join page).
    h.verifyIdToken.mockResolvedValue({ uid: 'fb-agent', email: AGENT_EMAIL, email_verified: false });
    const claim = await app.inject({ method: 'POST', url: `/invites/${h.minted[0]}/claim`, payload: { id_token: 'agent-token' } });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().memberships).toEqual([expect.objectContaining({ tenant_id: tenantId, account_id: accountId, role: 'agent' })]);
    const agentRow = await getPool().query<{ firebase_uid: string; email_unverified: boolean }>(
      `SELECT firebase_uid, email_unverified FROM users WHERE email = $1`, [AGENT_EMAIL]);
    expect(agentRow.rows[0]).toEqual({ firebase_uid: 'fb-agent', email_unverified: true });

    // The link is single use.
    const again = await app.inject({ method: 'POST', url: `/invites/${h.minted[0]}/claim`, payload: { id_token: 'agent-token' } });
    expect(again.statusCode).toBe(409);
    expect(again.json().status).toBe('claimed');

    // Later sign-ins are path 1 (the uid is bound), even while unverified.
    const agentSession = await app.inject({ method: 'POST', url: '/auth/session', payload: { id_token: 'agent-token' } });
    expect(agentSession.statusCode).toBe(200);
    expect(agentSession.json().user.firebase_uid).toBe('fb-agent');

    // 6 — level 5: /accounts/mine answers, /accounts (account.read, viewer) refuses.
    const agentHeaders = { authorization: 'Bearer agent-token', 'x-tenant-id': tenantId, 'x-account-id': accountId };
    const mine = await app.inject({ method: 'GET', url: '/accounts/mine', headers: agentHeaders });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({ accounts: [{ id: accountId, name: 'Default', tenant_id: tenantId }] });
    const all = await app.inject({ method: 'GET', url: '/accounts', headers: agentHeaders });
    expect(all.statusCode).toBe(403);
  });

  it('path 4 refuses a brand-new verified identity with no_membership and writes nothing', async () => {
    const before = {
      users: await count(`SELECT count(*)::int AS n FROM users`),
      tenants: await count(`SELECT count(*)::int AS n FROM tenants`),
      accounts: await count(`SELECT count(*)::int AS n FROM accounts`),
      memberships: await count(`SELECT count(*)::int AS n FROM memberships`),
    };
    h.verifyIdToken.mockResolvedValue({ uid: 'fb-stranger', email: 'stranger@nowhere.example', email_verified: true });
    const res = await app.inject({ method: 'POST', url: '/auth/session', payload: { id_token: 'stranger' } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(expect.objectContaining({ error: 'Forbidden', code: 'no_membership' }));
    expect({
      users: await count(`SELECT count(*)::int AS n FROM users`),
      tenants: await count(`SELECT count(*)::int AS n FROM tenants`),
      accounts: await count(`SELECT count(*)::int AS n FROM accounts`),
      memberships: await count(`SELECT count(*)::int AS n FROM memberships`),
    }).toEqual(before);
  });
});
