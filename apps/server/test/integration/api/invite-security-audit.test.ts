import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { randomUUID } from 'node:crypto';

/**
 * NEW (magick-agency, no source). The lane-A security audit of the invite and
 * team-management surface, plus the plan §8 Phase 3 exit-gate items for invites,
 * as NAMED cases on real Postgres 5436 and real Redis 6383.
 *
 * Everything is real except Firebase: `verifyIdToken` is the only double (a
 * token string maps to a decoded identity), as every master suite does. The
 * session, tenant-context and RBAC middlewares, the repositories, the issuer,
 * the claim transaction and the session payload all run as in production, so
 * each verdict below is the decision the running app makes.
 *
 * Plan §9 invariants carried here: "no lookup by address binds an unverified
 * email" (d) and "an invite token is single use and expires" (f).
 *
 *   (a) issuing at or above the caller's role, and widening scope
 *   (b) resending for a target at or above the caller's role
 *   (c) the claim's role comes only from the stored rows
 *   (d) a claim from a different address
 *   (e) a token from tenant X with headers naming tenant Y
 *   (f) issue, revoke, single use, expiry (incl. the TTL inside the statement)
 *   (g) the auth chain on every authenticated route, by execution
 *   (h) what the two PUBLIC routes disclose, by exact body equality
 *
 * Master (a1f0756a) runs the same code for every case here. The only behaviour
 * difference is the fail-closed hardening on a missing `request.membership`
 * (PORT NOTEs in `user.routes.ts` / `invites.routes.ts`), which no case here can
 * reach through the real chain: (g) shows `requirePermission` refuses first.
 */

const CONSOLE = vi.hoisted(() => {
  // The issuer builds the join link from `CONSOLE_BASE_URL`; config is frozen at
  // first import, so it is set before any module loads.
  process.env['CONSOLE_BASE_URL'] = 'https://console.agency.test';
  return { origin: 'https://console.agency.test' };
});

const mocks = vi.hoisted(() => ({
  identities: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../../src/auth/firebase.js', () => ({
  verifyIdToken: async (token: string) => {
    const decoded = mocks.identities.get(token);
    if (!decoded) throw new Error('invalid token');
    return decoded;
  },
}));

import { initDbPool, closePool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import {
  insertAccount,
  insertMembership,
  insertMembershipInvite,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { getTestRedis, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });

const { redisCache } = await import('../../../src/cache/redis-cache.js');
const { userRoutes } = await import('../../../src/api/routes/user.routes.js');
const { inviteRoutes } = await import('../../../src/api/routes/invites.routes.js');
const { hashInviteToken, mintInviteToken } = await import('../../../src/notifications/invite-token.js');
const { membershipInviteRepository } = await import(
  '../../../src/db/repositories/membership-invite.repository.js'
);
const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');
const { membershipRepository } = await import('@magick-agency/db/repositories/membership.repository');
const { userRepository } = await import('@magick-agency/db/repositories/user.repository');
const { PENDING_UID_PREFIX } = await import('../../../src/auth/firebase-identity.js');

const DAY = 24 * 60 * 60 * 1000;

/** Fastify `onRoute` record of every route the two plugins register. */
const registered: { method: string; url: string }[] = [];

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRoute', (route: RouteOptions) => {
    for (const method of [route.method].flat()) registered.push({ method, url: route.url });
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(inviteRoutes, { prefix: '/invites' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

/** A Firebase identity a test can sign in with. */
function identity(token: string, decoded: { uid: string; email?: string | null; email_verified?: boolean; name?: string }) {
  mocks.identities.set(token, { name: 'Somebody', ...decoded });
  return { authorization: `Bearer ${token}` };
}

interface Workspace {
  tenant: { id: string; name: string };
  accountA: { id: string };
  accountB: { id: string };
  owner: { id: string; display_name: string };
  ownerAuth: Record<string, string>;
}

async function workspace(label: string): Promise<Workspace> {
  const tenant = await insertTenant({ name: `${label} Corp` });
  const accountA = await insertAccount({ tenant_id: tenant.id });
  const accountB = await insertAccount({ tenant_id: tenant.id });
  const uid = `fb-owner-${label}-${randomUUID().slice(0, 6)}`;
  const owner = await insertUser({ firebase_uid: uid, email: `owner-${uid}@corp.test`, display_name: `${label} Owner` });
  await insertMembership({ user_id: owner.id, tenant_id: tenant.id, account_id: null, role: 'tenant_owner' });
  return { tenant, accountA, accountB, owner, ownerAuth: identity(`tok-${uid}`, { uid, email: owner.email, email_verified: true }) };
}

/** A real member of `ws` with `role`, signed in. */
async function member(ws: Workspace, role: string, accountId: string | null) {
  const uid = `fb-${role}-${randomUUID().slice(0, 8)}`;
  const user = await insertUser({ firebase_uid: uid, email: `${uid}@corp.test` });
  const membership = await insertMembership({ user_id: user.id, tenant_id: ws.tenant.id, account_id: accountId, role });
  return { user, membership, auth: identity(`tok-${uid}`, { uid, email: user.email, email_verified: true }) };
}

function as(ws: Workspace, auth: Record<string, string>, accountId?: string) {
  return { ...auth, 'x-tenant-id': ws.tenant.id, ...(accountId ? { 'x-account-id': accountId } : {}) };
}

/** `POST /users/invite` for an agent, as the owner; returns the body and the raw token. */
async function inviteAgent(ws: Workspace, email: string, accountId: string = ws.accountA.id) {
  const res = await app.inject({
    method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
    payload: { email, role: 'agent', account_id: accountId },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json();
  const token = String(body.sign_in_url).split('/agency/join/')[1]!;
  return { body, token: decodeURIComponent(token) };
}

function claim(token: string, idToken: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url: `/invites/${encodeURIComponent(token)}/claim`,
    payload: { id_token: idToken, ...extra }, headers,
  });
}

async function membershipsOf(userId: string) {
  const { rows } = await getTestPool().query(
    `SELECT id, tenant_id, account_id, role, status FROM memberships WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows as { id: string; tenant_id: string; account_id: string | null; role: string; status: string }[];
}

async function userRow(id: string) {
  const { rows } = await getTestPool().query(
    `SELECT id, firebase_uid, email, email_unverified FROM users WHERE id = $1`, [id],
  );
  return rows[0] as { id: string; firebase_uid: string; email: string; email_unverified: boolean };
}

async function inviteRows(membershipId: string) {
  const { rows } = await getTestPool().query(
    `SELECT id, token_hash, claimed_at, revoked_at, expires_at FROM membership_invites
      WHERE membership_id = $1 ORDER BY created_at`, [membershipId],
  );
  return rows as { id: string; token_hash: string; claimed_at: Date | null; revoked_at: Date | null; expires_at: Date }[];
}

async function countRows(table: 'memberships' | 'users' | 'membership_invites') {
  const { rows } = await getTestPool().query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n as number;
}

/** A stub + agent membership + live invite with a REAL token, written directly. */
async function stubInvite(ws: Workspace, opts: { email?: string; accountId?: string; role?: string; expiresAt?: Date } = {}) {
  const email = opts.email ?? `stub-${randomUUID().slice(0, 8)}@corp.test`;
  const stub = await insertUser({ firebase_uid: `${PENDING_UID_PREFIX}${randomUUID()}`, email, display_name: null });
  const membership = await insertMembership({
    user_id: stub.id, tenant_id: ws.tenant.id, account_id: opts.accountId ?? ws.accountA.id, role: opts.role ?? 'agent',
  });
  const minted = await mintInviteToken();
  const invite = await insertMembershipInvite({
    membership_id: membership.id, tenant_id: ws.tenant.id, email, role: opts.role ?? 'agent',
    token_hash: minted.tokenHash, expires_at: opts.expiresAt ?? minted.expiresAt, invited_by: ws.owner.id,
  });
  return { stub, membership, invite, token: minted.token, email };
}

beforeAll(async () => {
  redisCache.init(getTestRedis());
  app = await buildApp();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
});

afterAll(async () => {
  await app?.close();
  await platformAuditLogger.shutdown();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

// ═══ (f) issue ══════════════════════════════════════════════════════════════

describe('(f) invite issue', () => {
  it('invite issue: an agent invite writes a stub, an agent membership and ONE live invite matching the link', async () => {
    const ws = await workspace('issue');
    const { body, token } = await inviteAgent(ws, 'new.agent@corp.test');

    expect(body.sign_in_url).toBe(`${CONSOLE.origin}/agency/join/${encodeURIComponent(token)}`);
    const stub = await userRow(body.user.id);
    expect(stub.firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);
    expect(await membershipsOf(stub.id)).toEqual([
      expect.objectContaining({ tenant_id: ws.tenant.id, account_id: ws.accountA.id, role: 'agent', status: 'active' }),
    ]);
    const invites = await inviteRows(body.membership.id);
    expect(invites).toHaveLength(1);
    expect(invites[0]!.token_hash).toBe(hashInviteToken(token));
    expect(invites[0]!.claimed_at).toBeNull();
    expect(invites[0]!.revoked_at).toBeNull();
    // `invites.tokenTtlDays` defaults to 7.
    expect(Math.abs(new Date(invites[0]!.expires_at).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
  });
});

// ═══ (a) issuing at or above the caller's role ══════════════════════════════

describe('(a) POST /users/invite cannot escalate', () => {
  it('an account_admin cannot invite an account_admin (equal role): 403, nothing written', async () => {
    const ws = await workspace('a1');
    const admin = await member(ws, 'account_admin', ws.accountA.id);
    const before = [await countRows('users'), await countRows('memberships'), await countRows('membership_invites')];

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, admin.auth, ws.accountA.id),
      payload: { email: 'peer@corp.test', role: 'account_admin', account_id: ws.accountA.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot invite with a role equal to or above your own' });
    expect([await countRows('users'), await countRows('memberships'), await countRows('membership_invites')]).toEqual(before);
  });

  it.each(['tenant_owner', 'tenant_admin'])(
    'not even a tenant_owner can issue %s through the invite route: 400, nothing written',
    async (role) => {
      const ws = await workspace('a2');
      const before = await countRows('memberships');

      const res = await app.inject({
        method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
        payload: { email: 'escalate@corp.test', role },
      });

      expect(res.statusCode).toBe(400);
      expect(await countRows('memberships')).toBe(before);
    },
  );

  it('an account-scoped account_admin cannot issue a TENANT-WIDE membership (no account_id): 403', async () => {
    const ws = await workspace('a3');
    const admin = await member(ws, 'account_admin', ws.accountA.id);
    const before = await countRows('memberships');

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, admin.auth, ws.accountA.id),
      payload: { email: 'wide@corp.test', role: 'agent' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'account_id must match your account-scoped membership' });
    expect(await countRows('memberships')).toBe(before);
  });

  it('an account-scoped account_admin cannot issue into a SIBLING account: 403', async () => {
    const ws = await workspace('a4');
    const admin = await member(ws, 'account_admin', ws.accountA.id);

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, admin.auth, ws.accountA.id),
      payload: { email: 'sibling@corp.test', role: 'agent', account_id: ws.accountB.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe('account_id must match your account-scoped membership');
  });

  it('an account_admin CAN invite an agent into their own account (the floor is not a wall)', async () => {
    const ws = await workspace('a5');
    const admin = await member(ws, 'account_admin', ws.accountA.id);

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, admin.auth, ws.accountA.id),
      payload: { email: 'ok.agent@corp.test', role: 'agent', account_id: ws.accountA.id },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().membership).toMatchObject({ role: 'agent', account_id: ws.accountA.id });
  });
});

// ═══ (b) resending for a target at or above the caller ══════════════════════

describe('(b) POST /invites/resend cannot re-mint a credential above the caller', () => {
  it('refuses a target whose role EQUALS the caller\'s (account_admin → account_admin): 403, no new invite', async () => {
    const ws = await workspace('b1');
    const caller = await member(ws, 'account_admin', ws.accountA.id);
    const target = await stubInvite(ws, { role: 'account_admin', accountId: ws.accountA.id });

    const res = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, caller.auth, ws.accountA.id),
      payload: { membership_id: target.membership.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot resend an invitation for a role equal to or above your own' });
    const rows = await inviteRows(target.membership.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revoked_at).toBeNull();
  });

  it('refuses a target ABOVE the caller (tenant-wide account_admin → tenant_admin): 403', async () => {
    const ws = await workspace('b2');
    const caller = await member(ws, 'account_admin', null);
    const stub = await insertUser({ firebase_uid: `${PENDING_UID_PREFIX}${randomUUID()}`, email: 'boss@corp.test', display_name: null });
    const target = await insertMembership({ user_id: stub.id, tenant_id: ws.tenant.id, account_id: null, role: 'tenant_admin' });

    const res = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, caller.auth),
      payload: { membership_id: target.id },
    });

    expect(res.statusCode).toBe(403);
    expect(await inviteRows(target.id)).toEqual([]);
  });

  it('refuses a tenant_admin resending a LIVE tenant_owner invitation: 403, the live token stays the only one and still claims', async () => {
    // The live-chain twin of (a)'s issue case: real session, tenant context and
    // `requirePermission('user.invite')` (a tenant_admin clears it), then the
    // route's own role check refuses, so no credential for an owner is minted.
    const ws = await workspace('b3');
    const caller = await member(ws, 'tenant_admin', null);
    const target = await stubInvite(ws, { role: 'tenant_owner' });

    const res = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, caller.auth),
      payload: { membership_id: target.membership.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Cannot resend an invitation for a role equal to or above your own' });
    expect(res.body).not.toContain('/agency/join/');
    const rows = await inviteRows(target.membership.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: target.invite.id, revoked_at: null, claimed_at: null });
    identity('tok-b3', { uid: 'fb-b3', email: target.email, email_verified: true });
    expect((await claim(target.token, 'tok-b3')).statusCode).toBe(200);
  });
});

// ═══ (f) revoke ═════════════════════════════════════════════════════════════

describe('(f) revoke', () => {
  it('revoke: a resend revokes the outstanding token; the old one answers 409 revoked, the new one claims', async () => {
    const ws = await workspace('rev');
    const { body, token: oldToken } = await inviteAgent(ws, 'resent@corp.test');

    const resend = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, ws.ownerAuth),
      payload: { membership_id: body.membership.id },
    });
    expect(resend.statusCode, resend.body).toBe(200);
    const newToken = decodeURIComponent(String(resend.json().sign_in_url).split('/agency/join/')[1]!);
    expect(newToken).not.toBe(oldToken);

    const rows = await inviteRows(body.membership.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.revoked_at).not.toBeNull();
    expect(rows[1]!.revoked_at).toBeNull();

    identity('tok-resent', { uid: 'fb-resent', email: 'resent@corp.test', email_verified: true });
    const stale = await claim(oldToken, 'tok-resent');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().status).toBe('revoked');
    expect((await userRow(body.user.id)).firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);

    const fresh = await claim(newToken, 'tok-resent');
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect((await userRow(body.user.id)).firebase_uid).toBe('fb-resent');
  });
});

// ═══ (c) the claim's role comes only from the stored rows ═══════════════════

describe('(c) a claim grants exactly the stored membership', () => {
  it('a `role` (and tenant/account ids) in the claim BODY are ignored: the membership stays agent', async () => {
    const ws = await workspace('c1');
    const { stub, membership, token } = await stubInvite(ws);
    identity('tok-c1', { uid: 'fb-c1', email: stub.email, email_verified: true });

    const res = await claim(token, 'tok-c1', {
      role: 'tenant_owner', tenant_id: randomUUID(), account_id: ws.accountB.id, membership_id: randomUUID(),
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await membershipsOf(stub.id)).toEqual([
      { id: membership.id, tenant_id: ws.tenant.id, account_id: ws.accountA.id, role: 'agent', status: 'active' },
    ]);
    expect(res.json().memberships.map((m: { role: string }) => m.role)).toEqual(['agent']);
  });

  it('the claimer\'s OTHER memberships do not leak into the claimed one, and the claim changes none of them', async () => {
    // One person (one row) holding a higher membership in account A and invited
    // as an agent in account B — the shape `POST /users/invite` produces for a
    // known, proven address.
    const ws = await workspace('c2');
    const uid = 'fb-c2-two-hats';
    const person = await insertUser({ firebase_uid: uid, email: 'two.hats@corp.test' });
    const higher = await insertMembership({ user_id: person.id, tenant_id: ws.tenant.id, account_id: ws.accountA.id, role: 'account_admin' });
    const invited = await insertMembership({ user_id: person.id, tenant_id: ws.tenant.id, account_id: ws.accountB.id, role: 'agent' });
    const minted = await mintInviteToken();
    await insertMembershipInvite({
      membership_id: invited.id, tenant_id: ws.tenant.id, email: person.email, role: 'agent', token_hash: minted.tokenHash,
    });
    identity('tok-c2', { uid, email: person.email, email_verified: true });

    const res = await claim(minted.token, 'tok-c2', { role: 'tenant_admin' });

    expect(res.statusCode, res.body).toBe(200);
    expect((await membershipsOf(person.id)).map((m) => [m.id, m.role, m.account_id])).toEqual([
      [higher.id, 'account_admin', ws.accountA.id],
      [invited.id, 'agent', ws.accountB.id],
    ]);
  });

  it('a DIFFERENT existing user cannot claim a stub\'s invite: 409 identity_in_use, both rows and their roles unchanged', async () => {
    const ws = await workspace('c3');
    const other = await member(ws, 'account_admin', ws.accountA.id);
    const { stub, membership, token, invite } = await stubInvite(ws);
    const otherUid = (await userRow(other.user.id)).firebase_uid;
    identity('tok-c3', { uid: otherUid, email: other.user.email, email_verified: true });

    const res = await claim(token, 'tok-c3', { role: 'tenant_owner' });

    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe('identity_in_use');
    expect((await membershipsOf(other.user.id)).map((m) => m.role)).toEqual(['account_admin']);
    expect((await membershipsOf(stub.id)).map((m) => [m.id, m.role])).toEqual([[membership.id, 'agent']]);
    expect((await userRow(stub.id)).firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);
    // The transaction rolled back: the invite is still unspent.
    expect((await inviteRows(membership.id))[0]).toMatchObject({ id: invite.id, claimed_at: null });
  });
});

// ═══ (d) a claim from a different address ═══════════════════════════════════

describe('(d) claim from a different address — no lookup by address binds an unverified email', () => {
  it('claim with an UNVERIFIED Firebase token: binds, keeps the invited address, sets email_unverified', async () => {
    const ws = await workspace('d1');
    const { stub, token } = await stubInvite(ws, { email: 'invited@work.test' });
    identity('tok-d1', { uid: 'fb-d1', email: 'claimant@gmail.test', email_verified: false });

    const res = await claim(token, 'tok-d1');

    expect(res.statusCode, res.body).toBe(200);
    expect(await userRow(stub.id)).toEqual({
      id: stub.id, firebase_uid: 'fb-d1', email: 'invited@work.test', email_unverified: true,
    });
  });

  it('a later by-address invite does NOT reuse the flagged row: 409, no membership written onto it', async () => {
    const ws = await workspace('d2');
    const { stub, token } = await stubInvite(ws, { email: 'invited@work.test' });
    identity('tok-d2', { uid: 'fb-d2', email: 'claimant@gmail.test', email_verified: false });
    expect((await claim(token, 'tok-d2')).statusCode).toBe(200);

    // A different workspace invites the same address.
    const other = await workspace('d2-other');
    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(other, other.ownerAuth),
      payload: { email: 'invited@work.test', role: 'agent', account_id: other.accountA.id },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('unverified_address_holder');
    expect((await membershipsOf(stub.id)).map((m) => m.tenant_id)).toEqual([ws.tenant.id]);
  });

  it('claim with a VERIFIED different address binds and re-keys the row under the CLAIMANT\'s address', async () => {
    const ws = await workspace('d3');
    const { stub, token } = await stubInvite(ws, { email: 'invited@work.test' });
    identity('tok-d3', { uid: 'fb-d3', email: 'claimant@gmail.test', email_verified: true });

    expect((await claim(token, 'tok-d3')).statusCode).toBe(200);
    expect(await userRow(stub.id)).toEqual({
      id: stub.id, firebase_uid: 'fb-d3', email: 'claimant@gmail.test', email_unverified: false,
    });
    // Nothing answers to the invited address any more.
    expect((await userRepository.resolveByProvenEmail('invited@work.test')).status).toBe('none');
  });
});

// ═══ (e) headers naming another tenant ══════════════════════════════════════

describe('(e) the claim acts only on the invite\'s own tenant and membership', () => {
  it('a token from tenant X claimed with headers naming tenant Y and an account in Y touches only X', async () => {
    const x = await workspace('x');
    const y = await workspace('y');
    const { stub, membership, token } = await stubInvite(x);
    identity('tok-e', { uid: 'fb-e', email: stub.email, email_verified: true });
    const yBefore = await getTestPool().query(`SELECT id, user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY id`, [y.tenant.id]);

    const res = await claim(token, 'tok-e', {}, {
      ...y.ownerAuth, 'x-tenant-id': y.tenant.id, 'x-account-id': y.accountA.id,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(await membershipsOf(stub.id)).toEqual([
      { id: membership.id, tenant_id: x.tenant.id, account_id: x.accountA.id, role: 'agent', status: 'active' },
    ]);
    const yAfter = await getTestPool().query(`SELECT id, user_id, role FROM memberships WHERE tenant_id = $1 ORDER BY id`, [y.tenant.id]);
    expect(yAfter.rows).toEqual(yBefore.rows);
    expect(res.json().tenants.map((t: { id: string }) => t.id)).toEqual([x.tenant.id]);
    await platformAuditLogger.shutdown();
    // Scoped to the two tenants of this case: the audit buffer flushes rows from
    // earlier cases asynchronously, after their `truncateAll`.
    const audit = await getTestPool().query(
      `SELECT tenant_id FROM platform_audit_log
        WHERE action = 'user.invite_claimed' AND tenant_id = ANY($1::uuid[])`,
      [[x.tenant.id, y.tenant.id]],
    );
    expect(audit.rows).toEqual([{ tenant_id: x.tenant.id }]);
  });
});

// ═══ (f) single use and expiry ══════════════════════════════════════════════

describe('(f) an invite token is single use and expires', () => {
  it('single use: a second claim of the same token loses with 409 claimed, and binds nothing new', async () => {
    const ws = await workspace('f1');
    const { stub, token } = await stubInvite(ws);
    identity('tok-f1a', { uid: 'fb-f1a', email: stub.email, email_verified: true });
    identity('tok-f1b', { uid: 'fb-f1b', email: 'thief@evil.test', email_verified: true });

    expect((await claim(token, 'tok-f1a')).statusCode).toBe(200);
    const second = await claim(token, 'tok-f1b');

    expect(second.statusCode).toBe(409);
    expect(second.json().status).toBe('claimed');
    expect((await userRow(stub.id)).firebase_uid).toBe('fb-f1a');
  });

  it('single use under contention: two concurrent claims, exactly one winner', async () => {
    const ws = await workspace('f2');
    const { stub, token, membership } = await stubInvite(ws);
    identity('tok-f2a', { uid: 'fb-f2a', email: stub.email, email_verified: true });
    identity('tok-f2b', { uid: 'fb-f2b', email: stub.email, email_verified: true });

    const results = await Promise.all([claim(token, 'tok-f2a'), claim(token, 'tok-f2b')]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = results.find((r) => r.statusCode === 200)!;
    expect((await userRow(stub.id)).firebase_uid).toBe(winner.json().user.firebase_uid);
    expect((await inviteRows(membership.id)).filter((r) => r.claimed_at !== null)).toHaveLength(1);
  });

  it('expiry: an expired token answers 409 expired and binds nothing', async () => {
    const ws = await workspace('f3');
    const { stub, token } = await stubInvite(ws, { expiresAt: new Date(Date.now() - 60_000) });
    identity('tok-f3', { uid: 'fb-f3', email: stub.email, email_verified: true });

    const res = await claim(token, 'tok-f3');

    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe('expired');
    expect((await userRow(stub.id)).firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);
  });

  it('expiry inside the claim statement: a TTL that lapsed after the read is refused by the claim itself', async () => {
    // The route reads the invite, then claims. This calls the claim directly on a
    // row whose TTL has already lapsed — the state a request sees if expiry falls
    // between its read and its write — so only the statement's own predicate can
    // refuse it.
    const ws = await workspace('f4');
    const { stub, invite } = await stubInvite(ws, { expiresAt: new Date(Date.now() - 1_000) });

    const result = await membershipInviteRepository.claimWithIdentity({
      inviteId: invite.id, userId: stub.id, tenantId: ws.tenant.id,
      identity: { uid: 'fb-f4', email: stub.email, email_verified: true },
    });

    expect(result).toEqual({ ok: false, reason: 'expired' });
    expect((await userRow(stub.id)).firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(true);
    expect((await getTestPool().query(`SELECT claimed_at FROM membership_invites WHERE id = $1`, [invite.id])).rows[0].claimed_at).toBeNull();
  });
});

// ═══ (g) the auth chain on every authenticated route ════════════════════════

describe('(g) every authenticated invite/user route runs session → tenant context → RBAC', () => {
  const PUBLIC = new Set(['/invites/:token', '/invites/:token/claim']);
  const authenticated = () => registered
    .filter((r) => r.method !== 'HEAD' && !PUBLIC.has(r.url))
    .map((r) => `${r.method} ${r.url}`)
    .sort();

  it('the authenticated route set is exactly the four this audit covers (a new route fails here)', () => {
    expect([...new Set(authenticated())]).toEqual([
      'DELETE /users/:id/membership',
      'POST /invites/resend',
      'POST /users/invite',
      'PUT /users/:id/role',
    ]);
  });

  const ROUTES: { method: 'POST' | 'PUT' | 'DELETE'; url: string; permission: string; payload?: object }[] = [
    { method: 'POST', url: '/users/invite', permission: 'user.invite', payload: { email: 'x@corp.test', role: 'agent' } },
    { method: 'PUT', url: `/users/${randomUUID()}/role`, permission: 'user.update_role', payload: { role: 'viewer' } },
    { method: 'DELETE', url: `/users/${randomUUID()}/membership`, permission: 'user.remove' },
    { method: 'POST', url: '/invites/resend', permission: 'user.invite', payload: { membership_id: randomUUID() } },
  ];

  it.each(ROUTES)('$method $url: no token → 401 and neither the user nor the membership lookup runs', async (route) => {
    const ws = await workspace('g1');
    const userLookup = vi.spyOn(userRepository, 'findByFirebaseUid');
    const membershipLookup = vi.spyOn(membershipRepository, 'findByUserAndTenant');
    try {
      const res = await app.inject({
        method: route.method, url: route.url, headers: { 'x-tenant-id': ws.tenant.id }, payload: route.payload,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'Unauthorized', message: 'Missing authentication. Provide a Bearer token.' });
      expect(userLookup).not.toHaveBeenCalled();
      expect(membershipLookup).not.toHaveBeenCalled();
    } finally {
      userLookup.mockRestore();
      membershipLookup.mockRestore();
    }
  });

  it.each(ROUTES)('$method $url: a signed-in user with NO membership → tenant-context 403, before RBAC', async (route) => {
    const ws = await workspace('g2');
    const outsider = await insertUser({ firebase_uid: 'fb-outsider', email: 'outsider@else.test' });
    const auth = identity('tok-outsider', { uid: 'fb-outsider', email: outsider.email, email_verified: true });
    const membershipLookup = vi.spyOn(membershipRepository, 'findByUserAndTenant');
    try {
      const res = await app.inject({ method: route.method, url: route.url, headers: as(ws, auth), payload: route.payload });
      expect(res.statusCode).toBe(403);
      // The tenant-context middleware's body, not RBAC's ("No active membership
      // found for this context" / "Insufficient permissions …").
      expect(res.json()).toEqual({ error: 'Forbidden', message: 'You are not a member of this tenant' });
      expect(membershipLookup).toHaveBeenCalledWith(outsider.id, ws.tenant.id);
    } finally {
      membershipLookup.mockRestore();
    }
  });

  it.each(ROUTES)('$method $url: a member below the floor (operator) → the RBAC 403 for its permission', async (route) => {
    const ws = await workspace('g3');
    const operator = await member(ws, 'operator', null);
    const before = await countRows('memberships');

    const res = await app.inject({ method: route.method, url: route.url, headers: as(ws, operator.auth), payload: route.payload });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: `Insufficient permissions. Required: ${route.permission}` });
    expect(await countRows('memberships')).toBe(before);
  });
});

// ═══ (h) what the PUBLIC routes disclose ════════════════════════════════════

describe('(h) the public routes disclose nothing beyond status, except for a pending invite', () => {
  const MESSAGES = {
    claimed: 'This invitation has already been used. Sign in to continue.',
    expired: 'This invitation has expired. Ask whoever invited you to send a new one.',
    revoked:
      'This invitation is no longer valid — a newer one may have been sent. Check your inbox, '
      + 'or ask whoever invited you to send another.',
  } as const;

  type Shape = 'unknown' | 'expired' | 'claimed' | 'revoked' | 'membership_revoked';

  /** A token in each refused state, built on real rows. */
  async function tokenIn(shape: Shape): Promise<string> {
    const ws = await workspace(`h-${shape}`);
    if (shape === 'unknown') return (await mintInviteToken()).token;
    const { token, invite, membership } = await stubInvite(ws, {
      expiresAt: shape === 'expired' ? new Date(Date.now() - 60_000) : undefined,
    });
    const pool = getTestPool();
    if (shape === 'claimed') await pool.query(`UPDATE membership_invites SET claimed_at = now() WHERE id = $1`, [invite.id]);
    if (shape === 'revoked') await pool.query(`UPDATE membership_invites SET revoked_at = now() WHERE id = $1`, [invite.id]);
    if (shape === 'membership_revoked') await pool.query(`UPDATE memberships SET status = 'revoked' WHERE id = $1`, [membership.id]);
    return token;
  }

  const GET_BODIES: [Shape, number, object][] = [
    ['unknown', 404, { status: 'not_found' }],
    ['expired', 200, { status: 'expired' }],
    ['claimed', 200, { status: 'claimed' }],
    ['revoked', 200, { status: 'revoked' }],
    ['membership_revoked', 200, { status: 'revoked' }],
  ];

  it.each(GET_BODIES)('GET /invites/:token for a %s token answers %i with exactly %j', async (shape, status, body) => {
    const token = await tokenIn(shape);
    const res = await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toStrictEqual(body);
  });

  const CLAIM_BODIES: [Shape, number, object][] = [
    ['unknown', 404, { status: 'not_found' }],
    ['expired', 409, { error: 'Conflict', message: MESSAGES.expired, status: 'expired' }],
    ['claimed', 409, { error: 'Conflict', message: MESSAGES.claimed, status: 'claimed' }],
    ['revoked', 409, { error: 'Conflict', message: MESSAGES.revoked, status: 'revoked' }],
    ['membership_revoked', 409, { error: 'Conflict', message: MESSAGES.revoked, status: 'revoked' }],
  ];

  it.each(CLAIM_BODIES)('POST /invites/:token/claim for a %s token answers %i with exactly %j', async (shape, status, body) => {
    const token = await tokenIn(shape);
    identity('tok-h', { uid: 'fb-h', email: 'h@corp.test', email_verified: true });
    const res = await claim(token, 'tok-h');
    expect(res.statusCode).toBe(status);
    expect(res.json()).toStrictEqual(body);
  });

  it('GET /invites/:token for a PENDING invite returns exactly master\'s invite object', async () => {
    const ws = await workspace('h-pending');
    const { token, invite, email } = await stubInvite(ws);

    const res = await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(token)}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toStrictEqual({
      status: 'pending',
      invite: {
        email,
        role: 'agent',
        tenant_name: ws.tenant.name,
        inviter_name: ws.owner.display_name,
        product_name: expect.any(String),
        expires_at: new Date(invite.expires_at).toISOString(),
      },
    });
  });
});
