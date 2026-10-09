import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * `/invites` — the token-bound invitation claim flow (migration 069).
 *
 * ── The defect this feature removes, restated so the cases read as its parts ─
 * `POST /users/invite` writes a membership and, for an unknown address, a stub
 * user whose `firebase_uid` is `pending_<uuid>`. The ONLY thing that used to
 * bind an invitee to that stub was an EMAIL MATCH in `POST /auth/session` path
 * 2. An invitee who signed up with a different address fell through to path 4
 * instead — a brand-new private tenant, a default account, a signup credit
 * bonus, a fresh platform API key — while the membership somebody deliberately
 * created sat unclaimed and nothing told anyone.
 *
 * Three properties replace that, and each has cases below:
 *
 *  1. **The TOKEN is the authority.** The user is resolved through
 *     `invite.membership_id → memberships.user_id`, never by address —
 *     `users.email` carries only a non-unique index (`001_initial_schema.sql:60`),
 *     so an email lookup is not even a unique operation.
 *  2. **A mismatched address still binds, and is AUDITED.** Refusing would lock
 *     out exactly the agent this feature exists for. The audit row is the
 *     compensating control, and it is the only place the discrepancy survives —
 *     `memberships` and `users` retain no trace of it afterwards.
 *  3. **Nothing is ever provisioned.** No tenant, no account, no membership, no
 *     credit balance, no platform API key. Asserted as a property over the whole
 *     module rather than case by case, because the failure mode is a branch
 *     somebody ADDS later.
 *
 * ── Why the routes are unauthenticated ────────────────────────────────────
 * The caller has no account, no session and no tenant; that is the state an
 * invitation exists to end. So there is no `sessionMiddleware` on the plugin,
 * every tenant comes off the INVITE ROW rather than a header, and the only abuse
 * control is a dedicated IP bucket. `POST /invites/resend` is the exception and
 * carries the full chain per-route, which the last block asserts.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = 'aaaaaaaa-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const MEMBERSHIP = '33333333-3333-4333-8333-333333333333';
const STUB_USER = '44444444-4444-4444-8444-444444444444';
const INVITER = '55555555-5555-4555-8555-555555555555';
const INVITE_ID = '66666666-6666-4666-8666-666666666666';
const TOKEN = 'tok-abcdef';
const INVITED_EMAIL = 'newagent@acme.test';

const mocks = vi.hoisted(() => ({
  config: {
    brand: { name: 'Magick Agency', accent: '#7c5cfc' },
    invites: { tokenTtlDays: 7 },
    consoleBaseUrl: 'https://app.example.com',
  },
  verifyIdToken: vi.fn(),
  membershipInviteRepository: {
    findByTokenHash: vi.fn(),
    claimWithIdentity: vi.fn(),
    createSupersedingOutstanding: vi.fn(),
  },
  membershipRepository: { findByIdInTenant: vi.fn() },
  tenantRepository: { findById: vi.fn(), listByUserId: vi.fn() },
  userRepository: { findById: vi.fn() },
  membershipListRepository: { findAllByUserId: vi.fn() },
  redisCache: { del: vi.fn().mockResolvedValue(undefined) },
  invalidateUserCache: vi.fn().mockResolvedValue(undefined),
  buildSessionPayload: vi.fn(),
  issueInvite: vi.fn(),
  auditLog: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('../../../../src/auth/firebase.js', () => ({ verifyIdToken: mocks.verifyIdToken }));
vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: any) => { request.user = { id: INVITER }; },
  invalidateUserCache: mocks.invalidateUserCache,
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: any) => {
    request.tenantId = request.headers['x-tenant-id'] ?? TENANT;
    request.membership = { role: 'account_admin', account_id: request.headers['x-scope'] ?? null };
  },
}));
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
/**
 * The repository is doubled, but `LiveInviteConflictError` comes from the REAL
 * module: the resend route catches it by `instanceof`, so a locally-invented
 * stand-in would let a rename or a re-export mistake pass here while the running
 * route fell through to a masked 500.
 */
vi.mock('../../../../src/db/repositories/membership-invite.repository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/db/repositories/membership-invite.repository.js')
  >('../../../../src/db/repositories/membership-invite.repository.js');
  return {
    ...actual,
    membershipInviteRepository: mocks.membershipInviteRepository,
  };
});
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: {
    findByIdInTenant: mocks.membershipRepository.findByIdInTenant,
    findAllByUserId: mocks.membershipListRepository.findAllByUserId,
  },
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepository,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: mocks.userRepository,
}));
// Q5: `delForRevocation` forwards to the `del` mock and reports success.
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  redisCache: { ...mocks.redisCache, delForRevocation: async (...k: string[]) => { await mocks.redisCache.del(...k); return true; } },
}));
/**
 * The session body is mocked so these cases assert the CLAIM, not the login
 * lookups — but its identity is checked: `buildSessionPayload` is the shared
 * function `POST /auth/session` answers with, and using anything else here would
 * be the second `SessionResponse` shape this route exists to avoid.
 */
vi.mock('../../../../src/auth/session-payload.js', () => ({
  buildSessionPayload: mocks.buildSessionPayload,
}));
vi.mock('../../../../src/invites/invite-issuer.js', () => ({ issueInvite: mocks.issueInvite }));
vi.mock('../../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inviteRoutes } from '../../../../src/api/routes/invites.routes.js';
import { LiveInviteConflictError } from '../../../../src/db/repositories/membership-invite.repository.js';
import { hashInviteToken } from '../../../../src/notifications/invite-token.js';

const HOUR = 60 * 60 * 1000;

function pendingInvite(overrides: Record<string, unknown> = {}) {
  return {
    id: INVITE_ID,
    membership_id: MEMBERSHIP,
    tenant_id: TENANT,
    email: INVITED_EMAIL,
    role: 'agent',
    token_hash: hashInviteToken(TOKEN),
    expires_at: new Date(Date.now() + 48 * HOUR),
    claimed_at: null,
    claimed_by_user_id: null,
    revoked_at: null,
    invited_by: INVITER,
    created_at: new Date(),
    ...overrides,
  };
}

function activeMembership(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERSHIP,
    user_id: STUB_USER,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    role: 'agent',
    status: 'active',
    ...overrides,
  };
}

const BOUND_USER = {
  id: STUB_USER,
  firebase_uid: 'fb-real',
  email: INVITED_EMAIL,
  display_name: 'New Agent',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(inviteRoutes, { prefix: '/invites' });
  await app.ready();
  return app;
}

function claim(app: FastifyInstance, body: unknown = { id_token: 'fb-token' }) {
  return app.inject({ method: 'POST', url: `/invites/${TOKEN}/claim`, payload: body as any });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redisCache.del.mockResolvedValue(undefined);
  mocks.invalidateUserCache.mockResolvedValue(undefined);
  mocks.verifyIdToken.mockResolvedValue({
    uid: 'fb-real', email: INVITED_EMAIL, name: 'New Agent', email_verified: true,
  });
  mocks.membershipInviteRepository.findByTokenHash.mockResolvedValue(pendingInvite());
  mocks.membershipInviteRepository.claimWithIdentity.mockResolvedValue({ ok: true, user: BOUND_USER });
  mocks.membershipRepository.findByIdInTenant.mockResolvedValue(activeMembership());
  mocks.userRepository.findById.mockResolvedValue({
    id: STUB_USER, firebase_uid: `pending_${STUB_USER}`, email: INVITED_EMAIL, display_name: null,
  });
  mocks.tenantRepository.findById.mockResolvedValue({ id: TENANT, name: 'Acme Collections' });
  mocks.buildSessionPayload.mockResolvedValue({
    user: BOUND_USER, tenants: [], memberships: [], governance: {}, is_new: false,
  });
  mocks.issueInvite.mockResolvedValue({
    invite: { id: 'invite-2' },
    signInUrl: 'https://app.example.com/agency/join/tok-new',
    inviteEmail: { sent: true, messageId: null },
  });
});

describe('GET /invites/:token', () => {
  it('describes a pending invitation, resolving the tenant and the inviter', async () => {
    /**
     * This is rendered before any sign-in, so the recipient can see who invited
     * them and to what before handing over an identity. An invitation that asks
     * somebody to authenticate without first saying what they are joining is
     * indistinguishable from a phishing mail — and this is the one page in the
     * product that a person reaches by clicking a link in an email.
     */
    mocks.userRepository.findById.mockResolvedValue({ id: INVITER, display_name: 'Priya Sharma' });
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending',
      invite: {
        email: INVITED_EMAIL,
        role: 'agent',
        tenant_name: 'Acme Collections',
        inviter_name: 'Priya Sharma',
        product_name: 'Magick Agency Dialer',
      },
    });
    expect(res.json().invite.expires_at).toBeTruthy();
    await app.close();
  });

  it('looks the token up by HASH, never by the raw value', async () => {
    // The raw token exists exactly once, in the email. A query by the raw value
    // would mean the column stores it, which makes a database dump replayable.
    const app = await buildApp();

    await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(mocks.membershipInviteRepository.findByTokenHash)
      .toHaveBeenCalledWith(hashInviteToken(TOKEN));
    expect(mocks.membershipInviteRepository.findByTokenHash).not.toHaveBeenCalledWith(TOKEN);
    await app.close();
  });

  it('discloses nothing beyond what the recipient needs to recognise it', async () => {
    /**
     * To a caller who already holds a 256-bit token mailed to that address.
     * Deliberately absent: the membership id, the account, the user id, the
     * tenant id, and the inviter's address — the last of which would disclose a
     * supervisor's email to somebody who is not yet a member of anything.
     */
    mocks.userRepository.findById.mockResolvedValue({
      id: INVITER, display_name: 'Priya Sharma', email: 'priya@acme.test',
    });
    const app = await buildApp();

    const body = JSON.stringify((await app.inject({ method: 'GET', url: `/invites/${TOKEN}` })).json());

    expect(body).not.toContain(MEMBERSHIP);
    expect(body).not.toContain(STUB_USER);
    expect(body).not.toContain(ACCOUNT);
    expect(body).not.toContain('priya@acme.test');
    await app.close();
  });

  it('answers 404 for an unknown token', async () => {
    // Which is also what a mistyped link produces — the two are the same fact.
    mocks.membershipInviteRepository.findByTokenHash.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ status: 'not_found' });
    await app.close();
  });

  it.each([
    ['claimed', { claimed_at: new Date() }],
    ['revoked', { revoked_at: new Date() }],
    ['expired', { expires_at: new Date(Date.now() - HOUR) }],
  ])('answers 200 with status %s and no invite object', async (status, overrides) => {
    /**
     * 200 rather than 404, and the split is deliberate: 200 means "this token is
     * real, here is its state", which is exactly what a page needs to render a
     * useful message. Each of the three has a different next step — sign in, ask
     * for a new one, check your inbox for a newer mail — and collapsing them into
     * one "invalid" turns three next steps into a dead end.
     */
    mocks.membershipInviteRepository.findByTokenHash.mockResolvedValue(pendingInvite(overrides));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status });
    await app.close();
  });

  it('reports REVOKED ahead of expired when a row is both', async () => {
    /**
     * The precedence is the product. `revoked` is the only status with a live
     * next step attached ("a newer invitation was sent"); telling somebody their
     * link expired while a working one sits in their inbox sends them to their
     * supervisor instead of to their mail.
     */
    mocks.membershipInviteRepository.findByTokenHash.mockResolvedValue(
      pendingInvite({ revoked_at: new Date(), expires_at: new Date(Date.now() - HOUR) }),
    );
    const app = await buildApp();

    expect((await app.inject({ method: 'GET', url: `/invites/${TOKEN}` })).json())
      .toEqual({ status: 'revoked' });
    await app.close();
  });

  it('answers REVOKED when the MEMBERSHIP has been offboarded', async () => {
    /**
     * The GET twin of the claim's own offboarding case, and the axis on which
     * the two used to disagree. `inviteStatus` reads the invite row only, and
     * `DELETE /users/:id/membership` sets `memberships.status = 'revoked'`
     * without touching `membership_invites` — so this page rendered
     * `200 { status: 'pending', invite: {...} }`, the button worked, and the
     * claim then answered 409 "a newer one may have been sent. Check your
     * inbox": the wrong remedy, for the wrong reason, to somebody nobody resent
     * anything to.
     *
     * It also closes a small disclosure: without it an unauthenticated holder of
     * a leftover token keeps reading the tenant name and the inviter's name for
     * a workspace they were removed from.
     */
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'revoked' });
    // Read tenant-scoped off the INVITE's own tenant, never a header — this
    // route has no tenant context and cannot be given one.
    expect(mocks.membershipRepository.findByIdInTenant)
      .toHaveBeenCalledWith(MEMBERSHIP, TENANT);
    await app.close();
  });

  it('still answers when the inviter cannot be named', async () => {
    // `inviter_name` is `string | null` on the contract for this reason: a
    // failure to name them must not fail the page, and the copy reads correctly
    // without it.
    mocks.membershipInviteRepository.findByTokenHash
      .mockResolvedValue(pendingInvite({ invited_by: null }));
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: `/invites/${TOKEN}` });

    expect(res.json().invite.inviter_name).toBeNull();
    expect(mocks.userRepository.findById).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /invites/:token/claim', () => {
  it('binds the stub and answers the SAME body /auth/session returns', async () => {
    /**
     * The whole point of the response shape: the SPA reuses its existing
     * `SessionResponse` type unchanged, so a claimed agent is simply signed in
     * with no second round trip and no second type to keep in step with a login
     * flow that will keep changing.
     */
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      user: BOUND_USER, tenants: [], memberships: [], governance: {}, is_new: false,
    });
    expect(mocks.buildSessionPayload).toHaveBeenCalledWith(BOUND_USER, STUB_USER);
    await app.close();
  });

  it('resolves the user through the MEMBERSHIP, never by email', async () => {
    /**
     * `users.email` carries only a non-unique index, so `findByEmail` returns
     * whichever row Postgres hands back first — and matching on the address is
     * precisely the mechanism whose failure this feature exists to remove. The
     * membership lookup is tenant-scoped off the INVITE's own tenant, so a row
     * that had somehow been re-pointed cannot carry a claim across a boundary.
     *
     * That same tenant is handed to the bind as `tenantId`, and the assertion
     * below is an EXACT shape for it: a claim that passed no tenant would
     * compile and pass every other case in this file while leaving
     * `AdoptIdentityOptions.confineStubToTenantId` inert — the guard that keeps
     * a token from activating a stub another workspace is waiting on.
     */
    const app = await buildApp();

    await claim(app);

    expect(mocks.membershipRepository.findByIdInTenant).toHaveBeenCalledWith(MEMBERSHIP, TENANT);
    expect(mocks.membershipInviteRepository.claimWithIdentity).toHaveBeenCalledWith({
      inviteId: INVITE_ID,
      userId: STUB_USER,
      tenantId: TENANT,
      identity: expect.objectContaining({ uid: 'fb-real' }),
    });
    await app.close();
  });

  it('answers 404 for an unknown token, and verifies no Firebase token for one', async () => {
    /**
     * The lookup runs BEFORE `verifyIdToken`, deliberately: verification is an
     * outbound call to a third party we are rate-limited by, and this route is
     * public, so verifying first would turn every junk token a scanner sends into
     * an outbound request. Nothing is disclosed by the order that
     * `GET /invites/:token` does not already disclose to the same caller.
     */
    mocks.membershipInviteRepository.findByTokenHash.mockResolvedValue(null);
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ status: 'not_found' });
    expect(mocks.verifyIdToken).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 400 on a malformed body, without touching the invite', async () => {
    const app = await buildApp();

    const res = await claim(app, { not_a_token: 'x' });

    expect(res.statusCode).toBe(400);
    expect(mocks.membershipInviteRepository.claimWithIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 401 when Firebase rejects the id token', async () => {
    // Deliberately opaque, and deliberately not distinguished from an expired
    // one: on a public endpoint that difference is only useful to somebody
    // testing tokens. The detail is in the log.
    mocks.verifyIdToken.mockRejectedValue(new Error('token expired'));
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'Unauthorized' });
    expect(mocks.membershipInviteRepository.claimWithIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 409 expired for a link past its TTL, and binds nothing', async () => {
    mocks.membershipInviteRepository.findByTokenHash
      .mockResolvedValue(pendingInvite({ expires_at: new Date(Date.now() - HOUR) }));
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 'expired' });
    // The message is the remedy, and it is the only place the difference between
    // the three conflicts reaches the reader — the status code is the same for all.
    expect(res.json().message).toContain('expired');
    expect(mocks.membershipInviteRepository.claimWithIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 409 claimed for an invitation already used', async () => {
    mocks.membershipInviteRepository.findByTokenHash
      .mockResolvedValue(pendingInvite({ claimed_at: new Date(), claimed_by_user_id: STUB_USER }));
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 'claimed' });
    expect(res.json().message).toContain('Sign in');
    await app.close();
  });

  it('answers 409 revoked when the MEMBERSHIP has been offboarded', async () => {
    /**
     * `DELETE /users/:id/membership` sets `status = 'revoked'` and touches
     * nothing in `membership_invites`, so `findByIdInTenant`'s `status = 'active'`
     * predicate is the only thing stopping an outstanding invitation from binding
     * an identity to a membership that grants nothing.
     */
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 'revoked' });
    expect(mocks.membershipInviteRepository.claimWithIdentity).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers REVOKED, not claimed, when a resend superseded the token mid-flight', async () => {
    /**
     * The invite read at the top of the handler was pending; a
     * `POST /invites/resend` revoked it before the conditional UPDATE ran. The
     * repository used to report one boolean for both halves of
     * `claimed_at IS NULL AND revoked_at IS NULL`, so the route answered
     * `claimed` — "This invitation has already been used. Sign in to continue" —
     * to somebody who has no account to sign in with and a working link already
     * in their inbox. It also filed the outcome under `already_claimed`, hiding
     * resend churn inside what reads as double-click noise.
     *
     * `InviteStatus` carries four values precisely because the remedies differ;
     * this race is what made the third one unreachable.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'revoked' });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe('revoked');
    expect(res.json().message).toContain('Check your inbox');
    await app.close();
  });

  it('answers EXPIRED when the TTL lapsed between the read and the write', async () => {
    /**
     * The invite read at the top of the handler was pending; the TTL passed
     * while `verifyIdToken` was talking to Firebase and the membership was being
     * read. The route's own `inviteStatus` check cannot hold that — expiry is
     * the one refusal that arrives with nobody acting — so `expires_at > NOW()`
     * is a conjunct of the conditional UPDATE, and the repository reports which
     * predicate failed.
     *
     * `expired`, not `already_claimed`: "ask whoever invited you to send a new
     * one" is actionable, and "sign in to continue" is advice to somebody who
     * has no account yet.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'expired' });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json().status).toBe('expired');
    expect(res.json().message).toContain('expired');
    await app.close();
  });

  it('a concurrent double-claim produces EXACTLY ONE winner', async () => {
    /**
     * The single-winner property belongs to the conditional
     * `UPDATE … WHERE claimed_at IS NULL` (pinned in the repository's own suite,
     * where the statement is asserted). What this case pins is the ROUTE's half:
     * that it takes the repository's verdict as the answer instead of deciding
     * for itself from the read above — a route that re-checked `claimed_at` in
     * JavaScript would see NULL on both requests and answer 200 twice.
     *
     * The double here honours the same rule the statement does: the first caller
     * wins, every later one loses.
     */
    let winner = false;
    mocks.membershipInviteRepository.claimWithIdentity.mockImplementation(async () => {
      if (winner) return { ok: false, reason: 'already_claimed' };
      winner = true;
      return { ok: true, user: BOUND_USER };
    });
    const app = await buildApp();

    const results = await Promise.all([claim(app), claim(app), claim(app)]);
    const codes = results.map((r) => r.statusCode).sort();

    expect(codes).toEqual([200, 409, 409]);
    for (const conflict of results.filter((r) => r.statusCode === 409)) {
      expect(conflict.json()).toMatchObject({ status: 'claimed' });
    }
    await app.close();
  });

  it('answers 409 identity_in_use rather than a masked 500', async () => {
    /**
     * Reachable precisely because a mismatched address is allowed: a person
     * claiming with a personal Google account that already has its own workspace
     * here hits `users.firebase_uid`'s unique constraint. Left to escape, a
     * `23505` reaches `errorMaskHook` and becomes "contact support and quote this
     * request id" for a state they can resolve in one action.
     *
     * A fourth status beyond the documented three, and a deliberate addition: a
     * client that only knows the three renders its generic conflict message,
     * which is strictly better than the mask.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'identity_in_use' });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 'identity_in_use' });
    expect(res.json().message).toContain('different account');
    await app.close();
  });

  it('refuses to rebind a user row bound to a DIFFERENT Firebase account', async () => {
    /**
     * The account-takeover guard, and the whole reason `onlyUnclaimedStub` exists.
     *
     * The claim binds an identity with NO relation to the invited address — the
     * token is the authority, deliberately. That is safe only against a row
     * nobody can yet sign in as, because `POST /users/invite` aims a membership
     * at an EXISTING `users` row whenever the address is already known. Without
     * the predicate: sign up (anyone gets `tenant_owner` of their own tenant),
     * invite `victim@corp.test` as an `agent`, read the raw join link out of the
     * 201 body, claim it with a throwaway Firebase account, and the victim's
     * `firebase_uid` is overwritten — `/auth/session` path 1 then hands the
     * attacker every tenant and membership the victim holds anywhere.
     *
     * Pinned at the ROUTE as well as in the repository, because the value of the
     * guard is that the route refuses: a later refactor reaching for a plain
     * `adoptFirebaseIdentity` would still satisfy a repository-only test.
     *
     * The arm is narrower than it was and the message follows it: an invitee who
     * already has a login here and claims with THAT identity binds idempotently
     * and is signed in (the repository suite's own case), so what reaches this
     * refusal is a claim against somebody else's identity.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'identity_already_bound' });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ status: 'identity_already_bound' });
    // Must not confirm to an unauthenticated caller that the address has an
    // account here — the honest reading and the hostile one get one sentence.
    expect(res.json().message).not.toContain('already belongs');
    await app.close();
  });

  it('refuses a stub that is ALSO another tenant\'s pending member', async () => {
    /**
     * The cross-tenant half of the takeover, which `onlyUnclaimedStub` cannot
     * see: `POST /users/invite` REUSES a `users` row whenever the address is
     * already known, so a `pending_` stub can be a super-admin-provisioned owner
     * in one workspace AND the attacker's `agent` invitee in their own. The stub
     * test passes honestly — nobody has signed in as the row — and binding it
     * used to return every active membership on it through
     * `buildSessionPayload`, victim tenant included.
     *
     * Pinned at the ROUTE as well as in the repository and the integration
     * suite, for the reason the arm above it is: a refactor reaching for a plain
     * `adoptFirebaseIdentity` would still satisfy a repository-only test.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'cross_tenant_identity' });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(409);

    /**
     * ── The response is deliberately INDISTINGUISHABLE from the arm above ───
     * A distinct wire status here is a membership oracle: anyone can sign up,
     * invite an arbitrary address into their own tenant, claim their own link,
     * and read whether that address is a member somewhere else. So the reply is
     * byte-identical to `identity_already_bound`'s, and this asserts that
     * equality against the shared constant rather than against a copy of the
     * string — a second copy is the thing that drifts.
     */
    expect(res.json().status).not.toBe('cross_tenant_identity');
    expect(res.json().message).not.toMatch(/another (tenant|workspace)/i);

    // The honest reading — two workspaces invited one address before either
    // sign-in — is still resolved by proving the ADDRESS at
    // `POST /auth/session`, and the shared copy says so.
    expect(res.json().message).toContain('invited email address');

    /**
     * The actual invariant: this arm and `identity_already_bound` are the SAME
     * response. Asserted by driving both through the route and comparing, not
     * against a copied literal — a literal is a second copy of the thing that
     * has to stay equal, and it would keep passing after one arm was reworded.
     */
    mocks.membershipInviteRepository.claimWithIdentity
      .mockResolvedValue({ ok: false, reason: 'identity_already_bound' });
    const boundApp = await buildApp();
    const boundRes = await claim(boundApp);

    expect(boundRes.statusCode).toBe(res.statusCode);
    expect(boundRes.json()).toEqual(res.json());
    await app.close();
  });

  it('invalidates BOTH caches, including the stale pending_ uid key', async () => {
    /**
     * `cache:user:fb:<OLD uid>` is keyed on the value the row carried a moment
     * ago — `pending_<uuid>` for a stub — and nothing else in this service will
     * ever evict it, because nothing will look a user up by a `pending_` uid
     * again. The membership key is the one `tenantContextMiddleware` reads to
     * resolve a role, and `POST /users/invite` drops it for the same reason.
     */
    const app = await buildApp();

    await claim(app);

    expect(mocks.invalidateUserCache).toHaveBeenCalledWith(STUB_USER, `pending_${STUB_USER}`);
    expect(mocks.redisCache.del).toHaveBeenCalledWith(`cache:membership:${STUB_USER}:${TENANT}`);
    await app.close();
  });

  it('audits the claim with email_matched true when the addresses agree', async () => {
    const app = await buildApp();

    await claim(app);

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0]).toMatchObject({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: STUB_USER,
      action: 'user.invite_claimed',
      resource_type: 'membership_invite',
      resource_id: INVITE_ID,
      details: { email_matched: true, membership_id: MEMBERSHIP, role: 'agent' },
    });
    await app.close();
  });

  it('BINDS a different Google address, and records the mismatch', async () => {
    /**
     * The decision at the heart of this feature. The token is the authority, and
     * the person who received the mail is entitled to use whatever identity they
     * have — refusing here would recreate the original defect one layer up, with
     * an agent whose only Google account is personal locked out exactly as
     * before.
     *
     * What that costs is that `memberships` and `users` afterwards contain NO
     * trace of the discrepancy: the row simply names an identity. So the audit
     * row is not bookkeeping, it is the compensating control that makes accepting
     * the mismatch safe — and it records both addresses, because "the addresses
     * differed" without saying which one arrived is unanswerable in the dispute
     * the row exists for.
     */
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-real', email: 'personal@gmail.test', name: 'New Agent', email_verified: true,
    });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipInviteRepository.claimWithIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0].details).toMatchObject({
      email_matched: false,
      invited_email: INVITED_EMAIL,
      claimed_email: 'personal@gmail.test',
    });
    await app.close();
  });

  it('accepts an UNVERIFIED Firebase email that matches the invited address', async () => {
    /**
     * Verification proves the person controls that inbox; possession of a token
     * DELIVERED to that inbox proves the same thing by the same evidence, one
     * step earlier. Requiring both would block a legitimate agent behind a
     * verification mail for an address we already know they read — and the common
     * shape of that block is an email/password Firebase account created on the
     * claim page seconds earlier, unverified by construction.
     */
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-real', email: INVITED_EMAIL, email_verified: false,
    });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog.mock.calls[0]![0].details).toMatchObject({
      email_matched: true, firebase_email_verified: false,
    });
    await app.close();
  });

  it('treats case and surrounding space as the same address for the audit flag', async () => {
    // "Alice@Example.com" and "alice@example.com" are one inbox everywhere that
    // matters, and recording a mismatch for a capitalisation difference makes the
    // flag noise a reader learns to ignore. This is NOT identity resolution —
    // nothing on this path resolves a user from an address.
    mocks.verifyIdToken.mockResolvedValue({
      uid: 'fb-real', email: ` ${INVITED_EMAIL.toUpperCase()} `, email_verified: true,
    });
    const app = await buildApp();

    await claim(app);

    expect(mocks.auditLog.mock.calls[0]![0].details.email_matched).toBe(true);
    await app.close();
  });

  it('records a mismatch when Firebase supplies NO address at all', async () => {
    // A phone-auth identity has no email. It still binds — the token is the
    // authority — and "no address" is a mismatch rather than a match, so the row
    // says what actually happened.
    mocks.verifyIdToken.mockResolvedValue({ uid: 'fb-real', email_verified: false });
    const app = await buildApp();

    const res = await claim(app);

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog.mock.calls[0]![0].details).toMatchObject({
      email_matched: false, claimed_email: null,
    });
    await app.close();
  });

  it('writes NO audit row on any refusal', async () => {
    // The row means "an identity was bound to this membership". Writing one for a
    // refused claim would make the trail claim something that did not happen.
    mocks.membershipInviteRepository.findByTokenHash
      .mockResolvedValue(pendingInvite({ claimed_at: new Date() }));
    const app = await buildApp();

    await claim(app);

    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the claim path can NEVER provision anything', () => {
  /**
   * The hazard this whole feature removes. `POST /auth/session` path 4 creates a
   * tenant, an account, a `tenant_owner` membership, a credit balance with a
   * signup bonus and a platform API key for any Firebase identity it does not
   * recognise — and an invited agent who reached it landed in a private empty
   * tenant of their own while their real membership sat unclaimed.
   *
   * Asserted two ways, because they catch different failures. The behavioural
   * case catches a provisioning call on the path as it is TODAY; the source
   * audit catches a branch somebody ADDS later, which is the realistic
   * regression and the one no behavioural test can reach.
   */
  it('calls nothing that creates a tenant, an account or a credit row', async () => {
    const app = await buildApp();

    await claim(app);

    // Every repository this module can reach, and what it was allowed to do:
    // three READS to resolve the invite, the membership and the pre-bind user,
    // and exactly ONE write — the transaction that spends the invite and binds
    // the identity. Nothing here creates a row that did not already exist.
    expect(mocks.membershipInviteRepository.findByTokenHash).toHaveBeenCalledTimes(1);
    expect(mocks.membershipRepository.findByIdInTenant).toHaveBeenCalledTimes(1);
    expect(mocks.userRepository.findById).toHaveBeenCalledTimes(1);
    expect(mocks.membershipInviteRepository.claimWithIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.membershipInviteRepository.createSupersedingOutstanding).not.toHaveBeenCalled();
    expect(mocks.tenantRepository.findById).not.toHaveBeenCalled();
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    await app.close();
  });

  it('imports no provisioning module at all', () => {
    /**
     * A source audit, in the shape `test/unit/auth/api-key-route-blocks.test.ts`
     * establishes for this class of problem: what has to be caught is a call site
     * that does not exist yet. Every one of these is something `/auth/session`
     * path 4 reaches for, and none of them belongs anywhere near a claim.
     */
    const source = readFileSync(
      resolve(process.cwd(), 'src/api/routes/invites.routes.ts'),
      'utf8',
    );

    for (const forbidden of [
      'creditBalanceRepository',
      'creditTransactionRepository',
      'tenantCoreCredentialRepository',
      'createCoreApiKey',
      'accountRepository',
      'phoneNumberRepository',
      'tenantPhoneAssignmentRepository',
      'SIGNUP_BONUS',
    ]) {
      expect(source, `${forbidden} must not be reachable from the claim path`)
        .not.toContain(forbidden);
    }
  });

  it('never answers is_new: true', async () => {
    // `is_new` is the flag the SPA uses to run its onboarding. A claim is by
    // definition not a signup, and `buildSessionPayload` types the field as the
    // literal `false` so this cannot be produced by accident.
    const app = await buildApp();

    expect((await claim(app)).json().is_new).toBe(false);
    await app.close();
  });
});

describe('POST /invites/resend', () => {
  function resend(app: FastifyInstance, body: unknown, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'POST', url: '/invites/resend', payload: body as any, headers,
    });
  }

  it('issues through the one write that also revokes, never revoking separately', async () => {
    /**
     * The revoke used to happen HERE, one autocommit statement before
     * `issueInvite` inserted — so two concurrent resends could both revoke
     * before either inserted and leave two live links, which is the one thing a
     * resend exists to prevent. It now rides inside
     * `createSupersedingOutstanding`'s transaction (asserted in the repository's
     * own suite, where the statements are visible), and this route's job is
     * reduced to calling the issuer once.
     *
     * Asserted as an absence as well as a presence: a future revert that puts a
     * separate revoke back on this route reintroduces the race silently.
     */
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP });

    expect(res.statusCode).toBe(200);
    expect(mocks.issueInvite).toHaveBeenCalledTimes(1);
    expect(mocks.issueInvite.mock.calls[0]![0]).toMatchObject({
      membershipId: MEMBERSHIP,
      tenantId: TENANT,
      role: 'agent',
    });
    // A SOURCE audit for the absence, in the shape this file already uses for
    // the auth chain: what has to be caught is a revoke somebody puts BACK on
    // this route, which no behavioural assertion over a doubled repository can
    // see.
    expect(
      readFileSync(resolve(process.cwd(), 'src/api/routes/invites.routes.ts'), 'utf8'),
    ).not.toContain('revokeOutstandingForMembership');
    expect(res.json()).toEqual({
      invite_email: { sent: true },
      sign_in_url: 'https://app.example.com/agency/join/tok-new',
    });
    await app.close();
  });

  it('answers 409, not a masked 500, when a concurrent resend won the live slot', async () => {
    /**
     * The loser of two resends landing together. Migration 069's partial unique
     * index refuses the second row, the repository turns that `23505` into
     * `LiveInviteConflictError`, and this route names what happened — left to
     * escape, `errorMaskHook` rewrites it into "contact support and quote this
     * request id" for a state needing no support at all: the mail the supervisor
     * asked for has just been sent by the request that beat theirs.
     *
     * No audit row, because this request issued nothing; the winner writes its
     * own. And no mail, because the send sits below the row write inside
     * `issueInvite`, so the recipient gets exactly one message.
     */
    mocks.issueInvite.mockRejectedValue(new LiveInviteConflictError());
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP });

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('newest link');
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets any OTHER issuance failure surface, so the supervisor retries', async () => {
    // `issueInvite` deliberately does not swallow database errors: this route has
    // written nothing, so a 500 is the honest answer and pressing the button
    // again is the remedy. Only the conflict is special-cased.
    mocks.issueInvite.mockRejectedValue(new Error('insert failed'));
    const app = await buildApp();

    expect((await resend(app, { membership_id: MEMBERSHIP })).statusCode).toBe(500);
    await app.close();
  });

  it('refuses a membership outside the caller’s tenant, as a 404', async () => {
    /**
     * The tenant predicate is in the STATEMENT (`findByIdInTenant`), so a foreign
     * membership and a nonexistent one are one `null` — indistinguishable by
     * construction rather than by a convention somebody has to maintain, which is
     * what stops this being a membership-id oracle.
     */
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP }, { 'x-tenant-id': OTHER_TENANT });

    expect(res.statusCode).toBe(404);
    expect(mocks.membershipRepository.findByIdInTenant)
      .toHaveBeenCalledWith(MEMBERSHIP, OTHER_TENANT);
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses an ACCOUNT-scoped caller reaching into a sibling account, as a 404', async () => {
    /**
     * `requirePermission` proves the caller's ROLE and never looks at which
     * account their own membership is scoped to — role and `account_id` are
     * independent columns. Same check `POST /users/invite` applies, and 404
     * rather than 403 so a sibling account's membership id stays
     * indistinguishable from a nonexistent one.
     */
    const app = await buildApp();

    const res = await resend(
      app,
      { membership_id: MEMBERSHIP },
      { 'x-scope': 'cccccccc-3333-4333-8333-333333333333' },
    );

    expect(res.statusCode).toBe(404);
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets a TENANT-WIDE caller resend for any account in the tenant', async () => {
    // `account_id === null` is unrestricted by every one of these checks, by
    // design — the same rule the other account-scope guards in this service use.
    const app = await buildApp();

    expect((await resend(app, { membership_id: MEMBERSHIP })).statusCode).toBe(200);
    await app.close();
  });

  it('answers 400 on a malformed body', async () => {
    const app = await buildApp();

    expect((await resend(app, { membership: MEMBERSHIP })).statusCode).toBe(400);
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a role the caller could not have INVITED, as a 403', async () => {
    /**
     * The gap `POST /users/invite` never had: it checks `canManageRole` on the
     * role it is about to create, and this route — which re-mints the credential
     * that BINDS an identity to a membership — checked nothing. Any holder of
     * `user.invite` could resend for any membership in their tenant and receive a
     * fresh identity-binding link in the response body, i.e. mint a credential
     * for a role they could not have handed out.
     *
     * 403 rather than 404, and it costs nothing: the tenant lookup and the
     * account-scope check have both already passed, so the id is known to name a
     * live membership the caller can already read through `GET /users`. There is
     * nothing left for a 404 to conceal.
     */
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(
      activeMembership({ role: 'tenant_owner' }),
    );
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP });

    expect(res.statusCode).toBe(403);
    // Nothing was revoked and nothing was minted — the refusal is BEFORE any
    // write, so a refused resend cannot invalidate a live invitation either.
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    expect(mocks.issueInvite).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the foreign-tenant 404 indistinguishable from a nonexistent id', async () => {
    /**
     * The role gate above must not become a tenant oracle: a membership in
     * ANOTHER tenant is refused by `findByIdInTenant` returning `null`, before
     * any role is known, so it answers the same 404 a nonexistent id does — never
     * the 403 that would confirm the id names a real row somewhere.
     */
    mocks.membershipRepository.findByIdInTenant.mockResolvedValue(null);
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP }, { 'x-tenant-id': OTHER_TENANT });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Not Found', message: 'Membership not found' });
    await app.close();
  });

  it('hands the TENANT to the issuer, which puts it in the revoke statement', async () => {
    /**
     * The RBAC rule: the boundary belongs in the same statement as the
     * write, not only in the lookup above it. The statement is now
     * `createSupersedingOutstanding`'s (pinned in the repository suite); what
     * this route owes it is the tenant the caller was actually authenticated
     * for, never one from the invite or the membership row.
     */
    const app = await buildApp();

    await resend(app, { membership_id: MEMBERSHIP }, { 'x-tenant-id': TENANT });

    expect(mocks.issueInvite.mock.calls[0]![0].tenantId).toBe(TENANT);
    await app.close();
  });

  it('audits the resend, recording whether the mail actually left', async () => {
    // "An invitation was issued for this membership and the mail did not leave"
    // is the exact thing a supervisor's support ticket is about, and a row that
    // exists only on success cannot answer it.
    mocks.issueInvite.mockResolvedValue({
      invite: { id: 'invite-2' },
      signInUrl: null,
      inviteEmail: { sent: false, reason: 'failed' },
    });
    const app = await buildApp();

    const res = await resend(app, { membership_id: MEMBERSHIP });

    expect(res.json().invite_email).toEqual({ sent: false, reason: 'failed' });
    expect(mocks.auditLog.mock.calls[0]![0]).toMatchObject({
      action: 'user.invite_sent',
      resource_type: 'membership_invite',
      details: { resend: true, email_sent: false, email_reason: 'failed' },
    });
    await app.close();
  });

  // There are no platform API keys (decision #5), so there is no `denyPlatformApiKey`
  // link in the chain; the case pins that it is absent (a re-introduced guard would
  // import a module that does not exist) and that the other three links are still there.
  it('carries the full auth chain', () => {
    /**
     * The plugin has no plugin-wide auth hooks — it cannot, since two of its
     * routes are public — so this route must not inherit their absence. A source
     * assertion for the same reason `api-key-route-blocks.test.ts` uses one: what
     * has to be caught is a future route added to this file without the chain.
     *
     * `denyPlatformApiKey` because a key that can re-mint an invitation can mail
     * a fresh identity-binding credential for any membership in its tenant —
     * "every route in this plugin writes who someone IS, which is not a thing a
     * shared machine credential should decide" (`user.routes.ts`).
     */
    const source = readFileSync(
      resolve(process.cwd(), 'src/api/routes/invites.routes.ts'),
      'utf8',
    );
    const at = source.indexOf("app.post('/resend'");
    expect(at).toBeGreaterThan(-1);
    const window = source.slice(at, at + 600);

    expect(window).toContain('sessionMiddleware');
    expect(window).toContain('tenantContextMiddleware');
    expect(window).not.toContain("denyPlatformApiKey('");
    expect(window).toContain("requirePermission('user.invite')");
  });
});

describe('the public routes are rate-limited on their own bucket', () => {
  /**
   * They are the only endpoints in this service where an unauthenticated caller
   * can probe a credential, and the claim route calls Firebase's verification on
   * every request — so an uncapped POST turns a public endpoint into an
   * outbound-request amplifier against a third party we are rate-limited by.
   *
   * A source assertion because `@fastify/rate-limit` is registered globally in
   * `src/index.ts` and is not part of the plugin under test; what matters here is
   * that both public routes declare the config, and that `/resend` — which is
   * authenticated, RBAC-gated and tenant-scoped — is left on the global bucket.
   */
  const source = readFileSync(
    resolve(process.cwd(), 'src/api/routes/invites.routes.ts'),
    'utf8',
  );

  it('declares the bucket on both public routes', () => {
    const get = source.indexOf("app.get<{ Params: { token: string } }>('/:token'");
    const claimRoute = source.indexOf("'/:token/claim'");
    expect(get).toBeGreaterThan(-1);
    expect(claimRoute).toBeGreaterThan(-1);
    expect(source.slice(get, get + 300)).toContain('PUBLIC_INVITE_RATE_LIMIT');
    expect(source.slice(claimRoute, claimRoute + 300)).toContain('PUBLIC_INVITE_RATE_LIMIT');
  });

  it('keys on the peer address, since there is no identity to key on', () => {
    expect(source).toContain('keyGenerator: (request: FastifyRequest) => request.ip');
  });
});
