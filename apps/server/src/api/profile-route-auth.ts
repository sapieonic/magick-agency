import type { FastifyReply, FastifyRequest } from 'fastify';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { createChildLogger } from '@magick-agency/observability';
import { sessionMiddleware } from '../auth/session.middleware.js';
import { tenantContextMiddleware } from './middleware/tenant-context.middleware.js';
import { requirePermission } from '../rbac/rbac.middleware.js';
import { DEFAULT_ANALYZE_CALLS } from '../settings/agency-account-settings.js';
import { ACCOUNT_HEADER } from './middleware/headers.js';
import type { ProfileRouteAuth } from './routes/call-analysis-profiles.routes.js';

const log = createChildLogger({ component: 'profile-route-auth' });

/**
 * The real `ProfileRouteAuth` for lane D's call-analysis profile routes (Phase 8; lane D
 * shipped them refuse-all until this merge).
 *
 * In MagickVoice the console called master's `/proxy/call-analysis-profiles*`
 * (`proxy-call-analysis-profiles.routes.ts`@a1f0756a), which ran, in order:
 *  1. `sessionMiddleware`, `tenantContextMiddleware` (plugin hooks);
 *  2. a governance capability (`passthrough`'s extra preHandler runs BEFORE its permission):
 *     `requireAnyCapability('calls.dialer.analytics', 'agency.analytics')` on the list and
 *     `requireCapability('calls.dialer.analytics')` on get/create/update/delete;
 *  3. `requirePermission('proxy.prompts.read' | 'proxy.prompts.write')`;
 *  4. core's `authMiddleware` after the hop (tenant and ACCOUNT required, 400 otherwise).
 * This preHandler is that chain, collapsed:
 *  - the permissions are their agency names (`agency.analysis_profiles.read|write`, floors
 *    unchanged — `@magick-agency/contracts/rbac`);
 *  - the capability is `agency.analytics`, i.e. the account's `analyze_calls` settings column
 *    (plan §3.2), for all five routes. `calls.dialer.analytics` was the SOFTPHONE's capability,
 *    and the softphone is deleted (plan §5): kept literally, the four authoring routes would be
 *    unreachable for every account, while plan §4 has profiles as agency's analysis definition.
 *    So the list's OR reduces to its agency half and the other four take the same gate.
 *    NULL/no row = off (the documented default); a failed read fails CLOSED; refusal is
 *    master's `{ error: 'capability_disabled', capability: 'agency.analytics' }` 403;
 *  - core's account requirement keeps core's 400. It is checked ahead of the settings read
 *    (the setting is per account, so there is nothing to read without one) — in master the
 *    capability resolved at tenant level first; the request is refused either way.
 */
export function platformProfileRouteAuth(): ProfileRouteAuth {
  const canRead = requirePermission('agency.analysis_profiles.read');
  const canWrite = requirePermission('agency.analysis_profiles.write');

  return {
    async preHandler(request: FastifyRequest, reply: FastifyReply) {
      await sessionMiddleware(request, reply);
      if (reply.sent) return reply;
      await tenantContextMiddleware(request, reply);
      if (reply.sent) return reply;

      if (!request.accountId) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: `Missing required header: ${ACCOUNT_HEADER}`,
        });
      }

      let analyzeCalls = false;
      try {
        const row = await accountSettingsRepository.findByTenantAndAccount(request.tenantId!, request.accountId);
        analyzeCalls = row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS;
      } catch (err) {
        log.error({ err }, 'account settings resolve failed in the profile gate — failing closed');
        analyzeCalls = false;
      }
      if (analyzeCalls !== true) {
        return reply.code(403).send({ error: 'capability_disabled', capability: 'agency.analytics' });
      }

      await (request.method === 'GET' ? canRead : canWrite)(request, reply);
      if (reply.sent) return reply;
      return undefined;
    },
    getTenantId: (request) => request.tenantId!,
    getAccountId: (request) => request.accountId!,
  };
}
