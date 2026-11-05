/*
 * The range insights reads: activity, trends, health. `agency.supervise`, then `insightsCampaign`
 * (flag, id, ownership), then the query (`parseInsightsRange`: a 400 in the family's
 * `{ error, code, message }` shape, after the guards so a caller who may not read the campaign
 * learns nothing from it). Cached per campaign, status, `updated_at`, served range and bucket.
 * Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AGENCY_INSIGHTS_QUERY_ERROR_CODE } from '@magick-agency/contracts/api/agency/insights';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { insightsCache, insightsCacheKey } from '../../../agency/insights/cache.js';
import { computeActivity } from '../../../agency/insights/activity.js';
import { computeTrends } from '../../../agency/insights/trends.js';
import { computeHealth } from '../../../agency/insights/health.js';
import { parseInsightsRange, rangeCacheSuffix, type ServedInsightsRange } from '../../../agency/insights/range.js';
import { insightsCampaign, type CampaignParams } from './shared.js';

/** The 400 body of a refused range query. */
export function invalidQueryBody(message: string) {
  return { error: 'Bad Request', code: AGENCY_INSIGHTS_QUERY_ERROR_CODE, message } as const;
}

/** The guarded campaign and its served range, or null once it has replied. */
async function guardedRange(
  request: FastifyRequest<CampaignParams>,
  reply: FastifyReply,
  bucket: boolean,
): Promise<{ campaign: AgencyCampaignRecord; range: ServedInsightsRange } | null> {
  const campaign = await insightsCampaign(request, reply);
  if (!campaign) return null;
  const parsed = parseInsightsRange(request.query, { createdAt: new Date(campaign.created_at), now: new Date(), bucket });
  if (!parsed.ok) {
    await reply.code(400).send(invalidQueryBody(parsed.message));
    return null;
  }
  return { campaign, range: parsed.range };
}

const key = (section: string, campaign: AgencyCampaignRecord, range: ServedInsightsRange) =>
  `${insightsCacheKey(section, campaign)}:${rangeCacheSuffix(range)}`;

export async function registerInsightsRangeRoutes(app: FastifyInstance): Promise<void> {
  /** GET /campaigns/:id/insights/activity?from&to — calls, outcomes, callbacks, overrides, agents. */
  app.get<CampaignParams>('/campaigns/:id/insights/activity', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const got = await guardedRange(request, reply, false);
    if (!got) return reply;
    const body = await insightsCache.get(key('activity', got.campaign, got.range), () => computeActivity(got.campaign, got.range));
    return reply.code(200).send(body);
  });

  /** GET /campaigns/:id/insights/trends?from&to&bucket — the series and the best hours. */
  app.get<CampaignParams>('/campaigns/:id/insights/trends', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const got = await guardedRange(request, reply, true);
    if (!got) return reply;
    const range = { ...got.range, bucket: got.range.bucket ?? 'day' };
    const body = await insightsCache.get(key('trends', got.campaign, range), () => computeTrends(got.campaign, range));
    return reply.code(200).send(body);
  });

  /** GET /campaigns/:id/insights/health?from&to — abandonment, pre-dial, caller IDs, stalls, recording. */
  app.get<CampaignParams>('/campaigns/:id/insights/health', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const got = await guardedRange(request, reply, false);
    if (!got) return reply;
    const body = await insightsCache.get(key('health', got.campaign, got.range), () => computeHealth(got.campaign, got.range));
    return reply.code(200).send(body);
  });
}
