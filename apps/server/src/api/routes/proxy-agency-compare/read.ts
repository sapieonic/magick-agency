/*
 * `POST /compare/query` and `GET /compare/options`: Compare agents' read (contracts
 * `api/agency/compare.ts`, docs/compare-agents.md §8). Part of `proxy-agency-compare.routes.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgencyCompareOptions } from '@magick-agency/contracts/api/agency/compare';
import { catalogRecordsPromises, compareStartingLens } from '@magick-agency/domain/agent-compare';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { CompareAborted, CompareRefusal, type CompareWindowScope } from '../../../agency/compare/read.js';
import {
  uuidOf,
  checkCompareMetrics,
  checkCompareWindow,
  compareOptionsQuerySchema,
  compareQueryBodySchema,
} from '../../../agency/compare/validate.js';
import { localDayBounds } from '../../../agency/reports/schedule.js';
import { isRequestZone } from '../../../agency/zone.js';
import { accountOrRefuse } from '../helpers/account-scope.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import {
  compareGate,
  compareViewToWire,
  CLIENT_CLOSED_STATUS,
  clientGoneSignal,
  sendCompareRefusal,
  sendCompareTimedOut,
  type CompareCampaign,
  type CompareRouteDeps,
} from './shared.js';

/** A guard's refusal as its answer; anything else propagates. */
function sendGuardRefusal(err: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  // The client closed the request first: its slot is back and its statement cancelled; the
  // answer goes nowhere.
  if (err instanceof CompareAborted) return reply.code(CLIENT_CLOSED_STATUS).send();
  if (!(err instanceof CompareRefusal)) throw err;
  return err.code === 'compare_timed_out' ? sendCompareTimedOut(request, reply) : sendCompareRefusal(reply, err.code);
}

/** The campaign (`compare_campaign_required`, `compare_campaign_not_found`). Null once it has replied. */
export async function resolveCompareCampaign(
  deps: CompareRouteDeps,
  reply: FastifyReply,
  q: { tenantId: string; accountId: string; campaignId: unknown },
): Promise<CompareCampaign | null> {
  if (q.campaignId === undefined || q.campaignId === null || q.campaignId === '') {
    sendCompareRefusal(reply, 'compare_campaign_required');
    return null;
  }
  const campaignId = uuidOf(q.campaignId);
  const campaign = campaignId === null ? null : await deps.campaign(q.tenantId, q.accountId, campaignId);
  if (campaign === null) {
    sendCompareRefusal(reply, 'compare_campaign_not_found');
    return null;
  }
  return campaign;
}

/** The zone, then the window (`compare_timezone_invalid`, `compare_window_invalid`). Null once it has replied. */
async function resolveWindow(
  deps: CompareRouteDeps,
  reply: FastifyReply,
  q: { tenantId: string; accountId: string; campaign: CompareCampaign; from: string; to: string; timezone: string | undefined },
): Promise<CompareWindowScope | null> {
  // The cheap rules first: Postgres is asked only about a zone that passes them.
  const databaseTimezone = isRequestZone(q.timezone) ? await deps.databaseZone(q.timezone) : null;
  const window = checkCompareWindow({ from: q.from, to: q.to, timezone: q.timezone }, databaseTimezone, deps.today);
  if (!window.ok) {
    sendCompareRefusal(reply, window.code);
    return null;
  }
  const { start, end } = localDayBounds(q.from, q.to, window.timezone);
  return {
    tenantId: q.tenantId, accountId: q.accountId, campaignId: q.campaign.id,
    // The answer echoes the request's zone; the reads cut days in Postgres's name for it.
    from: q.from, to: q.to, timezone: window.timezone, databaseTimezone: window.databaseTimezone, start, end,
  };
}

export async function registerCompareReadRoutes(app: FastifyInstance, deps: CompareRouteDeps): Promise<void> {
  // ── POST /compare/query ─────────────────────────────────────────────────────
  app.post('/compare/query', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const gone = clientGoneSignal(reply);
    if (!(await compareGate(deps, request, reply))) return reply;
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = parseOr400(compareQueryBodySchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const body = parsed.data;

    const tenantId = request.tenantId!;
    // The contract's order: the campaign, the agents and metrics, the zone, the window.
    const campaign = await resolveCompareCampaign(deps, reply, { tenantId, accountId, campaignId: body.campaign_id });
    if (!campaign) return reply;
    const checked = checkCompareMetrics(body, campaign.codes);
    if (!checked.ok) return sendCompareRefusal(reply, checked.code);
    const scope = await resolveWindow(deps, reply, { tenantId, accountId, campaign, from: body.from, to: body.to, timezone: body.timezone });
    if (!scope) return reply;

    try {
      const outcome = await deps.reads.query({
        ...scope,
        agentIds: checked.agentIds,
        metrics: checked.resolved.metrics,
        trend: checked.resolved.trend,
      }, gone);
      if (outcome.kind === 'not_in_cohort') return sendCompareRefusal(reply, 'compare_agent_not_in_cohort');
      return reply.send(outcome.response);
    } catch (err) {
      return sendGuardRefusal(err, request, reply);
    }
  });

  // ── GET /compare/options ────────────────────────────────────────────────────
  app.get('/compare/options', { preHandler: [requirePermission('agency.supervise')] }, async (request, reply) => {
    const gone = clientGoneSignal(reply);
    if (!(await compareGate(deps, request, reply))) return reply;
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = parseOr400(compareOptionsQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const q = parsed.data;
    const tenantId = request.tenantId!;

    const campaign = await resolveCompareCampaign(deps, reply, { tenantId, accountId, campaignId: q.campaign_id });
    if (!campaign) return reply;
    const scope = await resolveWindow(deps, reply, { tenantId, accountId, campaign, from: q.from, to: q.to, timezone: q.timezone });
    if (!scope) return reply;

    try {
      // One after the other: the cohort's snapshot holds a pooled connection until it ends, and a
      // compare request never holds two (the process-wide limit counts one per read).
      const cohort = await deps.reads.cohort(scope, gone);
      const defaultView = await deps.views.findCampaignDefault({ tenantId, accountId }, campaign.id);
      const ownerNames = defaultView === null ? new Map<string, string | null>() : await deps.names([defaultView.owner_user_id], tenantId);
      const body: AgencyCompareOptions = {
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        agents: cohort.agents,
        outcome_codes: campaign.codes,
        records_promises: catalogRecordsPromises(campaign.codes),
        starting_lens: compareStartingLens(campaign.codes),
        default_view: defaultView === null ? null : compareViewToWire(defaultView, ownerNames),
      };
      return reply.send(body);
    } catch (err) {
      return sendGuardRefusal(err, request, reply);
    }
  });
}
