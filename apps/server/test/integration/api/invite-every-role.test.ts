import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

/**
 * Invitations for EVERY role, end to end, on real Postgres 5436 and real Redis
 * 6383: issue → mail → `GET /invites/:token` → `POST /invites/:token/claim`.
 *
 * ── The defect this suite exists for ───────────────────────────────────────
 * Invite emails were sent for `agent` only. Every other role — `viewer`,
 * `operator`, `account_admin`, and the `tenant_admin` a super admin adds — got
 * `invite_email: { sent: false, reason: 'not_implemented' }`, no token, no
 * `membership_invites` row and no mail, so invited operators and admins never
 * heard about their invitation. Production metrics showed it; no test did,
 * because every suite here pinned the agent path and asserted the rest as a
 * feature.
 *
 * ── What is real and what is doubled ───────────────────────────────────────
 * Real: the session, tenant-context and RBAC middlewares, every repository, the
 * issuer, the token, the URL rule, the templates, the Mailjet client, the claim
 * transaction and the session payload. Doubled, and only at the process edge:
 *
 *  - **Firebase** `verifyIdToken` — a token string maps to a decoded identity, as
 *    every suite here does.
 *  - **`fetch`**, for `https://api.mailjet.com/v3.1/send` only. The stub records
 *    the request body the real `mailjet.client.ts` built and answers as Mailjet
 *    does; ANY other URL throws, so nothing in this suite can reach the network.
 *    That is what lets these cases assert on the mail a person would actually
 *    receive — its recipient, subject and link — rather than on a mocked mailer
 *    that agrees with whatever it is handed.
 */

const ENV = vi.hoisted(() => {
  // Config is frozen at first import, so every value it reads is set before any
  // module loads. A Mailjet block makes the transport "configured"; the stubbed
  // `fetch` below is what it reaches.
  process.env['CONSOLE_BASE_URL'] = 'https://console.invite.test';
  process.env['MAILJET_API_KEY'] = 'mj-key';
  process.env['MAILJET_API_SECRET'] = 'mj-secret';
  process.env['MAILJET_FROM_EMAIL'] = 'invites@agency.test';
  process.env['MAILJET_FROM_NAME'] = 'Invites';
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'invite-every-role-super-secret';
  return { origin: 'https://console.invite.test' };
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
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { getTestRedis, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });

const { config } = await import('../../../src/config/index.js');
const { redisCache } = await import('../../../src/cache/redis-cache.js');
const { userRoutes } = await import('../../../src/api/routes/user.routes.js');
const { inviteRoutes } = await import('../../../src/api/routes/invites.routes.js');
const { superAdminRoutes } = await import('../../../src/api/routes/super-admin.routes.js');
const { hashInviteToken } = await import('../../../src/notifications/invite-token.js');
const { platformAuditLogger } = await import('../../../src/audit/platform/audit-logger.js');
const { PENDING_UID_PREFIX } = await import('../../../src/auth/firebase-identity.js');

const MAILJET_URL = 'https://api.mailjet.com/v3.1/send';

/** What `mailjet.client.ts` POSTs, as Mailjet's v3.1 API defines it. */
interface MailjetMessage {
  From: { Email: string; Name: string };
  To: { Email: string }[];
  Subject: string;
  TextPart: string;
  HTMLPart: string;
}

/** Every Mailjet send since the last reset, in order. */
const sent: MailjetMessage[] = [];
/** The status the next Mailjet call answers with; 200 unless a case says otherwise. */
let mailjetStatus = 200;

const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url !== MAILJET_URL) {
    // Loud, so a code path that starts calling something new fails here rather
    // than quietly reaching the network from a test run.
    throw new Error(`invite-every-role: unexpected outbound request to ${url}`);
  }
  const body = JSON.parse(String(init?.body)) as { Messages: MailjetMessage[] };
  sent.push(...body.Messages);
  const ok = mailjetStatus >= 200 && mailjetStatus < 300;
  return new Response(
    JSON.stringify(ok
      ? { Messages: body.Messages.map((m) => ({ Status: 'success', To: m.To.map((t) => ({ Email: t.Email, MessageUUID: randomUUID() })) })) }
      : { ErrorMessage: 'refused' }),
    { status: mailjetStatus, headers: { 'Content-Type': 'application/json' } },
  );
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(inviteRoutes, { prefix: '/invites' });
  await app.register(superAdminRoutes, { prefix: '/super-admin' });
  await app.ready();
  return app;
}

let app: FastifyInstance;

function identity(token: string, decoded: { uid: string; email?: string | null; email_verified?: boolean; name?: string }) {
  mocks.identities.set(token, { name: 'Somebody', ...decoded });
  return { authorization: `Bearer ${token}` };
}

interface Workspace {
  tenant: { id: string; name: string };
  account: { id: string };
  ownerAuth: Record<string, string>;
}

async function workspace(label: string): Promise<Workspace> {
  const tenant = await insertTenant({ name: `${label} Holdings` });
  const account = await insertAccount({ tenant_id: tenant.id });
  const uid = `fb-owner-${label}-${randomUUID().slice(0, 6)}`;
  const owner = await insertUser({ firebase_uid: uid, email: `owner-${uid}@corp.test`, display_name: `${label} Owner` });
  await insertMembership({ user_id: owner.id, tenant_id: tenant.id, account_id: null, role: 'tenant_owner' });
  return { tenant, account, ownerAuth: identity(`tok-${uid}`, { uid, email: owner.email, email_verified: true }) };
}

/** A real, signed-in member of `ws` with `role`. */
async function member(ws: Workspace, role: string, accountId: string | null) {
  const uid = `fb-${role}-${randomUUID().slice(0, 8)}`;
  const user = await insertUser({ firebase_uid: uid, email: `${uid}@corp.test`, display_name: 'Pat Inviter' });
  await insertMembership({ user_id: user.id, tenant_id: ws.tenant.id, account_id: accountId, role });
  return { user, auth: identity(`tok-${uid}`, { uid, email: user.email, email_verified: true }) };
}

function as(ws: Workspace, auth: Record<string, string>) {
  return { ...auth, 'x-tenant-id': ws.tenant.id };
}

/** The raw token out of a claim-page link, for either claim page. */
function tokenOf(link: string): string {
  const match = /\/(?:agency\/)?join\/([^/?#]+)$/.exec(link);
  if (!match) throw new Error(`not a claim-page link: ${link}`);
  return decodeURIComponent(match[1]!);
}

/** The single claim-page link inside a mail part. */
function linkIn(part: string): string {
  const match = /https:\/\/console\.invite\.test\/(?:agency\/)?join\/[A-Za-z0-9_%-]+/.exec(part);
  if (!match) throw new Error('no claim-page link in the mail');
  return match[0];
}

function claim(token: string, idToken: string) {
  return app.inject({
    method: 'POST', url: `/invites/${encodeURIComponent(token)}/claim`, payload: { id_token: idToken },
  });
}

async function inviteRows(membershipId: string) {
  const { rows } = await getTestPool().query(
    `SELECT id, role, email, token_hash, claimed_at, claimed_by_user_id, revoked_at
       FROM membership_invites WHERE membership_id = $1 ORDER BY created_at`,
    [membershipId],
  );
  return rows as {
    id: string; role: string; email: string; token_hash: string;
    claimed_at: Date | null; claimed_by_user_id: string | null; revoked_at: Date | null;
  }[];
}

async function userRow(id: string) {
  const { rows } = await getTestPool().query(`SELECT id, firebase_uid, email FROM users WHERE id = $1`, [id]);
  return rows[0] as { id: string; firebase_uid: string; email: string };
}

async function membershipRow(id: string) {
  const { rows } = await getTestPool().query(`SELECT id, role, status, tenant_id FROM memberships WHERE id = $1`, [id]);
  return rows[0] as { id: string; role: string; status: string; tenant_id: string };
}

const auditWrites = trackSuperAdminAuditWrites();

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchStub);
  redisCache.init(getTestRedis());
  app = await buildApp();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  sent.length = 0;
  mailjetStatus = 200;
  fetchStub.mockClear();
});

afterEach(async () => {
  await auditWrites.drain();
});

afterAll(async () => {
  auditWrites.restore();
  vi.unstubAllGlobals();
  await app?.close();
  await platformAuditLogger.shutdown();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

describe('an operator invited by an account admin: issue, mail, read, claim', () => {
  it('mails a /join link, stores the row, describes it as an operator invite, and the claim activates it', async () => {
    const ws = await workspace('op');
    const admin = await member(ws, 'account_admin', ws.account.id);

    // ── issue ──────────────────────────────────────────────────────────────
    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, admin.auth),
      payload: { email: 'new.operator@corp.test', role: 'operator', account_id: ws.account.id },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    // THE regression: this was `{ sent: false, reason: 'not_implemented' }`.
    expect(body.invite_email).toEqual({ sent: true });
    expect(body.sign_in_url).toMatch(new RegExp(`^${ENV.origin}/join/[A-Za-z0-9_-]{43}$`));
    const token = tokenOf(body.sign_in_url);

    // ── the row ────────────────────────────────────────────────────────────
    const rows = await inviteRows(body.membership.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: 'operator', email: 'new.operator@corp.test', claimed_at: null, revoked_at: null,
    });
    expect(rows[0]!.token_hash).toBe(hashInviteToken(token));

    // ── the mail, as Mailjet received it ───────────────────────────────────
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.To).toEqual([{ Email: 'new.operator@corp.test' }]);
    expect(mail.Subject).toBe(`You've been added to ${config.brand.name}`);
    // The link in BOTH parts is the one on the response, which is the one the
    // row was hashed from — a mail whose link disagreed with the supervisor's
    // screen would be unfalsifiable from a bug report.
    expect(linkIn(mail.TextPart)).toBe(body.sign_in_url);
    expect(linkIn(mail.HTMLPart)).toBe(body.sign_in_url);
    expect(mail.TextPart.split('\n')).toContain(body.sign_in_url);
    expect(mail.HTMLPart).toContain(`href="${body.sign_in_url}"`);
    expect(mail.TextPart).not.toContain('/agency/join/');
    expect(mail.TextPart).toContain(`Pat Inviter has set you up as an Operator at ${ws.tenant.name}.`);
    expect(mail.TextPart).not.toMatch(/station|dialer|campaign/i);

    // ── the claim page's read ──────────────────────────────────────────────
    const read = await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(token)}` });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual({
      status: 'pending',
      invite: {
        email: 'new.operator@corp.test',
        role: 'operator',
        tenant_name: ws.tenant.name,
        inviter_name: 'Pat Inviter',
        // The same noun the subject named.
        product_name: config.brand.name,
        expires_at: expect.any(String),
      },
    });

    // ── the claim, with a different Google address (the token is the authority) ──
    identity('tok-new-operator', { uid: 'fb-new-operator', email: 'personal@gmail.test', email_verified: true });
    const claimed = await claim(token, 'tok-new-operator');
    expect(claimed.statusCode, claimed.body).toBe(200);
    const session = claimed.json();
    expect(session.is_new).toBe(false);
    expect(session.user.id).toBe(body.user.id);
    expect(session.memberships).toEqual([
      expect.objectContaining({ id: body.membership.id, tenant_id: ws.tenant.id, role: 'operator', status: 'active' }),
    ]);

    // The identity is bound, the invitation spent, the membership untouched.
    expect((await userRow(body.user.id)).firebase_uid).toBe('fb-new-operator');
    const [after] = await inviteRows(body.membership.id);
    expect(after!.claimed_at).not.toBeNull();
    expect(after!.claimed_by_user_id).toBe(body.user.id);
    expect(await membershipRow(body.membership.id)).toMatchObject({ role: 'operator', status: 'active' });

    // Single use, for an operator as for an agent.
    const again = await claim(token, 'tok-new-operator');
    expect(again.statusCode).toBe(409);
    expect(again.json().status).toBe('claimed');
  });
});

describe('every role POST /users/invite can grant gets a token, a row and a mail', () => {
  it.each([
    ['agent', '/agency/join/', `You've been added to the `, 'as an Agent at'],
    ['viewer', '/join/', `You've been added to `, 'as a Viewer at'],
    ['operator', '/join/', `You've been added to `, 'as an Operator at'],
    ['account_admin', '/join/', `You've been added to `, 'as an Account admin at'],
  ])('%s → %s', async (role, path, subjectStart, roleSentence) => {
    const ws = await workspace(`all-${role}`);
    const email = `invitee-${role}@corp.test`;

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
      payload: { email, role, account_id: ws.account.id },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invite_email).toEqual({ sent: true });
    const link = res.json().sign_in_url as string;
    expect(link.startsWith(`${ENV.origin}${path}`)).toBe(true);
    // `/join/` is a suffix of `/agency/join/`, so the non-agent half is asserted
    // the other way round too.
    if (role !== 'agent') expect(link).not.toContain('/agency/');

    const rows = await inviteRows(res.json().membership.id);
    expect(rows).toEqual([expect.objectContaining({ role, email, token_hash: hashInviteToken(tokenOf(link)) })]);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.To).toEqual([{ Email: email }]);
    expect(sent[0]!.Subject.startsWith(subjectStart)).toBe(true);
    expect(sent[0]!.TextPart).toContain(roleSentence);
    expect(linkIn(sent[0]!.TextPart)).toBe(link);

    const read = await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(tokenOf(link))}` });
    expect(read.json()).toMatchObject({ status: 'pending', invite: { role, email } });
  });
});

describe('resend for a non-agent', () => {
  it('re-mails an account admin a fresh /join link and revokes the old one', async () => {
    const ws = await workspace('resend');
    const first = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
      payload: { email: 'admin.resent@corp.test', role: 'account_admin', account_id: ws.account.id },
    });
    expect(first.statusCode, first.body).toBe(201);
    const oldToken = tokenOf(first.json().sign_in_url);

    const resend = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, ws.ownerAuth),
      payload: { membership_id: first.json().membership.id },
    });

    expect(resend.statusCode, resend.body).toBe(200);
    expect(resend.json().invite_email).toEqual({ sent: true });
    const newLink = resend.json().sign_in_url as string;
    expect(newLink).toMatch(new RegExp(`^${ENV.origin}/join/[A-Za-z0-9_-]{43}$`));
    const newToken = tokenOf(newLink);
    expect(newToken).not.toBe(oldToken);

    // Two mails, to the same person, the second carrying the NEW link.
    expect(sent.map((m) => m.To[0]!.Email)).toEqual(['admin.resent@corp.test', 'admin.resent@corp.test']);
    expect(linkIn(sent[1]!.TextPart)).toBe(newLink);
    expect(sent[1]!.TextPart).toContain('as an Account admin at');

    const rows = await inviteRows(first.json().membership.id);
    expect(rows.map((r) => [r.role, r.revoked_at === null])).toEqual([['account_admin', false], ['account_admin', true]]);

    expect((await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(oldToken)}` })).json())
      .toEqual({ status: 'revoked' });
    identity('tok-admin-resent', { uid: 'fb-admin-resent', email: 'admin.resent@corp.test', email_verified: true });
    const stale = await claim(oldToken, 'tok-admin-resent');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().status).toBe('revoked');
    const fresh = await claim(newToken, 'tok-admin-resent');
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().memberships.map((m: { role: string }) => m.role)).toEqual(['account_admin']);
  });

  it('refuses an account admin resending for a peer account admin — the gate is live now', async () => {
    // Before every role had a token this gate never refused anything (only the
    // lowest role was ever issued one). Now it is what stops an admin minting a
    // binding link for a role they could not have created.
    const ws = await workspace('peer');
    const first = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
      payload: { email: 'peer.admin@corp.test', role: 'account_admin', account_id: ws.account.id },
    });
    const admin = await member(ws, 'account_admin', ws.account.id);
    sent.length = 0;

    const res = await app.inject({
      method: 'POST', url: '/invites/resend', headers: as(ws, admin.auth),
      payload: { membership_id: first.json().membership.id },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('/join/');
    expect(sent).toHaveLength(0);
    expect(await inviteRows(first.json().membership.id)).toHaveLength(1);
  });
});

describe('a refusing transport, for a non-agent', () => {
  it('still answers 201 with the link, keeps the row, and reports failed', async () => {
    const ws = await workspace('refused');
    mailjetStatus = 500;

    const res = await app.inject({
      method: 'POST', url: '/users/invite', headers: as(ws, ws.ownerAuth),
      payload: { email: 'unlucky.viewer@corp.test', role: 'viewer', account_id: ws.account.id },
    });

    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().invite_email).toEqual({ sent: false, reason: 'failed' });
    // The link survives the failed send — it is the supervisor's fallback.
    expect(res.json().sign_in_url).toMatch(new RegExp(`^${ENV.origin}/join/`));
    expect(await inviteRows(res.json().membership.id)).toHaveLength(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe('super-admin add-user for a non-agent', () => {
  async function superAdminToken(): Promise<string> {
    await getTestPool().query(
      `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, $2, $3, $4, 'active')`,
      [randomUUID(), 'root@platform.test', await bcrypt.hash('RootPassword123!', 10), 'Root'],
    );
    const res = await app.inject({
      method: 'POST', url: '/super-admin/login', payload: { email: 'root@platform.test', password: 'RootPassword123!' },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().token as string;
  }

  it('mails a workspace admin a /join link; the claim makes them an admin who can invite', async () => {
    const tenant = await insertTenant({ name: 'Provisioned Ltd' });
    const token = await superAdminToken();

    const res = await app.inject({
      method: 'POST', url: `/super-admin/tenants/${tenant.id}/users`,
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'first.admin@provisioned.test', role: 'tenant_admin', name: 'First Admin' },
    });

    expect(res.statusCode, res.body).toBe(201);
    const membershipId = res.json().membership.id as string;
    const rows = await inviteRows(membershipId);
    expect(rows).toEqual([expect.objectContaining({ role: 'tenant_admin', email: 'first.admin@provisioned.test' })]);

    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.To).toEqual([{ Email: 'first.admin@provisioned.test' }]);
    expect(mail.Subject).toBe(`You've been added to ${config.brand.name}`);
    // No inviter: a super admin is not a `users` row, so the sentence drops the actor.
    expect(mail.TextPart).toContain('You have been set up as a Workspace admin at Provisioned Ltd.');
    const link = linkIn(mail.TextPart);
    expect(link).toMatch(new RegExp(`^${ENV.origin}/join/`));
    expect(rows[0]!.token_hash).toBe(hashInviteToken(tokenOf(link)));

    const read = await app.inject({ method: 'GET', url: `/invites/${encodeURIComponent(tokenOf(link))}` });
    expect(read.json()).toMatchObject({
      status: 'pending',
      invite: { role: 'tenant_admin', tenant_name: 'Provisioned Ltd', inviter_name: null, product_name: config.brand.name },
    });

    const auth = identity('tok-first-admin', { uid: 'fb-first-admin', email: 'first.admin@provisioned.test', email_verified: true });
    const claimed = await claim(tokenOf(link), 'tok-first-admin');
    expect(claimed.statusCode, claimed.body).toBe(200);
    expect(claimed.json().memberships).toEqual([
      expect.objectContaining({ id: membershipId, role: 'tenant_admin', status: 'active' }),
    ]);
    const user = await userRow(claimed.json().user.id);
    expect(user.firebase_uid).toBe('fb-first-admin');
    expect(user.firebase_uid.startsWith(PENDING_UID_PREFIX)).toBe(false);

    // The membership the claim activated works through the REAL session,
    // tenant-context and RBAC chain: the new admin can invite somebody, and that
    // invitee is mailed too.
    sent.length = 0;
    const next = await app.inject({
      method: 'POST', url: '/users/invite',
      headers: { ...auth, 'x-tenant-id': tenant.id },
      payload: { email: 'their.operator@provisioned.test', role: 'operator' },
    });
    expect(next.statusCode, next.body).toBe(201);
    expect(next.json().invite_email).toEqual({ sent: true });
    expect(sent.map((m) => m.To[0]!.Email)).toEqual(['their.operator@provisioned.test']);
    expect(sent[0]!.TextPart).toContain('First Admin has set you up as an Operator at Provisioned Ltd.');
  });
});
