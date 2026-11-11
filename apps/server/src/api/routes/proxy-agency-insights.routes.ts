import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerInsightsAsOfNowRoutes } from './proxy-agency-insights/as-of-now.js';
import { registerInsightsRangeRoutes } from './proxy-agency-insights/range.js';
import { registerHomeBoardRoutes } from './proxy-agency-insights/home.js';

export { registerInsightsAsOfNowRoutes, registerInsightsRangeRoutes, registerHomeBoardRoutes };

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
 *  - Over a range (`./proxy-agency-insights/range.ts`): `activity`, `trends`, `health`, from the
 *    insights rollup and the pacing history. `from` / `to` / `bucket` are validated after the
 *    guards and refused `400 invalid_insights_query`; the served range (rounded to the rollup's
 *    15-minute buckets) is echoed and is part of the cache key.
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below);
 * `agency.supervise` (account admin and up; tenant owners pass; agents and viewers get the RBAC
 * 403); then `insightsCampaign` (`./proxy-agency-insights/shared.ts`): the dialer flag (`403
 * feature_disabled`), the id's shape (`404 campaign_not_found`, never a `22P02`) and the ownership
 * probe (tenant AND account; its 404 forwarded). The routes validate their own ids, so the family
 * gets no wrapper id guard. The contact-assignment flag is NOT checked: the allocation is served
 * in every mode (a pool campaign's table is all unassigned).
 *
 * Home's board (`./proxy-agency-insights/home.ts`, `GET /proxy/agency/home`, decision B28a) lives
 * here too: it reads the allocation through the same cache and the stats strip through the same
 * hop as the summary. It is account-wide, so it has no `:id`: `agency.supervise`, then the account
 * scope (`400 account_scope_required`), then the dialer flag.
 */
export async function proxyAgencyInsightsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  await registerInsightsAsOfNowRoutes(app);
  await registerInsightsRangeRoutes(app);
  await registerHomeBoardRoutes(app);
}
