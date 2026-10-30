/*
 * Tenants (list, create, detail), adding a user to a tenant, a membership's role change
 * and revoke, and the cross-tenant users list. Part of `super-admin.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PENDING_UID_PREFIX } from '../../../auth/firebase-identity.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { redisCache } from '../../../cache/redis-cache.js';
import { membershipCacheKey } from '../../middleware/membership-cache-key.js';
import { sendRevocationCacheUnavailable } from '../../../cache/revocation-unavailable.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { getPool } from '@magick-agency/db';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { recordSuperAdminAudit } from '../../../audit/super-admin-audit.js';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import { settledValue } from '../helpers/settled.js';
// The create-or-reactivate transactions and the guarded invitation, shared with
// `POST /users/invite` (`src/invites/membership-provisioning.ts`).
import {
  addTenantMember,
  isDemotionFromAgent,
  issueInviteReportingFailure,
  provisionTenantWithOwner,
  unverifiedAddressHolderBody,
} from '../../../invites/membership-provisioning.js';
import type { InviteEmailResult } from '../../../notifications/invite-mailer.js';
import { createChildLogger } from '@magick-agency/observability';
import { createTenantSchema, addUserToTenantSchema, changeMembershipRoleSchema } from '../../validators/super-admin.validator.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

const log = createChildLogger({ component: 'super-admin-routes' });

/**
 * Close a user's campaign staffing across the whole tenant, as
 * `closeAgencyStaffing` in `user.routes.ts` does for a tenant-wide caller
 * (`closeAllForUser(tenantId, userId)` with no account) — a super admin is never
 * account-scoped.
 *
 * Never throws: the membership change it follows has already committed, and a
 * closed staffing row revokes nothing (staffing is not authorization), so a
 * failure leaves a stale navigation entry rather than a stale permission. The
 * closed rows are returned for the super-admin audit row.
 *
 * NOT written: per-row `agency_campaign_agent.unassigned` platform audit rows.
 * Their actor is `requestAuditActor(request)` — a `users` id — and a super admin
 * is not a user; the platform actor union (`human` | `system`) has no super-admin
 * shape, and `system` means "no caller existed". The closed assignment ids and
 * campaigns go on the super-admin audit row instead.
 */
async function closeStaffingTenantWide(
  tenantId: string,
  userId: string,
  reason: 'membership_removed' | 'role_changed_from_agent',
): Promise<Array<{ id: string; campaign_id: string; account_id: string | null }>> {
  try {
    const closed = await agencyCampaignAgentRepository.closeAllForUser(tenantId, userId);
    if (closed.length > 0) {
      log.info({ tenantId, targetUserId: userId, closed: closed.length, reason }, 'Closed agency campaign staffing on super-admin membership change');
    }
    return closed;
  } catch (err) {
    log.error(
      { tenantId, targetUserId: userId, reason, err: err instanceof Error ? err.message : String(err) },
      'Could not close agency campaign staffing after a super-admin membership change; membership change stands',
    );
    return [];
  }
}

/**
 * Whether the invitee was emailed, as tenant create and add-user answer it — the
 * wire `InviteEmailResult` (`packages/contracts/src/api/platform/team.ts`), so the
 * super admin can be told when somebody was added but not mailed.
 *
 * ── `sign_in_url` is deliberately NOT answered here ────────────────────────
 * `POST /users/invite` hands the raw join link back so a supervisor can pass it on
 * when mail fails. The super-admin UI gets no such hand-off: the link is a
 * single-use credential for a membership in somebody else's workspace — often its
 * `tenant_owner` — and the person holding it is whoever claims it. Keeping it to
 * the invitee's inbox keeps a super admin from being a second route to anybody's
 * ownership, and nothing in that UI needs it. A `sent: false` names the reason
 * instead, so the super admin at least knows the invitee has not been told.
 *
 * `messageId` is dropped, as `POST /users/invite` drops it: the wire shape has
 * no such field.
 */
function inviteEmailBody(result: InviteEmailResult): { sent: true } | { sent: false; reason: string } {
  return result.sent ? { sent: true } : { sent: false, reason: result.reason };
}

/**
 * Registered by `superAdminRoutes` inside its authenticated scope (`authApp`, the one
 * carrying `superAdminMiddleware`), so every route here runs behind it.
 */
export async function registerSuperAdminTenantRoutes(authApp: FastifyInstance): Promise<void> {
  /**
   * GET /super-admin/tenants
   * List all tenants with member count. No credit columns (no credits in v1).
   */
  authApp.get('/tenants', async (_request: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const result = await pool.query(`
      SELECT
        t.*,
        COALESCE(mc.member_count, 0)::int AS member_count
      FROM tenants t
      LEFT JOIN (
        SELECT tenant_id, COUNT(*)::int AS member_count
        FROM memberships
        WHERE status = 'active'
        GROUP BY tenant_id
      ) mc ON mc.tenant_id = t.id
      WHERE t.status != 'deleted'
      ORDER BY t.created_at DESC
    `);
    return reply.send({ tenants: result.rows });
  });

  /**
   * POST /super-admin/tenants
   * Create tenant + owner by email (stub user if email not in system), and invite
   * the owner.
   *
   * No credit balance, no per-tenant API key and no auto-assigned pooled number:
   * none of the three exists here, so `CreateTenantResponse` carries none of them.
   */
  authApp.post('/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(createTenantSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { name, owner_email, owner_name } = parsed.data;

    /**
     * The tenant, its `Default` account, the owner's user row and the
     * `tenant_owner` membership, in one transaction (`provisionTenantWithOwner`).
     * The owner is found by PROVEN address only (`email_unverified = false`): a row
     * bound by an unverified invite claim keys under an address its owner does not
     * control, and reusing it would hand this tenant's OWNERSHIP to whoever claimed
     * it — an attacker who self-invites `owner@customer.com` into their own tenant and
     * claims it is waiting for exactly that.
     *
     * Every row for this address flagged: the identity already bound to it holds the
     * only `users` row there is, and a fresh stub made `tenant_owner` would be a
     * membership nobody can ever claim (`firebase_uid` is UNIQUE, so that person's
     * claim raises `23505`). Refused with the remedy instead, and nothing is written.
     */
    const provisioned = await provisionTenantWithOwner({
      name,
      slug: generateSlug(name),
      ownerEmail: owner_email,
      ownerName: owner_name,
    });
    if (provisioned.status === 'unproven_conflict') {
      return reply.code(409).send(unverifiedAddressHolderBody('create the workspace again'));
    }
    const { tenant, ownerMembershipId, ownerUserId } = provisioned;

    /**
     * The owner's invitation — the same artefact add-user below issues, and for
     * its reasons: a token, a `membership_invites` row and the workspace mail with
     * a `/join/:token` link. Without it the owner of a new tenant is told nothing,
     * and a `pending_` owner with no account yet is left with session path 2 alone
     * — a verified sign-in on exactly that address — and nothing telling them to try
     * it (`/login` has no signup, and nobody in the new tenant can invite them).
     *
     * An owner address that already resolves to a PROVEN user is mailed a token
     * too, rather than skipped: the claim admits a row already carrying the
     * claimant's own uid (see `invite-issuer.ts`), so the rightful owner spends it
     * and lands in the new workspace, and a different identity is still refused.
     *
     * No membership-cache `del`, unlike add-user: the tenant id was minted by the
     * transaction that just committed, so no snapshot can be cached under it yet.
     * Guarded (`issueInviteReportingFailure`) because the tenant has committed: a
     * mail failure must not become a 500 telling the super admin the create failed,
     * whose retry would then make a second tenant. `invitedBy: null`, as below.
     */
    const { inviteEmail, inviteId } = await issueInviteReportingFailure({
      membershipId: ownerMembershipId,
      tenantId: tenant.id,
      email: owner_email,
      role: 'tenant_owner',
      invitedBy: null,
    }, ownerUserId);

    log.info({ tenantId: tenant.id, ownerEmail: owner_email }, 'Super admin created tenant');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'create_tenant', resource_type: 'tenant', resource_id: tenant.id,
      details: {
        tenant_name: name, owner_email,
        // The owner's membership and the invitation's outcome, as add-user records.
        membership_id: ownerMembershipId,
        invite_id: inviteId,
        email_sent: inviteEmail.sent,
        ...(inviteEmail.sent ? {} : { email_reason: inviteEmail.reason }),
      },
    });

    return reply.code(201).send({ tenant, owner_email, invite_email: inviteEmailBody(inviteEmail) });
  });

  /**
   * GET /super-admin/tenants/:id
   * Tenant detail with members. No credit fields (no credits in v1; contract
   * `SuperAdminTenantDetail`).
   */
  authApp.get('/tenants/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const tenant = await tenantRepository.findById(id);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const pool = getPool();
    const membersResult = await pool.query(
      `SELECT m.*, u.email, u.phone_number, u.display_name, u.avatar_url, u.status AS user_status
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status = 'active'
       ORDER BY m.created_at ASC`,
      [id],
    );

    return reply.send({
      tenant,
      members: membersResult.rows,
    });
  });

  // No tenant delete route — see the module note in `super-admin.routes.ts`.

  /**
   * POST /super-admin/tenants/:id/users
   * Add user to tenant (or to one of its accounts) by email + role, and issue
   * the invitation.
   */
  authApp.post('/tenants/:id/users', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: tenantId } = request.params;
    const parsed = parseOr400(addUserToTenantSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { email, role, name, account_id } = parsed.data;

    /**
     * The account must belong to THIS tenant: `memberships.account_id`
     * references `accounts(id)` with no composite FK back to the tenant, so
     * nothing in the schema would catch a sibling tenant's account. Same scoped
     * lookup, same refusal and wording as `POST /users/invite`.
     *
     * Both reads start together and are answered in order (`settledValue`): an
     * unknown tenant is still the 404 before any account refusal.
     */
    const [tenantRead, accountRead] = await Promise.allSettled([
      tenantRepository.findById(tenantId),
      account_id ? accountRepository.findByIdInTenant(account_id, tenantId) : Promise.resolve(null),
    ]);
    const tenant = settledValue(tenantRead);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    if (account_id) {
      const targetAccount = settledValue(accountRead);
      if (!targetAccount) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'account_id does not belong to this tenant.',
        });
      }
    }
    const contextAccountId = account_id ?? null;

    /**
     * Find or stub the user (by PROVEN address, for the tenant-create reason above),
     * then create or reactivate their membership in this context — one transaction
     * with the rows locked (`addTenantMember`, which states the three rules).
     */
    const added = await addTenantMember({
      tenantId,
      email,
      role: role as MembershipRole,
      name,
      accountId: contextAccountId,
    });
    // Same refusal, same reason, as the tenant-create lookup above.
    if (added.status === 'unproven_conflict') {
      return reply.code(409).send(unverifiedAddressHolderBody('add them again'));
    }
    if (added.status === 'already_member') {
      return reply.code(409).send({
        error: 'Conflict',
        message: contextAccountId === null
          ? 'User is already a member of this tenant'
          : 'User is already a member of this account',
      });
    }
    const { membership, userId } = added;

    // Same key `tenantContextMiddleware` reads — a re-added user must not keep
    // serving the empty/revoked snapshot from before the write.
    await redisCache.del(membershipCacheKey(userId, tenantId));

    /**
     * Super-admin add creates a `pending_` stub plus membership and sends an
     * invite, through the shared `issueInvite`, so a super-admin invitation is the
     * same artefact `POST /users/invite` produces: a token, a `membership_invites`
     * row and the mail for EVERY role — the agency claim page for an `agent`, the
     * workspace one for everyone else. Session path 2 (a
     * verified email on the `pending_` stub) still activates an invitee who
     * ignores the link and simply signs in.
     *
     * Guarded exactly as `POST /users/invite` guards it
     * (`issueInviteReportingFailure`), for its reason: the membership has committed,
     * so a failure here must not turn into a 500 that tells the super admin the add
     * failed. `invitedBy` is `null` — a super admin
     * is not a `users` row (`membership_invites.invited_by` names a user, and the
     * mail names the inviter from `users.display_name`).
     */
    const { inviteEmail, inviteId } = await issueInviteReportingFailure({
      membershipId: membership.id,
      tenantId,
      email,
      role: role as MembershipRole,
      invitedBy: null,
    }, userId);

    log.info({ tenantId, email, role, accountId: contextAccountId }, 'Super admin added user to tenant');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'add_user_to_tenant', resource_type: 'membership', resource_id: tenantId,
      details: {
        email, role, name: name || null,
        // The account context and the invitation's outcome.
        account_id: contextAccountId,
        membership_id: membership.id,
        invite_id: inviteId,
        email_sent: inviteEmail.sent,
        ...(inviteEmail.sent ? {} : { email_reason: inviteEmail.reason }),
      },
    });

    return reply.code(201).send({ membership, invite_email: inviteEmailBody(inviteEmail) });
  });

  /**
   * PUT /super-admin/tenants/:id/memberships/:membershipId/role
   *
   * Contract `ChangeMembershipRole*`. The tenant-side `PUT /users/:id/role`
   * (`user.routes.ts`) minus the caller-role checks (`canManageExistingRole` /
   * `canManageRole` compare the CALLER's membership, and a super admin has none)
   * and with the membership named by id rather than picked by
   * `primaryMembership`. The same as it: the last-owner compare-and-swap
   * (`updateRoleGuardingLastOwner`), its three refusals and their wording, the
   * membership cache `del`, and closing staffing on a demotion out of `agent`
   * unless the user is still an agent through another membership in the tenant.
   */
  authApp.put('/tenants/:id/memberships/:membershipId/role', async (
    request: FastifyRequest<{ Params: { id: string; membershipId: string } }>,
    reply: FastifyReply,
  ) => {
    const { id: tenantId, membershipId } = request.params;
    const parsed = parseOr400(changeMembershipRoleSchema, request.body, reply, 'platform');
    if (!parsed) return reply;
    const { role, reason } = parsed.data;

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }
    const target = await membershipRepository.findByIdInTenant(membershipId, tenantId);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    const result = await membershipRepository.updateRoleGuardingLastOwner(
      target.id,
      tenantId,
      target.role,
      role as MembershipRole,
    );
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot demote the last tenant owner' });
      }
      if (result.reason === 'role_changed') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This member’s role changed while the request was in flight. Reload and try again.',
        });
      }
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // Q5 (Manas, 2026-10-09): a role change can reduce access — retried delete, and a 503
    // after every other effect (staffing, audit) if it still failed. Idempotent on retry:
    // the membership is re-read with its new role, the same role is re-applied, the key is
    // deleted again, and the demotion's staffing close has nothing left to do.
    const membershipCacheCleared = await redisCache.delForRevocation(membershipCacheKey(target.user_id, tenantId));

    let staffingClosed: Array<{ id: string; campaign_id: string; account_id: string | null }> = [];
    if (isDemotionFromAgent(target.role, role as MembershipRole)) {
      const memberships = await membershipRepository.findByUserAndTenant(target.user_id, tenantId);
      const stillAgentElsewhere = memberships.some((m) => m.id !== target.id && m.role === 'agent');
      if (!stillAgentElsewhere) {
        staffingClosed = await closeStaffingTenantWide(tenantId, target.user_id, 'role_changed_from_agent');
      }
    }

    log.info({ tenantId, membershipId, from: target.role, to: role }, 'Super admin changed membership role');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'change_membership_role', resource_type: 'membership', resource_id: target.id,
      details: {
        tenant_id: tenantId,
        user_id: target.user_id,
        account_id: target.account_id,
        from_role: target.role,
        to_role: role,
        reason: reason ?? null,
        staffing_closed: staffingClosed.map((row) => ({ id: row.id, campaign_id: row.campaign_id })),
      },
    });

    if (!membershipCacheCleared) return sendRevocationCacheUnavailable(request, reply);
    return reply.send({ membership: result.value });
  });

  /**
   * DELETE /super-admin/tenants/:id/memberships/:membershipId
   *
   * Contract `RevokeMembershipResponse`. The tenant-side `DELETE /users/:id/membership`
   * (`user.routes.ts`) minus the caller checks (no self, no caller-role
   * comparison — a super admin is not a member), naming the membership by id.
   * The same as it: `removeGuardingLastOwner` and its refusals, the cache `del`,
   * and the UNCONDITIONAL staffing close afterwards (revoking a membership closes
   * the agent's campaign staffing in the same place), tenant-wide because a super
   * admin is never account-scoped.
   */
  authApp.delete('/tenants/:id/memberships/:membershipId', async (
    request: FastifyRequest<{ Params: { id: string; membershipId: string } }>,
    reply: FastifyReply,
  ) => {
    const { id: tenantId, membershipId } = request.params;

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }
    const target = await membershipRepository.findByIdInTenant(membershipId, tenantId);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    const result = await membershipRepository.removeGuardingLastOwner(target.id, tenantId, target.role);
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove the last tenant owner' });
      }
      if (result.reason === 'role_changed') {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This member’s role changed while the request was in flight. Reload and try again.',
        });
      }
      return reply.code(404).send({ error: 'Not Found', message: 'User membership not found' });
    }

    // Q5 (Manas, 2026-10-09): retried delete with an ERROR log on final failure; the 2xx is
    // KEPT because a re-sent revoke is not idempotent — `findByIdInTenant` reads active rows
    // only, so the retry 404s before reaching this line. The TTL (30 min) bounds it.
    await redisCache.delForRevocation(membershipCacheKey(target.user_id, tenantId));

    const staffingClosed = await closeStaffingTenantWide(tenantId, target.user_id, 'membership_removed');

    // The row after the write (contract: `status` is `'revoked'`).
    // `removeGuardingLastOwner` returns no row, and `findByIdInTenant` reads
    // active rows only, so the revoked row is read back by user + tenant.
    const after = (await membershipRepository.findAnyByUserAndTenant(target.user_id, tenantId))
      .find((m) => m.id === target.id) ?? { ...target, status: 'revoked' as const };

    log.info({ tenantId, membershipId, staffingClosed: staffingClosed.length }, 'Super admin revoked membership');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'revoke_membership', resource_type: 'membership', resource_id: target.id,
      details: {
        tenant_id: tenantId,
        user_id: target.user_id,
        account_id: target.account_id,
        role: target.role,
        staffing_closed: staffingClosed.map((row) => ({ id: row.id, campaign_id: row.campaign_id })),
      },
    });

    return reply.send({ membership: after, staffing_closed: staffingClosed.length });
  });

  // No credits, tenant service-settings or pipeline-backfill routes — see the
  // module note in `super-admin.routes.ts`.

  /**
   * GET /super-admin/users
   * All users across tenants with their memberships.
   */
  authApp.get('/users', async (_request: FastifyRequest, reply: FastifyReply) => {
    const pool = getPool();
    const result = await pool.query(`
      SELECT
        u.id, u.email, u.phone_number, u.display_name, u.avatar_url, u.status, u.firebase_uid, u.created_at, u.updated_at,
        COALESCE(
          json_agg(
            json_build_object(
              'tenant_id', m.tenant_id,
              'tenant_name', t.name,
              'role', m.role,
              'membership_status', m.status
            )
          ) FILTER (WHERE m.id IS NOT NULL),
          '[]'
        ) AS memberships
      FROM users u
      LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
      LEFT JOIN tenants t ON t.id = m.tenant_id
      WHERE u.status != 'deleted'
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);

    /**
     * `is_pending` is a per-USER fact: this person has never signed in
     * ANYWHERE, so their `firebase_uid` is still the `pending_<uuid>` stub
     * `POST /users/invite` wrote. The constant is imported rather than spelled
     * out so there is one definition of that prefix (`firebase-identity.ts`
     * both writes the predicate that matches it and is where it would change).
     *
     * ── Same question as `invite_state` on `GET /tenants/:id/members` ────────
     * Both are the same stub check over the same column, so for a given user
     * they AGREE by construction: `is_pending: true` here is `invite_state:
     * 'pending'` there, and `false` is `'active'`. They are not two competing
     * definitions and should not be allowed to become two — if this predicate
     * ever changes, `deriveMembershipInviteState` changes with it.
     *
     * The one structural difference is cardinality, not meaning. `is_pending`
     * is one value per USER; `invite_state` is repeated once per MEMBERSHIP
     * row, so a user who holds three memberships shows the same answer three
     * times on the Team pages that render them. Neither the name nor the value
     * changes here on purpose — this endpoint lists users, that one lists
     * memberships.
     */
    const users = result.rows.map(row => ({
      ...row,
      is_pending: row.firebase_uid?.startsWith(PENDING_UID_PREFIX) ?? false,
    }));

    return reply.send({ users });
  });
}

function generateSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    + '-' + Math.random().toString(36).slice(2, 8);
}
