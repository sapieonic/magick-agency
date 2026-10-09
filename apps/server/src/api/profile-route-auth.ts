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
 * The `ProfileRouteAuth` for the call-analysis profile routes. One preHandler, in order:
 *  1. `sessionMiddleware`, `tenantContextMiddleware`;
 *  2. an account is required (400 otherwise). It is checked ahead of the settings read:
 *     the setting is per account, so there is nothing to read without one;
 *  3. the `agency.analytics` capability — the account's `analyze_calls` settings column —
 *     for all five routes, since profiles are the dialer's analysis definition. NULL/no
 *     row = off (the documented default); a failed read fails CLOSED; refusal is
 *     `{ error: 'capability_disabled', capability: 'agency.analytics' }` 403;
 *  4. `requirePermission('agency.analysis_profiles.read' | '.write')` (floors in
 *     `@magick-agency/contracts/rbac`), read for GET and write otherwise.
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
