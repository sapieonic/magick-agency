import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * **Offboarding must close the departing user's agency staffing — and must not
 * fail if it cannot.**
 *
 * ── The leak ────────────────────────────────────────────────────────────────
 * `DELETE /users/:id/membership` removed a membership and dropped a cache key.
 * Nothing called any bulk unassign — the staffing route was the
 * repository's only caller — so a departed agent stayed on every supervisor's
 * staffing list forever, and `GET /proxy/agency/campaigns/:id/agents` went on
 * resolving them to a name and an email out of `users`, a table the membership
 * removal does not touch either. A role change away from `agent` left the same
 * residue.
 *
 * ── The two failure modes, which pull in opposite directions ────────────────
 *  1. **Not closing** leaves the leak. Asserted on both routes.
 *  2. **Closing too eagerly** destroys a real staffing decision. Supervisors and
 *     admins CAN be staffed (covering a shift is an ordinary act), so a role
 *     change between two non-agent roles, or INTO `agent`, must not touch a row.
 *     Those cases are here for exactly that reason and would pass trivially
 *     against a predicate that merely compared "the roles differ" — which is why
 *     the mock is asserted as NOT CALLED rather than by inspecting a response.
 *
 * ── And the ordering property ───────────────────────────────────────────────
 * The membership change is authoritative and the staffing close is a tidy-up of a
 * navigation list — closing a row revokes nothing. So a
 * staffing failure must leave the membership removed and the request successful.
 * That is the last describe block, and it is the one that would otherwise be a
 * comment nobody could check.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const TARGET_USER = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN_A = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN_B = '55555555-5555-4555-8555-555555555555';
const ASSIGNMENT_A = '66666666-6666-4666-8666-666666666666';
const ASSIGNMENT_B = '77777777-7777-4777-8777-777777777777';
const CONSOLE_BASE_URL = 'https://app.example.com';

const mocks = vi.hoisted(() => ({
  membershipRepository: {
    findByUserAndTenant: vi.fn(),
    findAnyByUserAndTenant: vi.fn(),
    create: vi.fn(),
    reactivateWithRole: vi.fn(),
    updateRoleGuardingLastOwner: vi.fn(),
    removeGuardingLastOwner: vi.fn(),
  },
  userRepository: {
    findByProvenEmail: vi.fn(),
    resolveByProvenEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
  },
  // The invitation row. Mocked because `POST /users/invite` now WRITES one for an
  // `agent` — the token is what binds the invitee's Firebase identity to this
  // membership, so the row is part of the invite rather than part of the mail.
  membershipInviteRepository: {
    createSupersedingOutstanding: vi.fn(),
  },
  tenantRepository: {
    findById: vi.fn(),
  },
  accountRepository: {
    findByIdInTenant: vi.fn(),
  },
  redisCache: {
    del: vi.fn().mockResolvedValue(undefined),
  },
  // Q5: what the revocation delete reports (true unless a case says the Redis DEL failed).
  revocation: { cleared: true },
  // Only the bulk close is exposed. A route that reached for the single-campaign
  // `unassign` instead — which cannot express "every campaign" — would call
  // `undefined` and fail loudly rather than half-working.
  closeAllForUser: vi.fn(),
  auditLog: vi.fn(),
  sendInviteEmail: vi.fn(),
}));

vi.mock('../../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// RBAC is not what these cases are about; the role checks inside the handlers are
// real and are what the fixtures below exercise.
vi.mock('../../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: mocks.membershipRepository,
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: mocks.userRepository,
}));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: mocks.accountRepository,
}));
vi.mock('../../../../src/db/repositories/membership-invite.repository.js', () => ({
  membershipInviteRepository: mocks.membershipInviteRepository,
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: mocks.tenantRepository,
}));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  // Q5: revocation deletes go through `delForRevocation` (retried, reports
  // failure); this double forwards to the `del` mock and reports success, so the assertions on
  // `del` still observe the key.
  redisCache: { ...mocks.redisCache, delForRevocation: async (...k: string[]) => { await mocks.redisCache.del(...k); return mocks.revocation.cleared; } },
}));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({
  agencyCampaignAgentRepository: { closeAllForUser: mocks.closeAllForUser },
}));
// The audit logger is `platformAuditLogger`, and the console origin config key is
// `consoleBaseUrl` (env `CONSOLE_BASE_URL`).
vi.mock('../../../../src/audit/platform/audit-logger.js', () => ({
  platformAuditLogger: { log: mocks.auditLog },
}));
vi.mock('../../../../src/notifications/invite-mailer.js', async (orig) => {
  // `inviteSignInUrl` is REAL: the URL rule is a product decision and a stubbed one
  // would let the route ship the wrong link. Only the send is doubled.
  const actual = await orig<typeof import('../../../../src/notifications/invite-mailer.js')>();
  return { inviteSignInUrl: actual.inviteSignInUrl, sendInviteEmail: mocks.sendInviteEmail };
});
/**
 * A configured console base URL (`consoleBaseUrl`), so the real `inviteSignInUrl` can produce a link
 * at all.
 *
 * Without it the mailer returns `null` for every role, and the case below that
 * claims to prove the agency door for an agent asserted `agentUrl === viewerUrl`
 * — two nulls, agreeing for the one reason that has nothing to do with the rule
 * in its title. Mocking the config module rather than setting `process.env` is
 * this repo's pattern (config is frozen at import); the mailer reads it through a
 * cached dynamic import, so the mock is what it resolves.
 */
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    consoleBaseUrl: CONSOLE_BASE_URL,
    // `invites` and `brand` both `.default({})` in the schema, so a real
    // deployment always has them; the mock states them for the same reason the
    // schema defaults them — `mintInviteToken` reads the TTL on every agent
    // invite and would otherwise throw inside the route's guard, turning every
    // case below into a silent `reason: 'failed'`.
    invites: { tokenTtlDays: 7 },
    brand: { name: 'Magick Agency', accent: '#7c5cfc' },
  },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import Fastify from 'fastify';
import { userRoutes } from '../../../../src/api/routes/user.routes.js';
// Not mocked: the hierarchy is the real thing the route sorts by, and the
// structural case below is worthless against a fixture of it.
import { ROLE_HIERARCHY } from '@magick-agency/contracts/rbac';

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm-1',
    user_id: TARGET_USER,
    tenant_id: TENANT,
    account_id: null,
    role: 'agent',
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildApp(
  callerRole = 'tenant_admin',
  membershipAccountId: string | null = null,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['user'] = { id: ACTOR };
    r['tenantId'] = TENANT;
    r['accountId'] = 'account-1';
    r['membership'] = { role: callerRole, account_id: membershipAccountId };
  });
  await app.register(userRoutes, { prefix: '/users' });
  await app.ready();
  return app;
}

/**
 * Two assignments in two DIFFERENT accounts, which is the ordinary shape:
 * `closeAllForUser` closes across every account in the tenant, and neither of
 * them need be the account the offboarding admin has selected.
 */
const ACCOUNT_A = 'account-a';
const ACCOUNT_B = 'account-b';

const CLOSED_ROWS = [
  { id: ASSIGNMENT_A, campaign_id: CAMPAIGN_A, account_id: ACCOUNT_A },
  { id: ASSIGNMENT_B, campaign_id: CAMPAIGN_B, account_id: ACCOUNT_B },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeAllForUser.mockResolvedValue(CLOSED_ROWS);
  mocks.redisCache.del.mockResolvedValue(undefined);
  mocks.revocation.cleared = true;
  mocks.sendInviteEmail.mockResolvedValue({ sent: false, reason: 'not_configured' });
});

describe('DELETE /users/:id/membership closes agency staffing', () => {
  beforeEach(() => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([membership()]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: membership() });
  });

  it('closes every open assignment for that user in that tenant', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER);
    await app.close();
  });

  it('closes them regardless of the departing member’s role', async () => {
    /**
     * No `agent`-role predicate here, unlike the role route. A membership removal
     * takes `agency.station.connect` away outright, and supervisors and admins can
     * be staffed too — filtering on `role === 'agent'` would leave exactly those
     * rows behind, which is the same leak one role narrower.
     */
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      membership({ role: 'account_admin' }),
    ]);
    const app = await buildApp('tenant_owner');

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER);
    await app.close();
  });

  it('writes one audit row per closed assignment, naming the reason', async () => {
    /**
     * The SAME action a supervisor's manual unassign writes, so a staffing change
     * has one shape in the trail however it was caused — and `reason` is what stops
     * a supervisor reading it as an admin having quietly restaffed their campaign.
     *
     * The payload is asserted exactly, not just the call count: filing the CAMPAIGN
     * id as `resource_id` under `resource_type: 'agency_campaign_agent'` is the
     * mistake the single-row `unassign` already made once, and a count assertion
     * cannot see a wrong id.
     */
    const app = await buildApp();

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(mocks.auditLog).toHaveBeenCalledTimes(2);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT_A,
      actor_type: 'human',
      user_id: ACTOR,
      action: 'agency_campaign_agent.unassigned',
      resource_type: 'agency_campaign_agent',
      resource_id: ASSIGNMENT_A,
      campaign_id: CAMPAIGN_A,
      details: { campaign_id: CAMPAIGN_A, user_id: TARGET_USER, reason: 'membership_removed' },
    });
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: ASSIGNMENT_B, campaign_id: CAMPAIGN_B }),
    );
    await app.close();
  });

  it('stamps each audit row with the ASSIGNMENT’s account, not the actor’s', async () => {
    /**
     * ── Why this is a scoping bug and not a cosmetic one ────────────────────
     * `closeAllForUser` closes assignments across EVERY account in the tenant, and
     * `GET /audit-log` is account-scoped — `auditAccountScope` confines an
     * account-scoped membership to rows carrying its own account. Stamping
     * `request.accountId` gave a whole tenant's worth of rows one account: whichever
     * the offboarding admin had selected. The `account_admin` whose roster actually
     * changed then saw no trail of it at all.
     *
     * The actor here holds `account-1`, deliberately matching NEITHER assignment,
     * so an implementation that reverts to `request.accountId` cannot pass by
     * coincidence.
     */
    const app = await buildApp();

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    const accountsByAssignment = new Map(
      mocks.auditLog.mock.calls.map(([row]) => [row.resource_id, row.account_id]),
    );
    expect(accountsByAssignment).toEqual(
      new Map([[ASSIGNMENT_A, ACCOUNT_A], [ASSIGNMENT_B, ACCOUNT_B]]),
    );
    // And emphatically not the actor's, which is the value that was being written.
    expect([...accountsByAssignment.values()]).not.toContain('account-1');
    await app.close();
  });

  it('omits account_id for an assignment that never had one', async () => {
    /**
     * A tenant-level member (`account_id IS NULL`) writes NULL into the column —
     * it records the account context the assignment was MADE in, not the campaign's
     * owning account. There is no account to file such a row under, and inventing
     * one from the actor is the same wrong answer this test's sibling fixes, one
     * row at a time. The KEY is absent rather than null, matching every other
     * conditional field on this audit call.
     */
    mocks.closeAllForUser.mockResolvedValue([
      { id: ASSIGNMENT_A, campaign_id: CAMPAIGN_A, account_id: null },
    ]);
    const app = await buildApp();

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog.mock.calls[0]![0]).not.toHaveProperty('account_id');
    await app.close();
  });

  it('writes no audit row when there was nothing staffed', async () => {
    // The trail records acts, not requests — the rule the manual unassign route's
    // conditional audit already follows.
    mocks.closeAllForUser.mockResolvedValue([]);
    const app = await buildApp();

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not touch staffing when the removal itself was refused', async () => {
    // Nothing was offboarded, so nothing should be unstaffed. Closing rows on a
    // refused request would unstaff the last owner of a tenant for nothing.
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({
      ok: false,
      reason: 'last_owner',
    });
    const app = await buildApp('tenant_owner');

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(400);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not touch staffing when there was no membership to remove', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(404);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PUT /users/:id/role — only a demotion AWAY from agent closes staffing', () => {
  function primeRoleChange(currentRole: string, siblings: Array<Record<string, unknown>> = []) {
    const target = membership({ role: currentRole });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([target, ...siblings]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({
      ok: true,
      value: target,
    });
  }

  it('closes staffing when an agent becomes a viewer', async () => {
    primeRoleChange('agent');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER);
    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agency_campaign_agent.unassigned',
        details: expect.objectContaining({ reason: 'role_changed_from_agent' }),
      }),
    );
    await app.close();
  });

  it('does NOT close staffing when someone is promoted INTO agent', async () => {
    /**
     * A supervisor is about to staff them. Closing on this direction is a no-op
     * today and would silently undo an assignment made in the same minute the
     * moment invite-then-staff becomes one screen.
     */
    primeRoleChange('viewer');
    const app = await buildApp();

    await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'agent' },
    });

    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT close staffing on a change between two non-agent roles', async () => {
    /**
     * The case that matters most for over-eagerness. `POST /campaigns/:id/agents`
     * requires only a membership, so a supervisor covering a shift is legitimately
     * staffed — and an unrelated promotion must not unstaff them.
     */
    primeRoleChange('operator');
    const app = await buildApp('tenant_owner');

    await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'account_admin' },
    });

    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT close staffing when the role did not actually change', async () => {
    primeRoleChange('agent');
    const app = await buildApp();

    await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'agent' },
    });

    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT close staffing while another agent membership survives in the tenant', async () => {
    /**
     * A user may hold several memberships in one tenant (one per account, plus
     * possibly a tenant-level one) and this route changes exactly ONE. Demoting one
     * while another still makes them an agent here would take a working agent off
     * their campaigns.
     */
    primeRoleChange('agent', [membership({ id: 'm-2', account_id: 'account-2', role: 'agent' })]);
    const app = await buildApp();

    await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('is suppressed by ANY surviving sibling, because a selected agent implies they all are', async () => {
    /**
     * ── The other direction of `stillAgentElsewhere`, and what it turns out to be ─
     * The case above proves the predicate SUPPRESSES the close. On its own that
     * says nothing about its shape, because `not.toHaveBeenCalled()` is also what
     * a predicate that never permits the close produces. So the obvious companion
     * case is "a sibling that is NOT an agent, therefore the close proceeds".
     *
     * **That case cannot be constructed through this route, and finding out why is
     * the useful part.** `primaryMembership` sorts by `ROLE_HIERARCHY` descending
     * and takes the first, so `targetMembership` is the STRONGEST role the person
     * holds in this tenant. `isDemotionFromAgent` only fires when that role is
     * `agent`, and `agent` is level 5 — the FLOOR of the hierarchy. A selected
     * `agent` therefore means every other membership they hold here is also at
     * most level 5, i.e. also `agent`.
     *
     * So on every path that reaches it, `memberships.some((m) => m.id !==
     * targetMembership.id && m.role === 'agent')` is exactly `memberships.length >
     * 1`: the role conjunct can never be the thing that decides. The route's own
     * docstring says as much ("`agent` is the lowest rung of the hierarchy, so
     * `primaryMembership` picking an `agent` row means every membership they hold
     * here is `agent`") — this is that sentence made executable, and it is why the
     * companion case is a `viewer` sibling being handed in and the close still NOT
     * happening. Written the other way round it would be asserting a bug.
     *
     * The conjunct is not therefore wrong: it is correct defence that becomes LIVE
     * the moment a role below `agent` exists, which is what the next case pins.
     */
    primeRoleChange('agent', [membership({ id: 'm-2', account_id: 'account-2', role: 'viewer' })]);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    // 200, because the role change itself is unaffected — only the tidy-up is.
    expect(res.statusCode).toBe(200);
    // And no close: `primaryMembership` selected the `viewer` row, so the role
    // being replaced is not `agent` and `isDemotionFromAgent` never fires.
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('`agent` is the FLOOR of ROLE_HIERARCHY, which is what the case above rests on', () => {
    /**
     * A structural assertion rather than a behavioural one, and it is here because
     * the reasoning above is a two-module coupling that nothing else states:
     * `primaryMembership` (user.routes.ts) selects by `ROLE_HIERARCHY`
     * (rbac/roles.ts), and the staffing close's correctness depends on `agent`
     * being the minimum of it.
     *
     * Add a role below `agent` — a `trainee`, a `read_only_agent`, anything at
     * level 1 — and the coupling inverts silently. `primaryMembership` would then
     * select the `agent` row over the new one, `isDemotionFromAgent` WOULD fire,
     * and `m.role === 'agent'` would correctly report "no other agent membership"
     * so the close would proceed. That is the right answer, which is precisely why
     * the conjunct is there. But the case above — asserting NO close for a
     * lower-ranked sibling — would then be asserting the opposite of the correct
     * behaviour, and it would fail with a message about staffing rather than about
     * the hierarchy.
     *
     * So this fails FIRST, in the same run, naming the actual cause. Deriving it
     * from the live hierarchy rather than hard-coding `5` is deliberate: the
     * property is "nothing is below `agent`", not "`agent` is 5".
     */
    const levels = Object.values(ROLE_HIERARCHY);
    expect(
      Math.min(...levels),
      'A role now sits below `agent`. `stillAgentElsewhere`\'s role conjunct has '
        + 'become live and the "suppressed by ANY surviving sibling" case above now '
        + 'pins the WRONG behaviour — read its docstring before changing either.',
    ).toBe(ROLE_HIERARCHY['agent']);
  });

  it('does not touch staffing when the role change was refused', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([membership({ role: 'agent' })]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({
      ok: false,
      reason: 'role_changed',
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(409);
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the staffing tidy-up is scoped to an account-scoped caller’s own account', () => {
  /**
   * ── The gap this closes ─────────────────────────────────────────────────
   * `PUT /:id/role` and `DELETE /:id/membership` already confine WHICH
   * membership an account-scoped caller may change — filter-then-pick on
   * `request.membership.account_id`, above. But the SIDE EFFECT of that change
   * (closing agency staffing) called `closeAllForUser(tenantId, userId)` with no
   * account filter at all, reaching every account in the tenant regardless of
   * which one the caller was scoped to. An `account_admin` confined to account A,
   * offboarding a user out of A, still closed that user's staffing on every
   * campaign in sibling accounts B and C — a cross-account mutation the
   * membership guard was built specifically to prevent.
   *
   * Nothing about the departing user's OWN account differs from the fixture
   * above (`membership()` defaults `account_id: null`) — what changes here is
   * the CALLER's scope, threaded through to the close.
   */
  const CALLER_ACCOUNT = 'account-a';

  it('DELETE /users/:id/membership passes the caller’s account through to the close', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([
      membership({ account_id: CALLER_ACCOUNT }),
    ]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({
      ok: true,
      value: membership({ account_id: CALLER_ACCOUNT }),
    });
    const app = await buildApp('tenant_admin', CALLER_ACCOUNT);

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER, CALLER_ACCOUNT);
    await app.close();
  });

  it('PUT /users/:id/role passes the caller’s account through to the close', async () => {
    const target = membership({ role: 'agent', account_id: CALLER_ACCOUNT });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([target]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: true, value: target });
    const app = await buildApp('tenant_admin', CALLER_ACCOUNT);

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER, CALLER_ACCOUNT);
    await app.close();
  });

  it('a TENANT-WIDE caller still closes tenant-wide (unchanged, 2-arg call)', async () => {
    // The default fixture throughout this file: `buildApp()` with no account,
    // i.e. `request.membership.account_id === null`. Restated here explicitly
    // because it is the case the fix must not narrow.
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([membership()]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: membership() });
    const app = await buildApp('tenant_admin', null);

    await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER);
    // And never with a third argument it never had.
    expect(mocks.closeAllForUser.mock.calls[0]).toHaveLength(2);
    await app.close();
  });
});

describe('a staffing-close failure does not undo the offboarding', () => {
  /**
   * The ordering property, stated executably. The membership change is the
   * authoritative outcome and has already committed by the time staffing is
   * touched; a closed staffing row revokes nothing, so its failure is a stale
   * navigation entry rather than a privilege leak. Re-raising would report failure
   * for work that succeeded, and would invite an operator to retry a removal that
   * has already happened.
   */
  it('still removes the membership, and still answers 200', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([membership()]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: membership() });
    mocks.closeAllForUser.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Membership removed' });
    expect(mocks.membershipRepository.removeGuardingLastOwner).toHaveBeenCalled();
    // The revocation broadcast still happened — it runs before the tidy-up, which
    // is the ordering that makes this survivable.
    expect(mocks.redisCache.del).toHaveBeenCalledWith(`cache:membership:${TARGET_USER}:${TENANT}`);
    // And no audit row claims a staffing change that did not happen.
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('still applies the role change when the staffing close throws', async () => {
    const target = membership({ role: 'agent' });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([target]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: true, value: target });
    mocks.closeAllForUser.mockRejectedValue(new Error('db down'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: `/users/${TARGET_USER}/role`,
      payload: { role: 'viewer' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toBeDefined();
    await app.close();
  });
});

describe('POST /users/invite — the mail seam is additive and cannot fail the invite', () => {
  beforeEach(() => {
    mocks.userRepository.resolveByProvenEmail.mockResolvedValue({ status: 'found', user: { id: TARGET_USER, email: 'new@example.com' } });
    mocks.userRepository.findById.mockResolvedValue({ id: ACTOR, display_name: 'Priya Sharma' });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.findAnyByUserAndTenant.mockResolvedValue([]);
    mocks.membershipRepository.create.mockResolvedValue(membership({ role: 'agent' }));
    mocks.membershipInviteRepository.createSupersedingOutstanding.mockImplementation(async (input: any) => ({
      id: 'invite-1', ...input,
    }));
    mocks.tenantRepository.findById.mockResolvedValue({ id: TENANT, name: 'Acme Collections' });
  });

  it('keeps membership and user exactly as they were, and ADDS the two new keys', async () => {
    // Additive only: a client that ignores the new keys behaves exactly as today.
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@example.com', role: 'agent' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.membership).toBeDefined();
    expect(body.user).toEqual({ id: TARGET_USER, email: 'new@example.com' });
    // No `mailjet` block in the config mock, so the transport is off — which is
    // the default deployment and reports `not_configured`, not `failed`.
    expect(body.invite_email).toEqual({ sent: false, reason: 'not_configured' });
    /**
     * `sign_in_url` is documented as ALWAYS present — "the KEY is always present,
     * because a sometimes-absent key is indistinguishable from one a client forgot
     * to read" — and nothing asserted it, so removing it from the response failed
     * nothing. It is the field the supervisor's hand-off panel is meant to stop
     * deriving from `window.location.origin`, i.e. the whole reason the route
     * returns a link while `invite_email.sent` is still false.
     */
    // The JOIN page, carrying the minted token — not `/agency/login`, which an
    // invited agent with no Google account cannot get through: that page
    // deliberately has no signup, and Firebase password-reset cannot mint a
    // credential for a user that does not exist. The token is what makes a door
    // with a signup on it safe, because the claim binds to the membership the
    // TOKEN names and so cannot create a stray tenant.
    expect(body.sign_in_url).toMatch(
      new RegExp(`^${CONSOLE_BASE_URL}/agency/join/[A-Za-z0-9_-]{43}$`),
    );
    await app.close();
  });

  it('carries sign_in_url even when no link can be built — the KEY is the contract', async () => {
    // `null` and absent are different answers, and only one of them is
    // distinguishable from a client that forgot to read the field.
    const { config } = await import('../../../../src/config/index.js');
    const mutable = config as { consoleBaseUrl?: string };
    const app = await buildApp();
    try {
      mutable.consoleBaseUrl = undefined;

      const res = await app.inject({
        method: 'POST',
        url: '/users/invite',
        payload: { email: 'new@example.com', role: 'agent' },
      });

      expect(res.json()).toHaveProperty('sign_in_url');
      expect(res.json().sign_in_url).toBeNull();
    } finally {
      // Restored in a `finally` because the mailer caches the config OBJECT, so a
      // leaked edit would silently unconfigure every case that runs after this one.
      mutable.consoleBaseUrl = CONSOLE_BASE_URL;
      await app.close();
    }
  });

  it('reports sent: true with no reason when the transport accepts it', async () => {
    mocks.sendInviteEmail.mockResolvedValue({ sent: true, messageId: null });
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@example.com', role: 'agent' },
    });

    // This is the field the customer UI needs before it can stop telling
    // supervisors to send the link themselves.
    expect(res.json().invite_email).toEqual({ sent: true });
    await app.close();
  });

  it('sends the invite AFTER the membership is written', async () => {
    // The membership is the real outcome; the email only tells the invitee to go and
    // sign in. Asserted on call order because a send before the write would mail a
    // link to a workspace the person is not yet a member of.
    const order: string[] = [];
    mocks.membershipRepository.create.mockImplementation(async () => {
      order.push('membership');
      return membership({ role: 'agent' });
    });
    mocks.membershipInviteRepository.createSupersedingOutstanding.mockImplementation(async (input: any) => {
      order.push('invite-row');
      return { id: 'invite-1', ...input };
    });
    mocks.sendInviteEmail.mockImplementation(async () => {
      order.push('email');
      return { sent: false, reason: 'not_configured' };
    });
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@example.com', role: 'agent' },
    });

    // The invite ROW lands between them, and that ordering matters too: a token
    // that has been mailed but not stored is unredeemable, while one stored but
    // not mailed is merely unused and `POST /invites/resend` recovers it.
    expect(order).toEqual(['membership', 'invite-row', 'email']);
    await app.close();
  });

  it('carries the agency door for an agent and the plain link for everyone else', async () => {
    /**
     * `inviteSignInUrl` is the REAL implementation in this suite, so this asserts
     * the shipped rule rather than a stub. It mirrors the console's `inviteSignInUrl`
     * (`TeamPage.tsx`) — see the mailer's docstring for why the duplication is
     * accepted for now.
     *
     * ── This case used to assert its own opposite ──────────────────────────
     * It ended `expect(agentUrl).toBe(viewerUrl)`, with a comment noting that
     * without a configured base URL both are `null`. Two nulls do agree — for the
     * one reason that has nothing to do with the rule in the title, so the stated
     * subject was not tested at all and deleting the `role === 'agent'` branch
     * from the mailer left it green. A base URL is now configured for the suite
     * and the DIFFERENCE is what is asserted.
     */
    const app = await buildApp();

    await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@example.com', role: 'agent' },
    });
    const agentUrl = mocks.sendInviteEmail.mock.calls[0]![0].signInUrl;

    mocks.membershipRepository.create.mockResolvedValue(membership({ role: 'viewer' }));
    await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'other@example.com', role: 'viewer' },
    });
    const viewerUrl = mocks.sendInviteEmail.mock.calls[1]![0].signInUrl;

    expect(mocks.sendInviteEmail.mock.calls[0]![0].role).toBe('agent');
    expect(mocks.sendInviteEmail.mock.calls[1]![0].role).toBe('viewer');
    // The whole point of threading the role: an `agent` inherits no navigation, so
    // the app shell is a page with nothing on it — and the sign-in page in front of
    // it carries a Sign Up tab that would put an invited agent in a private empty
    // tenant while this very membership goes unclaimed. Every other role's landing
    // IS the shell.
    expect(agentUrl).toMatch(
      new RegExp(`^${CONSOLE_BASE_URL}/agency/join/[A-Za-z0-9_-]{43}$`),
    );
    expect(viewerUrl).toBe(`${CONSOLE_BASE_URL}/login`);
    expect(agentUrl).not.toBe(viewerUrl);
    // A non-agent invite writes NO invitation row. There is no claim page for a
    // `viewer` to land on, so a token for one would be a credential nothing can
    // redeem sitting in a table — see `roleGetsTokenInvite`.
    expect(mocks.membershipInviteRepository.createSupersedingOutstanding).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('still creates the membership if the mailer rejects outright', async () => {
    /**
     * `sendInviteEmail` is documented as total, and the route awaits it inline —
     * so if that totality is ever broken, the invite must not be the thing that
     * breaks with it. A 500 here would mean a membership written and a caller told
     * the invite failed, which is the worst of both.
     */
    mocks.sendInviteEmail.mockRejectedValue(new Error('mailer exploded'));
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/users/invite',
      payload: { email: 'new@example.com', role: 'agent' },
    });

    expect(mocks.membershipRepository.create).toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.json().invite_email).toEqual({ sent: false, reason: 'failed' });
    await app.close();
  });
});

/**
 * Q5: when the revocation's Redis DEL still fails
 * after its retries, the role change (idempotent on retry) answers 503 — AFTER the role write
 * and the staffing close, so the retry has nothing left undone — while the membership removal
 * (not idempotent: a retry 404s before reaching the delete) keeps its 200.
 */
describe('Q5: a revocation whose cache delete failed', () => {
  it('PUT /users/:id/role answers 503 cache_invalidation_failed, with the role written and staffing closed first', async () => {
    const target = membership({ role: 'agent' });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([target]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: true, value: target });
    mocks.revocation.cleared = false;
    const app = await buildApp();

    const res = await app.inject({ method: 'PUT', url: `/users/${TARGET_USER}/role`, payload: { role: 'viewer' } });

    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('cache_invalidation_failed');
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).toHaveBeenCalled();
    expect(mocks.redisCache.del).toHaveBeenCalledWith(`cache:membership:${TARGET_USER}:${TENANT}`);
    expect(mocks.closeAllForUser).toHaveBeenCalledWith(TENANT, TARGET_USER);
    await app.close();
  });

  it('the same PUT retried once the cache is back is a 200 (idempotent: same role, nothing left to close)', async () => {
    const already = membership({ role: 'viewer' });
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([already]);
    mocks.membershipRepository.updateRoleGuardingLastOwner.mockResolvedValue({ ok: true, value: already });
    const app = await buildApp();

    const res = await app.inject({ method: 'PUT', url: `/users/${TARGET_USER}/role`, payload: { role: 'viewer' } });

    expect(res.statusCode).toBe(200);
    expect(mocks.membershipRepository.updateRoleGuardingLastOwner).toHaveBeenCalledWith('m-1', TENANT, 'viewer', 'viewer');
    expect(mocks.closeAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('DELETE /users/:id/membership keeps its 200 (a retry could not reach the delete)', async () => {
    mocks.membershipRepository.findByUserAndTenant.mockResolvedValue([membership()]);
    mocks.membershipRepository.removeGuardingLastOwner.mockResolvedValue({ ok: true, value: membership() });
    mocks.revocation.cleared = false;
    const app = await buildApp();

    const res = await app.inject({ method: 'DELETE', url: `/users/${TARGET_USER}/membership` });

    expect(res.statusCode).toBe(200);
    expect(mocks.redisCache.del).toHaveBeenCalledWith(`cache:membership:${TARGET_USER}:${TENANT}`);
    await app.close();
  });
});
