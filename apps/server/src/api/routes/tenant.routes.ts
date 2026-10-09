import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
// PORT NOTE (magick-agency): master's `tenantRepository`,
// `invalidateTenantRecordCache`, `invalidateMetadataCache`, `tenant.validator`,
// the core account-settings sync service and `denyPlatformApiKey` imports are
// removed. All but the last served only the deleted `GET /` and `PUT /:id`; the
// last is decision #5 (no platform API keys).
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { deriveMembershipInviteState } from '../../invites/membership-invite-state.js';

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  // All routes require session auth
  app.addHook('preHandler', sessionMiddleware);

  /*
   * PORT NOTE (magick-agency): master's `GET /tenants` (list the caller's
   * tenants) and `PUT /tenants/:id` (`tenant.update`) are DELETED. No console page
   * in agency's scope calls `GET /tenants` (the session payload already carries
   * `tenants`), and `PUT /tenants/:id` edited AI pipeline/provider settings
   * (TenantSettingsPage) with a permission the contract does not have (decision
   * Q3e). Super-admins edit tenants.
   */

  /**
   * GET /tenants/:id/members — list tenant members
   *
   * Same path-vs-header split as PUT above, with a read rather than a write:
   * `findByTenantId(params.id)` returned every membership in B (emails,
   * display names) to a `viewer` of A who named B in the URL. Scoped to the
   * proven `request.tenantId`; mismatch is 404, not 403. (PORT NOTE
   * (magick-agency): "PUT above" is master's `PUT /tenants/:id`, deleted here.)
   *
   * Each item is the membership row, a nested `user` (or `null`), and
   * `invite_state` — `'active' | 'pending'`, the one thing a supervisor could
   * not previously tell about somebody they had just invited: whether that
   * person has completed Firebase sign-in at all. The fact was already
   * persisted, on `users.firebase_uid`; the gap was only that this list never
   * read it.
   *
   * ── Account scope is a second axis, and it was missing ────────────────────
   * `tenant.read` floors at `viewer`, and `requirePermission` proves the
   * caller's ROLE without looking at which ACCOUNT their membership is scoped
   * to — so an account-scoped viewer of account A was handed every active
   * member of the tenant: sibling accounts' emails, display names, roles and
   * `account_id`s. The roster is now confined to the caller's own account,
   * read from `request.membership.account_id` — never `request.accountId` /
   * `X-Account-Id`, which is an unauthenticated, optional header an
   * account-scoped caller can simply omit. Tenant-wide members
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
     * This used to be `findByTenantId` followed by
     * `Promise.all(memberships.map(m => userRepository.findById(m.user_id)))` —
     * a round trip per member on a page a supervisor opens to see their whole
     * floor. It collapses into the `LEFT JOIN` inside
     * `findByTenantIdWithUser`, which preserves this route's `status = 'active'`
     * filter and `created_at DESC` ordering exactly. `invite_state` needs no
     * further I/O: it is read off the joined `users` row.
     */
    const callerAccountId = request.membership?.account_id ?? undefined;
    const rows = await membershipRepository.findByTenantIdWithUser(
      request.tenantId!,
      callerAccountId,
    );

    const members = rows.map((row) => ({
      ...row.membership,
      /**
       * The four fields this route has always served, named one by one.
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
       * Additive, and the only new field on this response.
       *
       * Two values — a supervisor's question is "has this person turned up
       * yet", and their next action is the same for every way the answer is
       * no. One rule for every role, applied here rather than in SQL so it
       * stays a pure function that can be tested without this route; the
       * argument for that rule, and for the claim-based one it replaced, is on
       * `deriveMembershipInviteState`.
       */
      invite_state: deriveMembershipInviteState({
        firebaseUid: row.user?.firebase_uid ?? null,
      }),
    }));

    return reply.send({ members });
  });
}
