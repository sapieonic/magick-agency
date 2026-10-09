import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { getFeatureFlagService } from '../../feature-flags/index.js';

/**
 * PORT NOTE (magick-agency): HOP COLLAPSE of two files into one in-process route.
 *  - master `src/api/routes/proxy-feature-flags.routes.ts` (v3.24.0) supplied the
 *    gate: `sessionMiddleware` → `tenantContextMiddleware` →
 *    `requirePermission('proxy.feature_flags.read')`, then a `passthrough` to
 *    core's `GET /api/v1/feature-flags` with the per-tenant core API key.
 *  - core `src/api/routes/feature-flags.routes.ts` (v1.123.2) supplied the body:
 *    `getFeatureFlagService().resolveClientExposed({ tenantId, accountId })`.
 * In one app there is no proxy, no core API key and no `x-mgkvc-*` headers: the
 * tenant/account are the ones `tenantContextMiddleware` proved. The permission is
 * the contract's rename `agency.flags.read` (same `agent` floor). The prefix is
 * `/feature-flags` (master's `/proxy/feature-flags`; see `platform.plugin.ts`).
 *
 * Master's doc, unchanged:
 *
 * Tenant-facing feature-flag read lane — client-exposed flags only, resolved for
 * the caller's tenant/account.
 *
 * Deliberately uncached: feature-flag rollout changes must propagate fast, and
 * core already applies a 60s cache as the backstop. Tech-plan §A5.
 *
 * ── Why this route has its own permission ──────────────────────────────────
 * It carried `proxy.stats.read` (floor `viewer`) until MAG-181. That floor is
 * correct for the stats lane it was borrowed from and wrong here, because this
 * is not a data read — it is the gate map cusui must resolve before it can
 * render any flag-gated route at all. An `agent` is hierarchy level 5, below
 * `viewer`, so every dedicated agent 403'd here; `FeatureFlagsContext` is
 * fail-safe closed, so the error resolved every flag to `false` and
 * `RequireFlag flag="agency_dialer_enabled"` refused all four agent routes.
 * The Agency Dialer was unreachable by the only role it was built for.
 *
 * `proxy.feature_flags.read` floors at `agent` and is inherited by every role
 * above, so this is purely additive — nobody who could read the map before
 * loses it. See `src/rbac/roles.ts` for why the fix is a new permission rather
 * than a lower floor on the shared one.
 *
 * Core's doc, unchanged except the last clause:
 *
 * Tenant-facing read surface. Returns only `clientExposed` flags, resolved for
 * the caller's tenant/account. Internal flags are never enumerable here, and there
 * is no write verb — enabling a gated capability is a super-admin decision
 * (core: "an S2S-only business decision").
 */
export async function featureFlagsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  // GET /feature-flags — resolved client-exposed flag map for the tenant/account.
  app.get('/', {
    preHandler: [requirePermission('agency.flags.read')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    /*
     * PORT NOTE (magick-agency): core's `authMiddleware` refused a request with no
     * account header (`400 Missing required header: x-mgkvc-account`), and master's
     * proxy forwarded `x-mgkvc-account` only when `X-Account-Id` was sent, so a
     * tenant-only request got that 400 back through the passthrough. Kept, naming
     * the header the browser actually sends.
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
