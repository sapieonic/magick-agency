import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { redisCache } from '../../cache/redis-cache.js';
import { membershipCacheKey } from '../middleware/membership-cache-key.js';
import { sendRevocationCacheUnavailable } from '../../cache/revocation-unavailable.js';
import { inviteUserSchema, updateRoleSchema } from '../validators/user.validator.js';
import { canManageRole, ROLE_HIERARCHY } from '@magick-agency/contracts/rbac';
import type { MembershipRecord, MembershipRole } from '@magick-agency/db/models/membership.model';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
// The invite's write, the guarded invitation and the shared refusals
// (`src/invites/membership-provisioning.ts`, shared with the super-admin tree).
import {
  inviteMember,
  isDemotionFromAgent,
  issueInviteReportingFailure,
  unverifiedAddressHolderBody,
} from '../../invites/membership-provisioning.js';
import { settledValue } from './helpers/settled.js';
import { createChildLogger } from '@magick-agency/observability';
import { ADDRESS_REBOUND_DURING_INVITE } from '../../auth/firebase-identity.js';
import { parseOr400 } from './helpers/parse-or-400.js';

const log = createChildLogger({ component: 'user-routes' });

/**
 * Whether the caller may act on a membership that already exists.
 *
 * Invite only checks the NEW role (`canManageRole`). Update and delete must
 * also check the CURRENT role, otherwise a tenant_admin assigning `viewer`
 * (below them) can demote a tenant_owner or a peer admin. Co-owners are the
 * one equal-role exception: `canManageRole` is strictly-higher and there is
 * no role above `tenant_owner`, so without it an owner could not step another
 * owner down or remove them. Last-owner and self-removal stay at the route.
 */
function canManageExistingRole(callerRole: MembershipRole, targetRole: MembershipRole): boolean {
  return canManageRole(callerRole, targetRole)
    || (callerRole === 'tenant_owner' && targetRole === 'tenant_owner');
}

/**
 * The one membership `PUT /:id/role` and `DELETE /:id/membership` act on.
 *
 * A user can hold MORE than one membership in a tenant — a tenant-wide one
 * (`account_id = NULL`) and an account-scoped one — because invite's duplicate
 * check is per account context. `findByUserAndTenant` had no `ORDER BY` (it is
 * oldest-first now, for the middleware's sake), so taking `memberships[0]` let
 * Postgres row order decide two separate things:
 * which row got written, and which role the caller was checked against. A
 * tenant_admin aiming at a user who is `tenant_owner` tenant-wide and
 * `operator` on one account was refused or quietly allowed depending on which
 * row the heap happened to return first.
 *
 * Pick the STRONGEST role, so the manageability check is always made against
 * the most privileged thing the target holds, and break ties on the oldest row
 * so repeated calls agree with each other. Note this still acts on ONE
 * membership: a target with two of them keeps the other, which is the existing
 * behaviour of both routes and not something determinism changes.
 */
function primaryMembership(memberships: MembershipRecord[]): MembershipRecord | undefined {
  const createdAt = (m: MembershipRecord): number => {
    const t = m.created_at ? new Date(m.created_at).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
  };
  return [...memberships].sort((a, b) => {
    const byRole = (ROLE_HIERARCHY[b.role] ?? 0) - (ROLE_HIERARCHY[a.role] ?? 0);
    if (byRole !== 0) return byRole;
    const byAge = createdAt(a) - createdAt(b);
    if (byAge !== 0) return byAge;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  })[0];
}

/**
 * Why an offboarding closes someone's agency staffing, and why it may fail.
 *
 * ── The leak ───────────────────────────────────────────────────────────────
 * Removing a membership and dropping a cache key does not touch
 * `agency_campaign_agents`, and nothing else calls a bulk unassign, so without
 * this a departed agent would stay on every supervisor's staffing list forever,
 * still resolving to a name and an email through
 * `GET /proxy/agency/campaigns/:id/agents` (which reads `users`, a table the
 * membership removal does not touch either). A role change away from `agent`
 * would leave the same residue.
 *
 * ── Closing a staffing row REVOKES NOTHING, which is what makes this safe to do
 *    automatically ─────────────────────────────────────────────────────────
 * Staffing is not authorization. The module header of
 * `proxy-agency-staffing.routes.ts` says so at length: nothing consults this
 * table to decide whether a station join is allowed — `agency.station.connect`
 * does, and the membership change is what takes that away. A row here only decides
 * where an agent is SENT by default. So this is tidying a navigation list on a
 * decision somebody already made, not an access change of its own, and it needs no
 * confirmation and no separate permission.
 *
 * Read the other way, that is also why the failure is survivable: a stale staffing
 * row cannot let anybody dial anything.
 *
 * ── Never throws ───────────────────────────────────────────────────────────
 * Every caller has already made the authoritative change. See the ordering
 * comments at each call site.
 */
async function closeAgencyStaffing(
  request: FastifyRequest,
  targetUserId: string,
  reason: 'membership_removed' | 'role_changed_from_agent',
): Promise<void> {
  try {
    /**
     * Scoped to the CALLER's account when they are account-scoped, so the side
     * effect of an offboarding cannot reach further than the offboarding itself
     * was allowed to. `PUT /:id/role` and `DELETE /:id/membership` already confine
     * WHICH membership an account-scoped caller may change (filter-then-pick on
     * `request.membership.account_id`, above); without this, the confinement was
     * undermined by its own tidy-up — an account_admin scoped to account A could
     * remove a user from A and, as a side effect nobody asked for, close that
     * user's staffing on every campaign in sibling accounts B and C too. A
     * tenant-wide caller (`callerAccountId === null`) is unrestricted, exactly as
     * before this fix.
     */
    const callerAccountId = request.membership?.account_id ?? null;
    const closed = callerAccountId !== null
      ? await agencyCampaignAgentRepository.closeAllForUser(
        request.tenantId!,
        targetUserId,
        callerAccountId,
      )
      : await agencyCampaignAgentRepository.closeAllForUser(
        request.tenantId!,
        targetUserId,
      );
    if (closed.length === 0) return;

    log.info(
      {
        tenantId: request.tenantId,
        targetUserId,
        actingUserId: request.user?.id,
        closed: closed.length,
        reason,
      },
      'Closed agency campaign staffing on offboarding',
    );

    for (const row of closed) {
      /**
       * The SAME action a supervisor's manual unassign writes
       * (`agency_campaign_agent.unassigned`), one row per closed assignment, so a
       * staffing change has one shape in the trail however it was caused — and so
       * the merged campaign activity view (`agency-activity.ts`) picks these up
       * with no new vocabulary entry and no client change.
       *
       * `reason` in `details` is what distinguishes them. Without it a supervisor
       * reading the trail sees their whole roster quietly unstaffed by an admin
       * who was, as far as that screen could say, editing staffing — when in fact
       * somebody left the workspace. The trail has to explain WHY staffing changed
       * or it invites exactly the wrong conclusion.
       *
       * `resource_id` is the ASSIGNMENT id, not the campaign id — the mistake
       * `unassign`'s docstring records, and the reason `closeAllForUser` returns
       * rows rather than a count. `user_id` is the ACTOR (who offboarded them),
       * matching every other audit row on this feature; the person unstaffed is in
       * `details`.
       *
       * ── `account_id` is the ASSIGNMENT's, not the actor's ─────────────────
       * A tenant-wide caller's close reaches assignments across EVERY account in
       * the tenant (an account-scoped caller's close is narrowed above, but the
       * closed row's OWN account is still what gets stamped, never the caller's),
       * and `GET /audit-log` is account-scoped: `auditAccountScope` confines an
       * account-scoped membership to rows stamped with its own account. Stamping
       * `request.accountId` put a whole tenant's worth of rows under whichever
       * account the offboarding admin happened to have selected, so the
       * `account_admin` whose roster had just changed saw nothing — and this route
       * floors at `tenant_admin`, for whom omitting `X-Account-Id` is entirely
       * legal, in which case every row was account-less and no account-scoped
       * admin saw any of it. The account travels back with each closed row so the
       * trail lands where the change actually happened.
       *
       * A NULL is left NULL rather than back-filled from the actor. The column
       * records the account context the assignment was MADE in and a tenant-level
       * member writes NULL, so there is no account to file such a row under —
       * inventing one would be the same wrong answer this fixes, one row at a time.
       */
      platformAuditLogger.log({
        tenant_id: request.tenantId!,
        ...(row.account_id ? { account_id: row.account_id } : {}),
        ...requestAuditActor(request),
        action: 'agency_campaign_agent.unassigned',
        resource_type: 'agency_campaign_agent',
        resource_id: row.id,
        campaign_id: row.campaign_id,
        details: { campaign_id: row.campaign_id, user_id: targetUserId, reason },
      });
    }
  } catch (err) {
    // Logged at ERROR — it is a real fault and leaves rows to clean up — but
    // swallowed, because the caller's authoritative change has already committed
    // and re-raising would report a failure for work that succeeded.
    log.error(
      {
        tenantId: request.tenantId,
        targetUserId,
        reason,
        err: err instanceof Error ? err.message : String(err),
      },
      'Could not close agency campaign staffing after an offboarding; membership change stands',
    );
  }
}

/**
 * Refuse when the caller's membership is account-scoped and disagrees with a
 * target account id.
 *
 * `requirePermission()` proves the caller's ROLE and never inspects which
 * account their membership is scoped to — nothing stops a `tenant_admin` or
 * `account_admin` membership from ALSO being account-scoped, since role and
 * `account_id` are independent columns. Mirrors `accountScopeMismatch` in
 * `account.routes.ts` and `credit.routes.ts`.
 *
 * A tenant-wide membership (`account_id === null`, or absent altogether) is
 * unrestricted, by design.
 */
function accountScopeMismatch(request: FastifyRequest, targetAccountId: string | null): boolean {
  const callerAccountId = request.membership?.account_id;
  return callerAccountId != null && callerAccountId !== targetAccountId;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /**
   * POST /users/invite — invite user by email (account_admin+)
   * Creates a placeholder membership. User activates on first Firebase login.
   */
  app.post('/invite', {
    preHandler: [requirePermission('user.invite')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(inviteUserSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { email, role, account_id } = parsed.data;

    // Check that inviter can manage the target role
    // Fails closed without a membership rather than relying on
    // `requirePermission` having run first.
    if (!request.membership || !canManageRole(request.membership.role, role as MembershipRole)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Cannot invite with a role equal to or above your own' });
    }

    /**
     * An account-scoped inviter may only invite into THEIR OWN account.
     * Omitting `account_id` (⇒ a tenant-wide membership, reaching every
     * account) or naming a sibling account are both refused — the omission
     * case is the dangerous one: it would let an account-scoped
     * `account_admin` hand out access wider than their own, which
     * `canManageRole` alone cannot catch (it only compares ROLES).
     */
    if (accountScopeMismatch(request, account_id ?? null)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'account_id must match your account-scoped membership',
      });
    }

    /**
     * `account_id` is caller-supplied and previously went straight into the
     * membership row with no check that it belongs to `request.tenantId`.
     * `memberships.account_id` is `REFERENCES accounts(id)`
     * with no composite FK back to the tenant, so nothing else in the schema
     * catches this — a tenant_admin of tenant A could invite a user against
     * an `account_id` that belongs to tenant B, and every reader downstream
     * (RBAC's account-scoped membership match, `GET /accounts/mine`, any
     * future account-scoped route) inherits a membership that quietly
     * crosses a tenant boundary.
     *
     * **`findByIdInTenant`, not `findById` plus a comparison.** This route is
     * tenant-facing, so it takes the scoped lookup the repository's contract
     * points every such caller at — the first version of this check used the
     * deliberately-unscoped `findById` and compared `tenant_id` here, which
     * refuses the same requests but materializes a foreign tenant's whole row
     * (`name`, `settings`, `status`) into this process first. That is the shape
     * the `update`/`softDelete`/`findByIds` fixes exist to remove: the boundary
     * belongs in the same statement as the lookup, not in an `if` downstream of
     * it, or the next reader adds a log line, an error message or a response
     * field over the row that was never theirs to see.
     *
     * Same error for "not found" and "wrong tenant" so this can't be used to
     * probe whether an id exists elsewhere — and with the scoped lookup that is
     * structural rather than a convention to maintain: both cases are one `null`
     * and there is no second branch that could drift apart from the first.
     *
     * The address lookup below is independent of this one, so both start together
     * and are answered in this order (`settledValue`): an account refusal still
     * comes before anything the address lookup found or threw.
     */
    const [accountRead, resolvedRead] = await Promise.allSettled([
      account_id ? accountRepository.findByIdInTenant(account_id, request.tenantId!) : Promise.resolve(null),
      userRepository.resolveByProvenEmail(email),
    ]);
    if (account_id) {
      const targetAccount = settledValue(accountRead);
      if (!targetAccount) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'account_id does not belong to this tenant.',
        });
      }
    }

    /**
     * Find or create the user stub.
     *
     * ── The reuse is deliberate, and it is ALSO the takeover surface ─────────
     * An address that is already known gets its existing `users` row, which is
     * what makes a person invited by two workspaces one person rather than two.
     * `users.email` carries only a non-unique index,
     * so minting a second row here instead would
     * not fail — it would silently split the address, and
     * `POST /auth/session` path 2 (`findByEmail`, "whichever row Postgres hands
     * back first") would then activate one of the two and leave the other
     * tenant's invitation permanently unclaimable. Path 2 is still an
     * activation mechanism for EVERY role — an invitee may ignore the mailed
     * link and simply sign in with the invited, verified address — so splitting
     * the row would break the ordinary multi-tenant invite outright.
     *
     * What the reuse costs is that the row this route aims a membership at may
     * be an unclaimed `pending_` stub another workspace is waiting on: a
     * super-admin-provisioned owner, or somebody else's pending invitee. Since
     * invites mint a token (for every role, now) and hand
     * the raw join link back to the INVITER, that let anybody with a tenant of
     * their own — which is everybody, `auth.routes.ts` path 4 — obtain a live
     * credential for a row they do not own, and claiming it returned every
     * membership on the row.
     *
     * That is closed at the BIND rather than here, and it has to be: the two
     * memberships can be written in either order, so an invite-time check would
     * be looking for a row that does not exist yet when the attacker moves
     * first and a super admin provisions onto the stub afterwards.
     * `AdoptIdentityOptions.confineStubToTenantId` is the guard; a claim may
     * activate only the tenant its token names, and a genuinely shared stub is
     * activated by proving the ADDRESS at `POST /auth/session` instead.
     *
     * ── The one row this route must NOT reuse, and why the check is here ────
     * `findByProvenEmail`, not `findByEmail`. A claim can bind an identity
     * without proving the address (an unverified Firebase token is accepted on
     * purpose), so a bound row can key under an address its owner does not
     * control — and this route is the payoff: it takes a typed-in address and
     * writes a membership against whatever row matches. An attacker who
     * self-invites `victim@corp.test` and claims it is then handed every later
     * invitation anybody sends to that address, including a super admin's
     * `tenant_owner`.
     *
     * Unlike the claim-side guard above, this one CAN live here: the poisoned
     * row already exists by the time anybody names the address again.
     *
     * ── A miss is TWO answers, and treating them as one stranded memberships ─
     * `none` writes a fresh stub, which is right: two principals sharing a
     * string, on a column that has never been unique, and the other person's
     * claim carries a different uid so it binds cleanly.
     * `unproven_conflict` — every row for this address is flagged — is a
     * REFUSAL. A flagged row is always bound, so the fresh stub would be a
     * second row for an identity that already has one, and `firebase_uid` is
     * UNIQUE: when that same person claims this invitation the bind raises
     * `23505` and they are told `identity_in_use`, with the membership left on
     * a row nothing can activate and nobody watching. Refusing names the
     * remedy instead, and it is a remedy the recipient can actually perform.
     */
    const resolved = settledValue(resolvedRead);
    if (resolved.status === 'unproven_conflict') {
      log.warn(
        { tenantId: request.tenantId },
        'Invite refused: every user row for this address is email_unverified',
      );
      return reply.code(409).send(unverifiedAddressHolderBody('send the invitation again'));
    }

    // The write itself — find-or-stub, then create or reactivate, each write guarded
    // against a concurrent claim (`requireProvenEmail`) — is `inviteMember`'s; it
    // carries the reasoning. Every refusal below means nothing was written.
    const invited = await inviteMember({
      tenantId: request.tenantId!,
      email,
      role: role as MembershipRole,
      accountId: account_id ?? null,
      invitedBy: request.user?.id,
      resolved,
    });
    if (invited.status === 'unproven_conflict') {
      return reply.code(409).send(unverifiedAddressHolderBody('send the invitation again'));
    }
    /**
     * The row this invite resolved no longer answers to this address. Retrying is the
     * remedy and it genuinely works. Deliberately NOT the `unverified_address_holder`
     * wording above — nothing here is waiting on somebody to verify an address, and
     * sending an admin to chase that would be advice about the wrong person.
     */
    if (invited.status === 'address_rebound') {
      return reply.code(409).send({
        error: 'Conflict',
        code: ADDRESS_REBOUND_DURING_INVITE,
        message:
          'That email address was claimed by someone signing in while this invitation '
          + 'was being created. Nothing was changed — please send the invitation again.',
      });
    }
    if (invited.status === 'already_member') {
      return reply.code(409).send({ error: 'Conflict', message: 'User already has a membership in this context' });
    }
    const { membership, user } = invited;

    await redisCache.del(membershipCacheKey(user.id, request.tenantId!));

    /**
     * The invite email — attempted AFTER the membership is written, and unable to
     * affect it.
     *
     * ── Ordering ───────────────────────────────────────────────────────────
     * The membership is the real outcome: it is what makes the invitee's first
     * Firebase sign-in adopt the stub user and land them in this workspace. The
     * email only tells them to go and do that. So it runs last and its result is
     * reported rather than acted on.
     *
     * `sendInviteEmail` is documented as TOTAL — it returns a reason for every
     * failure and never rejects — and it is still wrapped, because that totality is
     * a promise made in a docstring and this is the one place where breaking it
     * would be expensive: a membership written, and a 201 turned into a masked 500
     * telling the supervisor their invite failed. The transport this seam is waiting
     * for is exactly the kind of change that could break it. So the requirement
     * "must never fail the invite" is made structural here rather than left
     * depending on the callee keeping its word.
     *
     * ── EVERYTHING to do with the invitation IS INSIDE THE GUARD ──────────
     * (`issueInviteReportingFailure`, shared with the super-admin add.)
     * `issueInvite` mints a token, writes a `membership_invites` row, reads the
     * tenant and inviter names, resolves the join URL and sends the mail — five
     * things that can fail, and every one of them after the membership has
     * committed.
     *
     * The shape to watch for: anything that resolves config through a lazy
     * `import('../config/index.js')` (as the join URL does) must stay inside the
     * `try`. A config failure outside it escapes as a 500 on a request whose
     * membership has already been written — the supervisor is told the invite
     * failed, retries, and gets a 409 from the row the "failed" attempt created. A
     * lie about a durable write is worse than the cosmetic 500 it looks like. A
     * test file that mocks every config-touching module at its top does not see a
     * lazy `import()` inside a function, so this is easy to miss.
     *
     * `sign_in_url: null` is the right degraded value rather than an invention:
     * the response already documents `null` as "`CONSOLE_BASE_URL` is unset", and
     * "could not be resolved" is the same fact from the caller's side.
     *
     * ── What a failure here COSTS ─────────────────────────────────────────
     * The invitee's mail — and for somebody with no account yet that mail is
     * their only route in (neither `/agency/login` nor `/login` has a signup).
     * The recovery is `POST /invites/resend`,
     * which is the reason that route exists rather than being a convenience: the
     * membership is written, the response says `sent: false` with a reason, and a
     * supervisor can re-issue without deleting and re-inviting.
     */
    const { signInUrl, inviteEmail, inviteId } = await issueInviteReportingFailure({
      membershipId: membership.id,
      tenantId: request.tenantId!,
      email,
      role: role as MembershipRole,
      invitedBy: request.user?.id ?? null,
    }, user.id);

    /**
     * The audit row is written AFTER the guard and outside it, so it records
     * what actually happened — including a failed send.
     *
     * `auditLogger.log` is a buffered, non-throwing push, so it cannot itself
     * turn a written membership into a 500; that is why it does not need the
     * guard. Recording the failure rather than skipping the row is the point:
     * "an invitation was issued for this membership and the mail did not leave"
     * is the exact thing a supervisor's support ticket is about, and a row that
     * only exists on success cannot answer it.
     */
    platformAuditLogger.log({
      tenant_id: request.tenantId!,
      ...(membership.account_id ? { account_id: membership.account_id } : {}),
      ...requestAuditActor(request),
      action: 'user.invite_sent',
      resource_type: 'membership_invite',
      // Absent only when issuance threw before the row could be named
      // (`issueInviteReportingFailure` reports `inviteId: null` then): a
      // `resource_id` naming the membership instead would read as a membership
      // change on the audit screen.
      ...(inviteId ? { resource_id: inviteId } : {}),
      details: {
        membership_id: membership.id,
        role,
        resend: false,
        email_sent: inviteEmail.sent,
        ...(inviteEmail.sent ? {} : { email_reason: inviteEmail.reason }),
      },
      ip_address: request.ip,
    });

    return reply.code(201).send({
      // ADDITIVE ONLY — `membership` and `user` keep their exact shapes and
      // meanings. Existing consumers (including the customer UI's invite modal,
      // which reads `user.email` and the role it sent) are unaffected; a client
      // that ignores the two new keys behaves exactly as it does today.
      membership,
      user: { id: user.id, email: user.email },
      /**
       * Whether the invitee was actually told. This is the field the customer UI
       * needs before it can stop instructing supervisors to send the link
       * themselves — `sent: false` means keep showing the hand-off panel.
       *
       * `reason` is present only on a failure, and it is not decoration:
       * `not_configured` is an operator's problem and `failed` is the mail
       * provider's. A bare boolean would send both to the same place.
       * (`not_implemented` — "this role has no invitation" — was the third, and no
       * role produces it now that every role has a claim page.)
       */
      invite_email: inviteEmail.sent
        ? { sent: true }
        : { sent: false, reason: inviteEmail.reason },
      /**
       * The link the invitee needs, so the hand-off panel can eventually stop
       * deriving it from `window.location.origin` (the console's `inviteSignInUrl`;
       * see the mailer's docstring for why the duplication is accepted for now).
       * `null` when `CONSOLE_BASE_URL` is unset — the KEY is always present, because
       * a sometimes-absent key is indistinguishable from one a client forgot to
       * read.
       */
      sign_in_url: signInUrl,
    });
  });

  /**
   * PUT /users/:id/role — update role (tenant_admin+)
   */
  app.put<{ Params: { id: string } }>('/:id/role', {
    preHandler: [requirePermission('user.update_role')],
  }, async (request, reply) => {
    const parsed = parseOr400(updateRoleSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { role } = parsed.data;
    const targetUserId = request.params.id;

    // Find the target's membership
    const memberships = await membershipRepository.findByUserAndTenant(targetUserId, request.tenantId!);

    /**
     * An account-scoped caller may only manage a membership scoped to THEIR
     * OWN account — never a tenant-wide membership (which reaches every
     * account) nor a sibling account's. This MUST filter before
     * `primaryMembership` picks, not after: a target can hold one membership
     * per account (invite's own duplicate check), so a user who is
     * `operator` on account A and `account_admin` on account B has TWO rows
     * here. `primaryMembership` picks by ROLE STRENGTH across all of them —
     * picking the strongest row first and THEN checking it against the
     * caller's scope means A's own admin is refused for a user who plainly
     * has a membership in A, because the B row outranked it and got picked
     * instead. Filtering to the caller's account first, then picking primary
     * among the survivors, is what makes "the row in my account" the actual
     * subject rather than "the target's single strongest row, wherever it is".
     * A tenant-wide caller (`callerAccountId === null`) is unrestricted, so
     * every row is a candidate — unchanged from before this fix.
     */
    const callerAccountId = request.membership?.account_id ?? null;
    const targetMembership = primaryMembership(
      callerAccountId !== null
        ? memberships.filter((m) => m.account_id === callerAccountId)
        : memberships,
    );
    if (!targetMembership) {
      // Covers both "no membership at all" and "none in the caller's own
      // account" — indistinguishable on purpose, same reasoning as
      // `account.routes.ts`'s cross-account 404.
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // `canManageRole` on the NEW role alone is not enough: a tenant_admin
    // assigning `viewer` passes that check while the target is a tenant_owner.
    // Require the caller to outrank the CURRENT role too (co-owners allowed;
    // last-owner is refused below).
    // Fails closed without a membership rather than relying on
    // `requirePermission` having run first.
    if (!request.membership || !canManageExistingRole(request.membership.role, targetMembership.role)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Cannot manage a user with a role equal to or above your own',
      });
    }

    // Can only assign roles below own level
    // Fails closed without a membership rather than relying on
    // `requirePermission` having run first.
    if (!request.membership || !canManageRole(request.membership.role, role as MembershipRole)) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Cannot assign a role equal to or above your own' });
    }

    // `role` cannot be `tenant_owner` (the schema forbids assigning it), so any
    // PUT against an owner membership is a demotion — and a demotion that
    // leaves zero owners cannot be undone through this API. The last-owner
    // check therefore happens inside the write's transaction, not here: read
    // the count then write and two concurrent demotions both see two owners.
    // The role read above is re-asserted there too, so a promotion racing this
    // request cannot land on a stale `canManageExistingRole` verdict.
    const result = await membershipRepository.updateRoleGuardingLastOwner(
      targetMembership.id,
      request.tenantId!,
      targetMembership.role,
      role as MembershipRole,
    );
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot demote the last tenant owner' });
      }
      if (result.reason === 'role_changed') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This member\u2019s role changed while the request was in flight. Reload and try again.',
        });
      }
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // Q5 (Manas, 2026-10-09): a role change can REDUCE access, so the cache delete is
    // retried and its failure answered 503 — but only after every other effect below, because
    // the retry must be able to finish the job: re-sent, this route re-applies the same role
    // (the guard reads the now-current role), deletes the key again, and has nothing left to
    // close (the staffing step keys on the demotion, which has already happened).
    const membershipCacheCleared = await redisCache.delForRevocation(membershipCacheKey(targetUserId, request.tenantId!));

    /**
     * A demotion out of `agent` closes their agency staffing — last, and unable to
     * fail this request.
     *
     * ── Ordering, and why it is this way round ─────────────────────────────
     * The role write is the authoritative change and the cache `del` is what makes
     * it take effect across instances at once (see the header of
     * `cache/local-cache.ts` — that broadcast is why `PUT /:id/role` deletes the key at all).
     * Staffing is neither: closing a row revokes nothing. So the order is
     * authoritative write → invalidation → tidy-up, and a failure in the tidy-up
     * leaves a stale navigation entry rather than a stale permission.
     *
     * ── The two reads it decides from ─────────────────────────────────────
     * `targetMembership.role` is the role that was actually replaced —
     * re-asserted inside `updateRoleGuardingLastOwner`'s transaction, so this is
     * not a stale value racing a concurrent promotion.
     *
     * The second condition is the one worth spelling out: a user may hold SEVERAL
     * memberships in one tenant (one per account, plus possibly a tenant-level
     * one), and this route changes exactly one of them. `agent` is the lowest rung
     * of the hierarchy, so `primaryMembership` picking an `agent` row means every
     * membership they hold here is `agent` — but demoting one still leaves the
     * others, and those still make them an agent in this tenant. Closing staffing
     * then would take a working agent off their campaigns. The surviving
     * memberships are read from the list already in hand, so this costs no query;
     * it is a decision about staffing rather than about access, which is why a
     * sibling membership racing this request is acceptable here and would not be
     * on a permission check.
     */
    const stillAgentElsewhere = memberships.some(
      (m) => m.id !== targetMembership.id && m.role === 'agent',
    );
    if (isDemotionFromAgent(targetMembership.role, role as MembershipRole) && !stillAgentElsewhere) {
      await closeAgencyStaffing(request, targetUserId, 'role_changed_from_agent');
    }

    if (!membershipCacheCleared) return sendRevocationCacheUnavailable(request, reply);
    return reply.send({ membership: result.value });
  });

  /**
   * DELETE /users/:id/membership — remove user from tenant (tenant_admin+)
   */
  app.delete<{ Params: { id: string } }>('/:id/membership', {
    preHandler: [requirePermission('user.remove')],
  }, async (request, reply) => {
    const targetUserId = request.params.id;

    // Prevent removing yourself
    if (request.user && request.user.id === targetUserId) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove yourself' });
    }

    // Find the target's membership. Same account-scope filter-then-pick order
    // as PUT /:id/role, and for the same reason — see that route's comment.
    const memberships = await membershipRepository.findByUserAndTenant(targetUserId, request.tenantId!);
    const callerAccountId = request.membership?.account_id ?? null;
    const targetMembership = primaryMembership(
      callerAccountId !== null
        ? memberships.filter((m) => m.account_id === callerAccountId)
        : memberships,
    );
    if (!targetMembership) {
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // Same current-role check as PUT /:id/role. Without it a tenant_admin
    // could revoke a co-owner (when more than one remains) or a peer admin:
    // DELETE previously only protected the last owner.
    // Fails closed without a membership rather than relying on
    // `requirePermission` having run first.
    if (!request.membership || !canManageExistingRole(request.membership.role, targetMembership.role)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'Cannot manage a user with a role equal to or above your own',
      });
    }

    // Prevent removing last tenant_owner. Same reasoning as PUT /:id/role: the
    // count and the revoke are one transaction, because a count read separately
    // lets two concurrent removals each see the other's owner and commit.
    const result = await membershipRepository.removeGuardingLastOwner(
      targetMembership.id,
      request.tenantId!,
      targetMembership.role,
    );
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove the last tenant owner' });
      }
      if (result.reason === 'role_changed') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This member\u2019s role changed while the request was in flight. Reload and try again.',
        });
      }
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // Q5 (Manas, 2026-10-09): a revocation, so the delete is retried and a final failure is
    // logged at ERROR (`delForRevocation`). The 2xx is KEPT: this route is not idempotent on
    // retry — the membership is already gone, so a re-sent DELETE answers 404 before it
    // reaches this line and could never clear the key. A 503 would only send the admin into
    // a retry that cannot help; the TTL (30 min) bounds the exposure.
    await redisCache.delForRevocation(membershipCacheKey(targetUserId, request.tenantId!));

    /**
     * Close their agency staffing — last, and unable to fail this request.
     *
     * ── Ordering, stated as the reason rather than as the sequence ─────────
     * The membership removal is the authoritative change and it has already
     * committed; the cache `del` is what makes the revocation take effect on every
     * instance rather than after a TTL. Both of those are access. Staffing is not:
     * a closed row revokes nothing (see `closeAgencyStaffing`), so it goes last and
     * its failure is swallowed there. Doing it FIRST would be strictly worse in the
     * only case that distinguishes the two orders — the removal then failing would
     * leave a member unstaffed from every campaign for no reason anybody can see,
     * and a supervisor would have to reconstruct the roster by hand.
     *
     * ── Unconditional here, unlike the role route ─────────────────────────
     * No `agent`-role predicate. A membership removal takes away
     * `agency.station.connect` outright, whatever the role was, so nobody who no
     * longer has a membership should appear on a staffing list — and supervisors
     * and admins can be staffed too (covering a shift is an ordinary act). Filtering
     * on `role === 'agent'` here would leave exactly those rows behind, which is
     * the leak restated one role narrower.
     *
     * One nuance the multi-membership case makes real: a user with a tenant-level
     * membership AND an account-scoped one keeps the other, since this route removes
     * one row. Their staffing is still closed, which is the safe direction — a
     * supervisor can restaff in one click, whereas a row left standing for someone
     * half-removed is the exact residue this closes.
     */
    await closeAgencyStaffing(request, targetUserId, 'membership_removed');

    return reply.send({ message: 'Membership removed' });
  });
}
