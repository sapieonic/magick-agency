import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';

/*
 * PORT NOTE (magick-agency, Phase 8): master `src/api/routes/phone-number.routes.ts`@a1f0756a,
 * the `GET /` handler only (`:64-160`). What is gone, and why:
 *  - **The BYOC half.** Master merged the tenant's own-carrier numbers from core
 *    (`listByocCallerIds`, an S2S read) into the list, stamped `is_byoc` on both halves, and
 *    degraded to platform numbers when core did not answer. Bring-your-own carrier is out of
 *    scope (VoiceLink is the only carrier, plan "Decided" #3), so there is no second half to
 *    merge, and `is_byoc` is not on the row: `@magick-agency/contracts`'s
 *    `TenantPhoneAssignment` removed it for the same reason. (The console only reads it to show
 *    a badge, `CallerIdPicker.tsx:96`; absent means no badge.)
 *  - **Every other route in the file** — account tags and account defaults, the inbound
 *    config CRUD and its conflict check. They are administration (`proxy.phone_numbers.manage`,
 *    which the contracts do not carry: number assignment is the super-admin's,
 *    `super-admin-phone.routes.ts`) or AI inbound routing (out of scope). The console path
 *    inventory lists each as not served, with the reason.
 *  - `denyPlatformApiKey` went with those routes (it guarded only them), and platform API keys
 *    are gone anyway (decision #5).
 * The permission is master's `proxy.phone_numbers.read` under its agency name,
 * `agency.phone_numbers.read` (floor `viewer`, unchanged; contracts `rbac.ts`). The response
 * stays `{ phone_numbers }`.
 */

export async function phoneNumberRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /**
   * GET /phone-numbers — list assigned phone numbers for current tenant/account.
   */
  app.get('/', {
    preHandler: [requirePermission('agency.phone_numbers.read')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.tenantId!;
    /**
     * `request.accountId` is the `X-Account-Id` HEADER — optional, and an
     * account-scoped caller who simply omits it (legal: `tenantContextMiddleware`
     * falls through to their own membership) fell through here to
     * `findByTenantId`, returning every account's phone assignments AND
     * `findTagsForAssignment`'s per-tag `accounts.name` join for all of them.
     * `request.membership.account_id` is the authority for the same reason it
     * is everywhere else in this fix: when it is set, `tenantContextMiddleware`
     * has already proven it agrees with the header whenever one was sent (a
     * disagreeing header would 403 upstream), so preferring it never overrides
     * an explicit, validated header — it only fills in when one was never sent.
     */
    const accountId = request.membership?.account_id ?? request.accountId;

    const assignments = accountId
      ? await tenantPhoneAssignmentRepository.findAvailableForAccount(tenantId, accountId)
      : await tenantPhoneAssignmentRepository.findByTenantId(tenantId);

    // Load tags for each assignment
    const phoneNumbers: Array<Record<string, unknown>> = await Promise.all(
      assignments.map(async (assignment) => {
        const assignmentId = 'assignment_id' in assignment
          ? (assignment as any).assignment_id as string
          : assignment.id;
        const tags = await tenantPhoneAssignmentRepository.findTagsForAssignment(assignmentId);
        /**
         * `findTagsForAssignment` answers for the ASSIGNMENT, not for any one
         * account — a shared/untagged number can be tagged to several accounts
         * at once, and `findAvailableForAccount` above correctly limits which
         * PHONE ROWS come back without limiting which TAGS ride along on each
         * one. Left unfiltered, an account-scoped caller whose own account
         * legitimately has access to a number still received every SIBLING
         * account's `account_id`/`account_name` in `account_tags` for that same
         * row. A tenant-wide caller (`accountId` unset) sees every tag, as
         * before — there is no "own account" to narrow to.
         */
        const visibleTags = accountId ? tags.filter((tag) => tag.account_id === accountId) : tags;
        return {
          ...assignment,
          account_tags: visibleTags,
        };
      }),
    );

    return reply.send({ phone_numbers: phoneNumbers });
  });
}
