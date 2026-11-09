/*
 * The as-of-now insights reads: summary, readiness, allocation, uploads. `agency.supervise`, then
 * `insightsCampaign` (flag, id, ownership). Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { insightsCache, insightsCacheKey } from '../../../agency/insights/cache.js';
import { liveStats } from '../helpers/live-stats.js';
import { computeSummary } from '../../../agency/insights/summary.js';
import { computeReadiness } from '../../../agency/insights/readiness.js';
import { computeAllocation } from '../../../agency/insights/allocation.js';
import { computeUploads } from '../../../agency/insights/uploads.js';
import { insightsCampaign, type CampaignParams } from './shared.js';

export async function registerInsightsAsOfNowRoutes(app: FastifyInstance): Promise<void> {
  /** GET /campaigns/:id/insights/summary — header, settings, headline, roster. Polled; cached. */
  app.get<CampaignParams>('/campaigns/:id/insights/summary', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await insightsCampaign(request, reply);
    if (!campaign) return reply;
    const body = await insightsCache.get(insightsCacheKey('summary', campaign), () =>
      computeSummary(campaign, { liveStats: () => liveStats(campaign) }));
    return reply.code(200).send(body);
  });

  /** GET /campaigns/:id/insights/readiness — the draft checklist. Not polled; not cached. */
  app.get<CampaignParams>('/campaigns/:id/insights/readiness', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await insightsCampaign(request, reply);
    if (!campaign) return reply;
    return reply.code(200).send(await computeReadiness(campaign));
  });

  /** GET /campaigns/:id/insights/allocation — per agent, as of now. Polled; cached. */
  app.get<CampaignParams>('/campaigns/:id/insights/allocation', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await insightsCampaign(request, reply);
    if (!campaign) return reply;
    const body = await insightsCache.get(insightsCacheKey('allocation', campaign), () => computeAllocation(campaign));
    return reply.code(200).send(body);
  });

  /** GET /campaigns/:id/insights/uploads — committed uploads, newest first. */
  app.get<CampaignParams>('/campaigns/:id/insights/uploads', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await insightsCampaign(request, reply);
    if (!campaign) return reply;
    return reply.code(200).send(await computeUploads(campaign));
  });
}
