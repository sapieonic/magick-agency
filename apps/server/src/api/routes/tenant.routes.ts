import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { deriveMembershipInviteState } from '../../invites/membership-invite-state.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // All routes require session auth
  app.addHook('preHandler', sessionMiddleware);

  /*
   * No `GET /tenants` (the session payload already carries `tenants`) and no
   * `PUT /tenants/:id`: `tenant.update` is not in the contract (decision Q3 (e)).
   * Super-admins edit tenants.
   */

  /**
   * GET /tenants/:id/members — list tenant members
   *
   * The path names a tenant, and the proven `request.tenantId` is the
   * authority: `findByTenantId(params.id)` alone would return every membership
   * in B (emails, display names) to a `viewer` of A who named B in the URL.
   * Scoped to the proven `request.tenantId`; mismatch is 404, not 403.
   *
   * Each item is the membership row, a nested `user` (or `null`), and
   * `invite_state` — `'active' | 'pending'`: whether that person has completed
   * Firebase sign-in at all, read off `users.firebase_uid`.
   *
   * ── Account scope is a second axis ──────────────────────────────────────
   * `tenant.read` floors at `viewer`, and `requirePermission` proves the
   * caller's ROLE without looking at which ACCOUNT their membership is scoped
   * to — so without a second check an account-scoped viewer of account A would
   * be handed every active member of the tenant: sibling accounts' emails,
   * display names, roles and `account_id`s. The roster is confined to the
   * caller's own account, read from `request.membership.account_id` — never
   * `request.accountId` / `X-Account-Id`, which is an unauthenticated, optional
   * header an account-scoped caller can simply omit. Tenant-wide members
   * (`account_id IS NULL`) are left out for such a caller too (see
   * `findByTenantIdWithUser`). A tenant-wide membership (`account_id` null)
   * still sees the whole roster. A caller with no membership at all never
   * reaches this handler — `requirePermission` 403s it first.
   */
  app.get<{ Params: { id: string } }>('/:id/members', {
    preHandler: [tenantContextMiddleware, requirePermission('tenant.read')],
  }, async (request, reply) => {
    if (request.params.id !== request.tenantId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    /**
     * One query, not N+1.
     *
     * The `LEFT JOIN` inside `findByTenantIdWithUser` replaces a round trip
     * per member on a page a supervisor opens to see their whole floor, and
     * preserves this route's `status = 'active'` filter and `created_at DESC`
     * ordering. `invite_state` needs no further I/O: it is read off the joined
     * `users` row.
     */
    const callerAccountId = request.membership?.account_id ?? undefined;
    const rows = await membershipRepository.findByTenantIdWithUser(
      request.tenantId!,
      callerAccountId,
    );

    const members = rows.map((row) => ({
      ...row.membership,
      /**
       * The four user fields this route serves, named one by one.
       *
       * NOT a spread of `row.user`, which also carries `firebase_uid` for the
       * derivation below. That column holds `pending_<uuid>` for an invitee who
       * has never signed in, and neither it nor a real uid may reach the
       * browser — naming the fields is what makes that structural instead of a
       * rule somebody has to remember.
       */
      user: row.user
        ? {
          id: row.user.id,
          email: row.user.email,
          display_name: row.user.display_name,
          avatar_url: row.user.avatar_url,
        }
        : null,
      /**
       * `invite_state`.
       *
       * Two values — a supervisor's question is "has this person turned up
       * yet", and their next action is the same for every way the answer is
       * no. One rule for every role, applied here rather than in SQL so it
       * stays a pure function that can be tested without this route; the
       * argument for that rule is on `deriveMembershipInviteState`.
       */
      invite_state: deriveMembershipInviteState({
        firebaseUid: row.user?.firebase_uid ?? null,
      }),
    }));

    return reply.send({ members });
  });
}
