import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';

/*
 * `GET /phone-numbers`, the caller-ID list, and the only route here:
 *  - No bring-your-own-carrier numbers: VoiceLink is the only carrier, so there is
 *    no second list to merge, and `is_byoc` is not on the row
 *    (`@magick-agency/contracts`'s `TenantPhoneAssignment` does not carry it), and
 *    the console's `CallerIdPicker.tsx` shows no own-carrier badge.
 *  - No number administration (account tags, account defaults) or inbound config:
 *    number assignment is the super-admin's (`super-admin-phone.routes.ts`), and
 *    there is no AI inbound routing.
 * The permission is `agency.phone_numbers.read` (floor `viewer`; contracts
 * `rbac.ts`). The response is `{ phone_numbers }`.
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
     * falls through to their own membership) would otherwise fall through to
     * `findByTenantId`, returning every account's phone assignments AND
     * `findTagsForAssignment`'s per-tag `accounts.name` join for all of them.
     * `request.membership.account_id` is the authority, as it is everywhere
     * else: when it is set, `tenantContextMiddleware` has already proven it agrees
     * with the header whenever one was sent (a disagreeing header would 403
     * upstream), so preferring it never overrides an explicit, validated header —
     * it only fills in when one was never sent.
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
