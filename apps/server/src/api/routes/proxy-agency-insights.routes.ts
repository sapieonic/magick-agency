import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerInsightsAsOfNowRoutes } from './proxy-agency-insights/as-of-now.js';

export { registerInsightsAsOfNowRoutes };

/**
 * The campaign insights page (docs/insights.md; the wire is
 * `packages/contracts/src/api/agency/insights.ts`), served at the console's paths under
 * `/proxy/agency/campaigns/:id/insights/`. Read-only; the reads are this layer's own
 * (`src/agency/insights/` over `db/repositories/agency/insights-reads.repository.ts`), with two
 * internal handler hops: the campaign ownership probe, and the stats strip's payload for the
 * running headline.
 *
 *  - As of now (`./proxy-agency-insights/as-of-now.ts`): `summary`, `readiness`, `allocation`,
 *    `uploads`. `summary` and `allocation` are polled by the console and share a few seconds of
 *    cache per campaign (`agency/insights/cache.ts`).
 *  - The range reads (`activity`, `trends`, `health`) are not served yet: they read the rollup
 *    and the pacing history being built in parallel (docs/insights.md, workstreams B, C, E).
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below);
 * `agency.supervise` (account admin and up; tenant owners pass; agents and viewers get the RBAC
 * 403); then `insightsCampaign` (`./proxy-agency-insights/shared.ts`): the dialer flag (`403
 * feature_disabled`), the id's shape (`404 campaign_not_found`, never a `22P02`) and the ownership
 * probe (tenant AND account; its 404 forwarded). The routes validate their own ids, so the family
 * gets no wrapper id guard. The contact-assignment flag is NOT checked: the allocation is served
 * in every mode (a pool campaign's table is all unassigned).
 */
export async function proxyAgencyInsightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  await registerInsightsAsOfNowRoutes(app);
}
