import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config/index.js';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { PENDING_UID_PREFIX, UNVERIFIED_ADDRESS_HOLDER } from '../../auth/firebase-identity.js';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { redisCache } from '../../cache/redis-cache.js';
import { sendRevocationCacheUnavailable } from '../../cache/revocation-unavailable.js';
import { userRepository } from '@magick-agency/db/repositories/user.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { getPool } from '@magick-agency/db';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import {
  ConcurrencyAllocationVersionConflictError,
  providerConcurrencyRepository,
} from '@magick-agency/db/repositories/provider-concurrency.repository';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import type { AccountConcurrencyAllocation } from '@magick-agency/db/models/account-settings.model';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import { getConcurrencyControl } from '../../seams/concurrency-control.js';
import { auditLogger } from '../../audit/audit-logger.js';
import { issueInvite } from '../../invites/invite-issuer.js';
import type { InviteEmailResult } from '../../notifications/invite-mailer.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  superAdminLoginSchema,
  createSuperAdminSchema,
  changePasswordSchema,
  resetAdminPasswordSchema,
  createTenantSchema,
  addUserToTenantSchema,
  superAdminAuditQuerySchema,
  changeMembershipRoleSchema,
} from '../validators/super-admin.validator.js';

const log = createChildLogger({ component: 'super-admin-routes' });

/*
 * Super-admin routes, serving the super-admin console: login (5/min), `/me`,
 * `/change-password`, tenants list/create/detail, add user (with an `account_id`,
 * issuing an invite), users, role change and revoke on a membership, admins
 * (create, list, delete, reactivate, reset password), audit, accounts +
 * concurrency. Deliberately absent:
 *  - credits — no credits in v1 (decision S6);
 *  - AI pipeline/provider service settings — there is no AI calling
 *    (decision S7);
 *  - tenant delete — not part of the super-admin surface;
 *  - concurrency synchronization and drift tracking — this server is both the
 *    system of record and the enforcer, so there is nothing to synchronize or
 *    drift;
 *  - telephony-provider catalog checks on a provider breakdown — one carrier;
 *  - a broadcast-cap cache invalidation — no broadcast campaigns.
 */

const BCRYPT_ROUNDS = 10;
const JWT_EXPIRY = '4h';

/**
 * The utilization read: live counts come from the voice engine's guards through
 * `seams/concurrency-control.ts` (`getAccountProviderCounts` per provider,
 * `getAccountCount` for the account total).
 */
async function readAccountConcurrencyUtilization(
  tenantId: string,
  accountId: string,
  allocation: AccountConcurrencyAllocation,
) {
  const control = getConcurrencyControl();
  const live = await control.getAccountProviderCounts(tenantId, accountId);
  const accountInUse = await control.getAccountCount(tenantId, accountId);
  const allocations = new Map(allocation.providers.map((row) => [row.provider, row.max_concurrent_calls]));
  const providerNames = new Set([...allocations.keys(), ...live.counts.keys()]);
  const providers = [...providerNames].sort().map((provider) => {
    const allocated = allocations.get(provider) ?? 0;
    const inUse = live.status === 'available' ? (live.counts.get(provider) ?? 0) : null;
    return {
      provider,
      allocated,
      in_use: inUse,
      available: inUse === null ? null : Math.max(0, allocated - inUse),
      over_limit: inUse === null ? null : Math.max(0, inUse - allocated),
      saturated: inUse === null ? null : inUse >= allocated,
      draining: allocated === 0 && inUse !== null && inUse > 0,
    };
  });
  return {
    mode: allocation.mode,
    version: allocation.version,
    status: live.status,
    observed_at: new Date().toISOString(),
    total: {
      allocated: allocation.total_concurrency,
      in_use: live.status === 'available' ? accountInUse : null,
      available: live.status === 'available'
        ? Math.max(0, allocation.total_concurrency - accountInUse)
        : null,
    },
    providers,
  };
}

/**
 * Is this role change one that should close the user's agency staffing?
 *
 * The same predicate as `isDemotionFromAgent` in `user.routes.ts`, for the same
 * reason (only a change AWAY from `agent`; see that function's comment for the
 * three directions that must not touch staffing).
 */
function isDemotionFromAgent(from: MembershipRole, to: MembershipRole): boolean {
  return from === 'agent' && to !== 'agent';
}

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

export async function superAdminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /super-admin/login
   * Email + password → JWT (4h expiry). Rate limited separately.
   */
  app.post('/login', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = config.superAdmin?.jwtSecret;
    if (!secret) {
      return reply.code(503).send({ error: 'Service Unavailable', message: 'Super admin not configured' });
    }

    const parsed = superAdminLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { email, password } = parsed.data;
    const admin = await superAdminRepository.findByEmail(email);
    if (!admin) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    if (admin.status !== 'active') {
      return reply.code(403).send({ error: 'Forbidden', message: 'Account is inactive' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { sub: admin.id, email: admin.email, type: 'super_admin' },
      secret,
      { expiresIn: JWT_EXPIRY },
    );

    return reply.send({
      token,
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
      },
    });
  });

  // ── All routes below require super admin JWT ──────────
  await app.register(async function authenticatedRoutes(authApp) {
    authApp.addHook('preHandler', superAdminMiddleware);

  /**
   * GET /super-admin/me
   */
  authApp.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ admin: request.superAdmin });
  });

  /**
   * PUT /super-admin/change-password
   * Change own password (requires current password).
   */
  authApp.put('/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { current_password, new_password } = parsed.data;
    const adminId = request.superAdmin!.id;

    const admin = await superAdminRepository.findByIdWithHash(adminId);
    if (!admin) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await superAdminRepository.updatePasswordHash(adminId, newHash);

    log.info({ adminId }, 'Super admin changed own password');
    void recordSuperAdminAudit({
      admin_id: adminId, admin_email: request.superAdmin!.email,
      action: 'change_password', resource_type: 'super_admin', resource_id: adminId,
      details: {},
    });

    return reply.send({ success: true });
  });

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
   * Create tenant + owner by email (stub user if email not in system).
   *
   * No credit balance, no per-tenant API key and no auto-assigned pooled number:
   * none of the three exists here, so `CreateTenantResponse` carries none of them.
   */
  authApp.post('/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { name, owner_email, owner_name } = parsed.data;
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Create tenant
      const slug = generateSlug(name);
      const tenantResult = await client.query(
        `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING *`,
        [name, slug],
      );
      const tenant = tenantResult.rows[0]!;

      // Create default account
      await client.query(
        `INSERT INTO accounts (tenant_id, name, slug) VALUES ($1, 'Default', 'default')`,
        [tenant.id],
      );

      /**
       * Find or create the owner's user row.
       *
       * `email_unverified = false` is not optional here, and it is the same
       * rule `POST /users/invite` applies through
       * `userRepository.findByProvenEmail`: a `users` row can be bound to an
       * identity that never proved its address (an invite claim accepts an
       * unverified Firebase token by design), so reusing one by address hands
       * this tenant's OWNERSHIP to whoever claimed it. An attacker who
       * self-invites `owner@customer.com` into their own tenant and claims it
       * is waiting for exactly this statement.
       *
       * A miss writes a fresh stub beside the flagged row — correct, because
       * they are two principals sharing a string, and `users.email` has never
       * been unique.
       *
       * Through the REPOSITORY, on this transaction's own client — which is
       * what the optional client parameter exists for. A hand-copied statement
       * would be a second definition of the rule: a mutation dropping
       * `AND email_unverified = false` from one copy passes every test that runs
       * its own copy of the SQL. One definition, one place to mutate, one place
       * to pin.
       */
      const owner = await userRepository.resolveByProvenEmail(owner_email, {
        client,
        lock: true,
      });

      /**
       * Every row for this address is flagged, so the identity already bound to
       * it holds the only `users` row there is. Writing a fresh stub here and
       * making it `tenant_owner` produces a membership nobody can ever claim —
       * `firebase_uid` is UNIQUE, so that person's claim raises `23505`. Refuse
       * with the remedy instead. See `resolveByProvenEmail`.
       */
      if (owner.status === 'unproven_conflict') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'Conflict',
          code: UNVERIFIED_ADDRESS_HOLDER,
          message:
            'That email belongs to an account that has not verified this address. '
            + 'Ask them to sign in and verify it, then create the workspace again.',
        });
      }

      let userId: string;
      if (owner.status === 'found') {
        userId = owner.user.id;
      } else {
        // Create stub user with pending firebase_uid
        const pendingUid = `${PENDING_UID_PREFIX}${uuidv4()}`;
        const userResult = await client.query(
          `INSERT INTO users (firebase_uid, email, display_name) VALUES ($1, $2, $3) RETURNING *`,
          [pendingUid, owner_email, owner_name || null],
        );
        userId = userResult.rows[0]!.id;
      }

      // Create tenant_owner membership
      await client.query(
        `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, 'tenant_owner')`,
        [userId, tenant.id],
      );

      await client.query('COMMIT');

      log.info({ tenantId: tenant.id, ownerEmail: owner_email }, 'Super admin created tenant');
      void recordSuperAdminAudit({
        admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
        action: 'create_tenant', resource_type: 'tenant', resource_id: tenant.id,
        details: { tenant_name: name, owner_email },
      });

      return reply.code(201).send({ tenant, owner_email });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

  // No tenant delete route — see the module note.

  /**
   * POST /super-admin/tenants/:id/users
   * Add user to tenant (or to one of its accounts) by email + role, and issue
   * the invitation.
   */
  authApp.post('/tenants/:id/users', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: tenantId } = request.params;
    const parsed = addUserToTenantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { email, role, name, account_id } = parsed.data;

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    /**
     * The account must belong to THIS tenant: `memberships.account_id`
     * references `accounts(id)` with no composite FK back to the tenant, so
     * nothing in the schema would catch a sibling tenant's account. Same scoped
     * lookup, same refusal and wording as `POST /users/invite`.
     */
    if (account_id) {
      const targetAccount = await accountRepository.findByIdInTenant(account_id, tenantId);
      if (!targetAccount) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'account_id does not belong to this tenant.',
        });
      }
    }
    const contextAccountId = account_id ?? null;

    const pool = getPool();
    const client = await pool.connect();

    let membership: Record<string, unknown> & { id: string; account_id: string | null };
    let userId: string;
    try {
      await client.query('BEGIN');

      /**
       * Find or create the user being added.
       *
       * Same `email_unverified = false` rule, same reason, as the tenant-create
       * lookup above: an address is a string a super admin typed, and a row
       * bound by an unverified invite claim keys under an address its owner
       * does not control. Through the repository on this
       * transaction's client, for the reason given at the tenant-create call.
       */
      const existingUser = await userRepository.resolveByProvenEmail(email, {
        client,
        lock: true,
      });

      // Same refusal, same reason, as the tenant-create lookup above.
      if (existingUser.status === 'unproven_conflict') {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'Conflict',
          code: UNVERIFIED_ADDRESS_HOLDER,
          message:
            'That email belongs to an account that has not verified this address. '
            + 'Ask them to sign in and verify it, then add them again.',
        });
      }

      if (existingUser.status === 'found') {
        userId = existingUser.user.id;
      } else {
        const pendingUid = `${PENDING_UID_PREFIX}${uuidv4()}`;
        const userResult = await client.query(
          `INSERT INTO users (firebase_uid, email, display_name) VALUES ($1, $2, $3) RETURNING *`,
          [pendingUid, email, name || null],
        );
        userId = userResult.rows[0]!.id;
      }

      /**
       * Memberships are soft-deleted (offboarding sets `status = 'revoked'`);
       * unique indexes still apply, so an INSERT of the same user+tenant is
       * 23505 rather than a 409.
       *
       * Lock every leftover row for this user in this tenant, then, without
       * `account_id`:
       *  - any `active` row → they are already a member (409)
       *  - a tenant-level leftover (`account_id IS NULL`) → reactivate it with
       *    the requested role
       *  - otherwise INSERT a new tenant-level membership
       *
       * With `account_id`, the same three rules are keyed on the ACCOUNT context
       * instead: an `active` row for this account → 409; a leftover for this
       * account (`UNIQUE(user_id, tenant_id, account_id)`) → reactivate with the
       * requested role; otherwise INSERT an account-scoped membership. Rows for
       * other contexts — including an active tenant-wide one — are left alone, as
       * `POST /users/invite` leaves them (one membership per account is the
       * model).
       */
      const existingMemberships = await client.query<{
        id: string;
        account_id: string | null;
        status: string;
      }>(
        `SELECT * FROM memberships WHERE user_id = $1 AND tenant_id = $2 FOR UPDATE`,
        [userId, tenantId],
      );
      const alreadyMember = contextAccountId === null
        ? existingMemberships.rows.some((m) => m.status === 'active')
        : existingMemberships.rows.some((m) => m.account_id === contextAccountId && m.status === 'active');
      if (alreadyMember) {
        await client.query('ROLLBACK');
        return reply.code(409).send({
          error: 'Conflict',
          message: contextAccountId === null
            ? 'User is already a member of this tenant'
            : 'User is already a member of this account',
        });
      }

      const leftover = existingMemberships.rows.find((m) => m.account_id === contextAccountId);
      const membershipResult = leftover
        ? await client.query(
          `UPDATE memberships SET status = 'active', role = $1 WHERE id = $2 RETURNING *`,
          [role, leftover.id],
        )
        : contextAccountId === null
          ? await client.query(
            `INSERT INTO memberships (user_id, tenant_id, role) VALUES ($1, $2, $3) RETURNING *`,
            [userId, tenantId, role],
          )
          : await client.query(
            `INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4) RETURNING *`,
            [userId, tenantId, contextAccountId, role],
          );

      /**
       * Offboard leaves `membership_invites` alone on purpose: claim and the
       * public GET treat a non-active membership as `revoked`. Reactivating
       * that same id would make an unclaimed, unexpired token claimable again,
       * and the claim binds whatever role was just written here — not the role
       * the old mail described. Same predicate `createSupersedingOutstanding`
       * uses. It runs inside the membership write's transaction, so no window
       * exists in which the old token is live against the new role, and the
       * invitation issued below (after COMMIT) through `createSupersedingOutstanding`
       * then finds nothing outstanding to supersede.
       */
      const membershipId = membershipResult.rows[0]?.id;
      if (membershipId) {
        await client.query(
          `UPDATE membership_invites
              SET revoked_at = NOW()
            WHERE membership_id = $1
              AND tenant_id = $2
              AND claimed_at IS NULL
              AND revoked_at IS NULL`,
          [membershipId, tenantId],
        );
      }

      await client.query('COMMIT');
      membership = membershipResult.rows[0]!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Same key `tenantContextMiddleware` reads — a re-added user must not keep
    // serving the empty/revoked snapshot from before the write.
    await redisCache.del(`cache:membership:${userId}:${tenantId}`);

    /**
     * Super-admin add creates a `pending_` stub plus membership and sends an
     * invite, through the shared `issueInvite`, so a super-admin invitation is the
     * same artefact `POST /users/invite` produces. `roleGetsTokenInvite` is
     * agent-only: an `agent` gets a token and the mail; every other role gets no
     * token and is matched by session path 2 (a verified email on the `pending_`
     * stub).
     *
     * Guarded exactly as `POST /users/invite` guards it, for its reason: the
     * membership has committed, so a failure here must not turn into a 500 that
     * tells the super admin the add failed. `invitedBy` is `null` — a super admin
     * is not a `users` row (`membership_invites.invited_by` names a user, and the
     * mail names the inviter from `users.display_name`).
     */
    let inviteEmail: InviteEmailResult;
    let inviteId: string | null = null;
    try {
      const issued = await issueInvite({
        membershipId: membership.id,
        tenantId,
        email,
        role: role as MembershipRole,
        invitedBy: null,
      });
      inviteEmail = issued.inviteEmail;
      inviteId = issued.invite?.id ?? null;
    } catch (err) {
      log.error(
        { tenantId, invitedUserId: userId, err: err instanceof Error ? err.message : String(err) },
        'Invite issuance threw; the membership stands and the invite is reported unsent',
      );
      inviteEmail = { sent: false, reason: 'failed' };
    }

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

    return reply.code(201).send({ membership });
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
    const parsed = changeMembershipRoleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
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
    const membershipCacheCleared = await redisCache.delForRevocation(`cache:membership:${target.user_id}:${tenantId}`);

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
    await redisCache.delForRevocation(`cache:membership:${target.user_id}:${tenantId}`);

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
  // module note.

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

  /**
   * POST /super-admin/admins
   * Create another super admin.
   */
  authApp.post('/admins', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createSuperAdminSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { email, password, name } = parsed.data;

    // Check uniqueness
    const existing = await superAdminRepository.findByEmail(email);
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered as super admin' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const admin = await superAdminRepository.create({
      email,
      password_hash: passwordHash,
      name,
    });

    log.info({ adminId: admin.id, email }, 'Super admin created new admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'create_admin', resource_type: 'super_admin', resource_id: admin.id,
      details: { email, name },
    });

    return reply.code(201).send({ admin });
  });

  /**
   * GET /super-admin/admins
   * List all super admins (no password_hash).
   */
  authApp.get('/admins', async (_request: FastifyRequest, reply: FastifyReply) => {
    const admins = await superAdminRepository.findAll();
    return reply.send({ admins });
  });

  /**
   * DELETE /super-admin/admins/:id
   * Deactivate a super admin. System-seeded admin cannot be removed.
   * Cannot remove yourself.
   */
  authApp.delete('/admins/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    if (id === request.superAdmin!.id) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove yourself' });
    }

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }

    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be removed' });
    }

    await superAdminRepository.deactivate(id);

    log.info({ adminId: id, removedBy: request.superAdmin!.id }, 'Super admin removed another admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'remove_admin', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email, name: target.name },
    });

    return reply.send({ success: true, admin_id: id });
  });

  /**
   * POST /super-admin/admins/:id/reactivate
   * Reactivate an inactive super admin. System admin cannot be modified.
   */
  authApp.post('/admins/:id/reactivate', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be modified' });
    }
    if (target.status !== 'inactive') {
      return reply.code(400).send({ error: 'Bad Request', message: 'Can only reactivate inactive admins' });
    }

    const admin = await superAdminRepository.reactivate(id);
    if (!admin) {
      // Lost a TOCTOU race: the row was flipped out of 'inactive' between our
      // findById check and the UPDATE. Nothing changed — don't audit a phantom
      // reactivation.
      return reply.code(409).send({ error: 'Conflict', message: 'Admin is no longer inactive' });
    }

    log.info({ adminId: id, reactivatedBy: request.superAdmin!.id }, 'Super admin reactivated another admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'reactivate_admin', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email, name: target.name },
    });

    return reply.send({ admin });
  });

  /**
   * PUT /super-admin/admins/:id/password
   * Reset ANOTHER admin's password. Requires the acting admin's own password
   * (re-auth). Cannot target self (use change-password) or the system admin.
   */
  authApp.put('/admins/:id/password', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parsed = resetAdminPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { id } = request.params;
    const { admin_password, new_password } = parsed.data;

    if (id === request.superAdmin!.id) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Use change-password for your own account' });
    }

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be modified' });
    }

    const actor = await superAdminRepository.findByIdWithHash(request.superAdmin!.id);
    if (!actor) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    const valid = await bcrypt.compare(admin_password, actor.password_hash);
    if (!valid) {
      // 422 (not 401) is deliberate: the super-admin console's saFetch treats every
      // 401 as session-expiry and force-logs-out the admin. A wrong re-auth password
      // is a business validation failure that must surface inline in the modal — so
      // 422.
      return reply.code(422).send({ error: 'Unprocessable Entity', message: 'Your password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await superAdminRepository.updatePasswordHash(id, newHash);

    log.info({ adminId: id, resetBy: request.superAdmin!.id }, 'Super admin reset another admin password');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'reset_admin_password', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email },
    });

    return reply.send({ success: true });
  });

  /**
   * GET /super-admin/audit
   * Admin audit log — visible to all super admins. Filters are server-side: a
   * page-local search would scan only the current 50 rows.
   */
  authApp.get('/audit', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = superAdminAuditQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const { limit, offset, ...filters } = parsed.data;
    const result = await superAdminAuditRepository.list(limit, offset, filters);
    return reply.send(result);
  });

  /**
   * GET /super-admin/tenants/:id/accounts
   * List all accounts for a tenant with their concurrency settings.
   *
   * Each account's allocation is `providerConcurrencyRepository.getAllocation`.
   * A read failure reports `unavailable` rather than fabricating a limit. Reads
   * run in chunks of 10, bounding concurrent pool checkouts.
   */
  authApp.get('/tenants/:id/accounts', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: tenantId } = request.params;
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const dbAccounts = await accountRepository.findByTenantId(tenantId);

    const accounts: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < dbAccounts.length; offset += 10) {
      const chunk = dbAccounts.slice(offset, offset + 10);
      const rows = await Promise.all(chunk.map(async (acc) => {
        let maxConcurrentCalls: number | null = null;
        let concurrency: AccountConcurrencyAllocation | undefined;
        let concurrencyStatus: 'available' | 'unavailable' = 'unavailable';
        try {
          concurrency = await providerConcurrencyRepository.getAllocation(tenantId, acc.id);
          maxConcurrentCalls = concurrency.total_concurrency;
          concurrencyStatus = 'available';
        } catch (err) {
          log.warn({ err, tenantId, accountId: acc.id }, 'Account concurrency unavailable');
        }
        return {
          id: acc.id,
          name: acc.name,
          slug: acc.slug,
          status: acc.status,
          max_concurrent_calls: maxConcurrentCalls,
          concurrency_status: concurrencyStatus,
          ...(concurrency ? { concurrency } : {}),
        };
      }));
      accounts.push(...rows);
    }

    return reply.send({ accounts });
  });

  /**
   * PUT /super-admin/tenants/:id/accounts/:accountId/concurrency
   * Update the concurrency allocation for a specific account.
   */
  const updateConcurrencySchema = z.object({
    max_concurrent_calls: z.number().int().min(1).max(1000),
  });

  const providerConcurrencySchema = z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('legacy_total'),
      version: z.number().int().min(1),
      max_concurrent_calls: z.number().int().min(1).max(1000),
      change_reason: z.string().min(3).max(1000),
    }),
    z.object({
      mode: z.literal('provider_breakdown'),
      version: z.number().int().min(1),
      providers: z.array(z.object({
        provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
        max_concurrent_calls: z.number().int().min(0).max(1000),
      })).min(1).max(50),
      force_migration: z.boolean().optional().default(false),
      change_reason: z.string().min(3).max(1000),
    }),
  ]);

  /**
   * GET /super-admin/tenants/:id/accounts/:accountId/concurrency
   *
   * `allocation` is `getAllocation` and `utilization` is computed in-process by
   * `readAccountConcurrencyUtilization`. When the utilization read itself fails
   * (the guard is unreachable or not wired) it is `null` — the contract's
   * `AccountConcurrencyDetail.utilization: … | null`. No telephony catalog,
   * entitlements or synchronization state (module note).
   */
  authApp.get('/tenants/:id/accounts/:accountId/concurrency', async (
    request: FastifyRequest<{ Params: { id: string; accountId: string } }>,
    reply: FastifyReply,
  ) => {
    const { id: tenantId, accountId } = request.params;
    const [tenant, account] = await Promise.all([
      tenantRepository.findById(tenantId),
      accountRepository.findById(accountId),
    ]);
    if (!tenant || !account || account.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant or account not found' });
    }

    try {
      const allocation = await providerConcurrencyRepository.getAllocation(tenantId, accountId);
      const utilization = await readAccountConcurrencyUtilization(tenantId, accountId, allocation).catch((err: unknown) => {
        log.warn({ err, tenantId, accountId }, 'Account concurrency utilization unavailable');
        return null;
      });
      return reply.send({ allocation, utilization });
    } catch (err) {
      log.error({ err, tenantId, accountId }, 'Failed to read account concurrency');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to read account concurrency' });
    }
  });

  /**
   * PUT /super-admin/tenants/:id/accounts/:accountId/concurrency
   *
   * In order: the two accepted bodies and their checks (duplicate provider, total
   * 1..1000, a routed number per allocated provider); the legacy-body translation
   * (`version` from the current allocation, refused once the account is in
   * provider mode); the provider-mode migration drain check through the ACCOUNT
   * guard's distributed count (503 when unavailable, 409 with active calls, both
   * bypassed by `force_migration`); the versioned write; three invalidations, in
   * this order (settings row cache → account guard → provider guard), the guard
   * calls through `seams/concurrency-control.ts`; the `concurrency.allocation.updated`
   * audit row (actor = the super admin's email); the super-admin audit row. A drain
   * or version refusal, or an unexpected throw (answered 500), writes the
   * `update_account_concurrency_failed` super-admin audit row through `refuse`.
   */
  authApp.put('/tenants/:id/accounts/:accountId/concurrency', async (request: FastifyRequest<{ Params: { id: string; accountId: string } }>, reply: FastifyReply) => {
    const { id: tenantId, accountId } = request.params;

    const providerParsed = providerConcurrencySchema.safeParse(request.body);
    const legacyParsed = updateConcurrencySchema.safeParse(request.body);
    if (!providerParsed.success && !legacyParsed.success) {
      const providerShaped = typeof request.body === 'object' && request.body !== null && 'mode' in request.body;
      return reply.code(400).send({
        error: 'Bad Request',
        details: providerShaped ? providerParsed.error.issues : legacyParsed.error.issues,
      });
    }

    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const account = await accountRepository.findById(accountId);
    if (!account || account.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Account not found' });
    }

    const superAdmin = request.superAdmin!;
    let before: AccountConcurrencyAllocation | null = null;
    /** The `update_account_concurrency_failed` super-admin audit row, then the reply. */
    const refuse = async (status: number, body: Record<string, unknown>) => {
      // Awaited, with an error log that names the row it lost (Manas, 2026-10-09:
      // a failed super-admin audit write must say what it was).
      await superAdminAuditRepository.log({
        admin_id: superAdmin.id, admin_email: superAdmin.email,
        action: 'update_account_concurrency_failed', resource_type: 'account', resource_id: accountId,
        details: { tenant_id: tenantId, status, before },
      }).catch((auditErr) => log.error({
        err: auditErr, action: 'update_account_concurrency_failed',
        actor: { admin_id: superAdmin.id, admin_email: superAdmin.email },
        target: { resource_type: 'account', resource_id: accountId }, tenantId,
      }, 'Failed to audit rejected concurrency update'));
      return reply.code(status).send(body);
    };

    try {
      if (providerParsed.success && providerParsed.data.mode === 'provider_breakdown') {
        const names = providerParsed.data.providers.map((row) => row.provider);
        const total = providerParsed.data.providers.reduce(
          (sum, row) => sum + row.max_concurrent_calls, 0,
        );
        if (total < 1 || total > 1000) {
          return reply.code(400).send({
            error: 'Bad Request', message: 'Total concurrency must be between 1 and 1000',
          });
        }
        const allocatedNames = providerParsed.data.providers
          .filter((row) => row.max_concurrent_calls > 0)
          .map((row) => row.provider);
        if (new Set(names).size !== names.length) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Each provider may appear only once' });
        }
        // No telephony-catalog checks (module note). The routed-number check
        // stays: capacity on a carrier the account has no number on cannot place
        // a call.
        const routes = await tenantPhoneAssignmentRepository.findAvailableForAccount(tenantId, accountId);
        const unrouted = allocatedNames.filter((name) => !routes.some((route) => route.provider_name === name));
        if (unrouted.length > 0) {
          return reply.code(422).send({ error: 'Unusable Provider', message: `No active account-accessible phone number for: ${unrouted.join(', ')}` });
        }
      }

      before = await providerConcurrencyRepository.getAllocation(tenantId, accountId).catch(() => null);
      let data:
        | { mode: 'legacy_total'; version: number; max_concurrent_calls: number; change_reason: string }
        | { mode: 'provider_breakdown'; version: number; providers: Array<{ provider: string; max_concurrent_calls: number }>; force_migration: boolean; change_reason: string };
      if (providerParsed.success) {
        data = providerParsed.data;
      } else {
        if (!before) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Current concurrency allocation is unavailable' });
        }
        if (before.mode === 'provider_breakdown') {
          return reply.code(409).send({ error: 'Conflict', message: 'Use the versioned provider allocation editor for this account' });
        }
        data = {
          mode: 'legacy_total',
          version: before.version,
          max_concurrent_calls: legacyParsed.data!.max_concurrent_calls,
          change_reason: 'Legacy total updated from Super Admin',
        };
      }
      if (!before) {
        // A provider-shaped body with no readable current allocation fails the
        // request (500, audited) rather than writing blind.
        throw new Error('Current concurrency allocation is unavailable');
      }

      // ── The versioned write, its invalidations and the allocation audit row ──
      let allocation: AccountConcurrencyAllocation;
      try {
        if (data.mode === 'provider_breakdown') {
          if (before.mode === 'legacy_total') {
            const active = await getConcurrencyControl().getDistributedAccountCount(tenantId, accountId);
            if (active.status === 'unavailable' && !data.force_migration) {
              return await refuse(503, {
                error: 'Concurrency State Unavailable',
                message: 'Cannot safely migrate while the distributed active-call count is unavailable',
                current_version: before.version,
              });
            }
            if (active.status === 'available' && active.count > 0 && !data.force_migration) {
              return await refuse(409, {
                error: 'Active Calls',
                message: 'Provider-mode migration requires the account to drain active calls or an explicit force_migration confirmation',
                active_calls: active.count,
                current_version: before.version,
              });
            }
          }
          allocation = await providerConcurrencyRepository.replaceProviderBreakdown({
            tenant_id: tenantId,
            account_id: accountId,
            expected_version: data.version,
            providers: data.providers,
          });
        } else {
          allocation = await providerConcurrencyRepository.switchToLegacy({
            tenant_id: tenantId,
            account_id: accountId,
            expected_version: data.version,
            max_concurrent_calls: data.max_concurrent_calls,
          });
        }
      } catch (err) {
        if (err instanceof ConcurrencyAllocationVersionConflictError) {
          return await refuse(409, {
            error: 'Conflict', message: err.message, current_version: err.currentVersion,
          });
        }
        throw err;
      }

      accountSettingsRepository.invalidate(tenantId, accountId);
      await getConcurrencyControl().invalidateAccountLimit(tenantId, accountId);
      await getConcurrencyControl().invalidateProviderLimits(tenantId, accountId);
      auditLogger.log({
        tenantId,
        accountId,
        eventType: 'concurrency.allocation.updated',
        eventCategory: 'system',
        severity: 'info',
        actor: superAdmin.email,
        eventData: {
          before,
          after: allocation,
          change_reason: data.change_reason,
          ...(data.mode === 'provider_breakdown' && data.force_migration
            ? { force_migration: true }
            : {}),
        },
      });
      // ── end of the allocation write ───────────────────────────────────────

      // Awaited; the error log names the lost row (Manas, 2026-10-09).
      await superAdminAuditRepository.log({
        admin_id: superAdmin.id, admin_email: superAdmin.email,
        action: 'update_account_concurrency', resource_type: 'account', resource_id: accountId,
        details: {
          tenant_id: tenantId,
          ...(!providerParsed.success && legacyParsed.success
            ? { max_concurrent_calls: legacyParsed.data.max_concurrent_calls }
            : {}),
          before,
          after: allocation,
        },
      }).catch((auditErr) => log.error({
        err: auditErr, action: 'update_account_concurrency',
        actor: { admin_id: superAdmin.id, admin_email: superAdmin.email },
        target: { resource_type: 'account', resource_id: accountId }, tenantId,
      }, 'Failed to audit concurrency update'));
      log.info({ tenantId, accountId, mode: data.mode }, 'Super admin updated account concurrency');

      return reply.send(allocation);
    } catch (err) {
      log.error({ err, tenantId, accountId }, 'Failed to update account concurrency');
      // An unexpected throw writes the failed row too, answered as a 500.
      return await refuse(500, { error: 'Internal Server Error', message: 'Failed to update account concurrency' });
    }
  });

  // No concurrency retry-sync route: there is nothing to re-synchronize (module
  // note).

  }); // end authenticatedRoutes sub-plugin
}

function generateSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    + '-' + Math.random().toString(36).slice(2, 8);
}
