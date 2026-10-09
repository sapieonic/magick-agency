import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { getFeatureFlagService } from '../../feature-flags/index.js';

/**
 * Tenant-facing feature-flag read — client-exposed flags only, resolved for the
 * caller's tenant/account (the ones `tenantContextMiddleware` proved) through
 * `getFeatureFlagService().resolveClientExposed`. Internal flags are never
 * enumerable here, and there is no write verb — enabling a gated capability is a
 * super-admin decision.
 *
 * Deliberately uncached at the route: feature-flag rollout changes must
 * propagate fast, and the flag service already applies a 60s cache as the
 * backstop.
 *
 * ── Why this route has its own permission ──────────────────────────────────
 * `agency.flags.read` floors at `agent` (hierarchy level 5, below `viewer`).
 * This is not a data read — it is the gate map the console must resolve before
 * it can render any flag-gated route at all. On a `viewer` floor every dedicated
 * agent would 403 here; `FeatureFlagsContext` is fail-safe closed, so the error
 * would resolve every flag to `false` and `RequireFlag flag="agency_dialer_enabled"`
 * would refuse every agent route, leaving the Agency Dialer unreachable by the
 * only role it is built for.
 *
 * The permission is inherited by every role above `agent`, so nobody who can
 * read anything else is denied the map. See `@magick-agency/contracts/rbac` for
 * why this is its own permission rather than a lower floor on a shared one.
 */
export async function featureFlagsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  // GET /feature-flags — resolved client-exposed flag map for the tenant/account.
  app.get('/', {
    preHandler: [requirePermission('agency.flags.read')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    /*
     * A request with no account is refused (`400 Missing required header:
     * X-Account-Id`): the client-exposed map is resolved per account.
     */
    const tenantId = request.tenantId!;
    const accountId = request.accountId;
    if (!accountId || accountId.trim().length === 0) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Missing required header: X-Account-Id',
      });
    }
    const flags = await getFeatureFlagService().resolveClientExposed({ tenantId, accountId });
    return reply.send(flags);
  });
}
