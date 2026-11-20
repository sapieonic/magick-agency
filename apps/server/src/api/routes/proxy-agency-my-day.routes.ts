import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_MY_CALL_LATER_ROWS_MAX,
  AGENCY_MY_DAY_QUERY_ERROR_CODE,
  type AgencyMyDay,
} from '@magick-agency/contracts/api/agency/my-day';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyAgentSessionRepository,
  agencyCampaignRepository,
  agencyMyDayRepository,
  type MyCallLatersInput,
  type MyDayCountsInput,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { buildMyDay, myDayWindow, parseMyDayQuery, type MyCallLaterRead, type MyDayCounts } from '../../agency/my-day.js';
import { ownerModeOf } from '../../agency/pacing/agent-queue.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { dialerEnabled } from './helpers/dialer-gate.js';
import { noStoreHook } from './helpers/no-store.js';
import { sendRefusal } from './helpers/refusal.js';
import { settledValue } from './helpers/settled.js';
import { resolveMyAgentId } from './proxy-agency-staffing.routes.js';

/*
 * The agent's own day on one campaign (agent station BE-1, BE-2, BE-3; rulings AS6, AS7, AS8;
 * contracts `api/agency/my-day.ts`), served at the console's path under `/proxy/agency`: Ready's
 * "My day" and call-later list, Start of day's target, Finish work's summary, on the console and
 * the agent app. The public layer of B16, SQL only (this layer's own read, as the callbacks list
 * is). The session and the tenant context (the hooks below), `agency.station.connect` (the agent
 * role and up), the caller as the subject (`400 missing_actor` without one), the account scope
 * (`400 account_scope_required`), the dialer flag (`403 feature_disabled`), the query (`400
 * invalid_my_day_query`), then the campaign: in the caller's tenant and account AND the caller
 * staffed on it or holding a live session on it, else `403 not_staffed` (one answer for a missing
 * campaign, another account's, and one the caller is not on). Not the contact-assignment flag:
 * My day serves `pool` campaigns too. Never cached (`Cache-Control: no-store`, refusals included):
 * rows name customers; never a number.
 *
 *  - `GET /my-day?campaign_id=`: the day is the campaign's own (`myDayWindow`, its local midnight to
 *    the next, by the server's clock); the agent's numbers (`AgencyMyDayRepository.counts`) and own
 *    call-laters (`.callLaters`, the assigned half on `strict` / `preferred` only) read together.
 *    No metric of its own: the HTTP histogram covers it.
 */

/** The copy of the 403 for a campaign the caller is not on (the station shows its own words, keyed on the code). */
export const MY_DAY_NOT_STAFFED_MESSAGE = 'You are not on this campaign. Ask your supervisor to add you.';

/** What the route reads besides the request. Tests replace it. */
export interface MyDayRouteDeps {
  campaign(campaignId: string): Promise<AgencyCampaignRecord | null>;
  /** The caller is actively staffed on the campaign. */
  staffed(tenantId: string, campaignId: string, userId: string): Promise<boolean>;
  /** The campaign of the caller's live session in the tenant, or null without one. */
  liveSessionCampaign(tenantId: string, userId: string): Promise<string | null>;
  counts(input: MyDayCountsInput): Promise<MyDayCounts>;
  callLaters(input: MyCallLatersInput): Promise<MyCallLaterRead>;
  /** The dialer flag, else the 403 sent (`dialerEnabled`). */
  dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  now(): Date;
}

const defaultMyDayRouteDeps: MyDayRouteDeps = {
  campaign: (id) => agencyCampaignRepository.findById(id),
  staffed: (t, c, u) => agencyCampaignAgentRepository.isActiveOnCampaign(t, c, u),
  liveSessionCampaign: async (t, u) => (await agencyAgentSessionRepository.findLiveForAgent(t, u))?.campaign_id ?? null,
  counts: (input) => agencyMyDayRepository.counts(input),
  callLaters: (input) => agencyMyDayRepository.callLaters(input),
  dialerEnabled,
  now: () => new Date(),
};

export interface ProxyAgencyMyDayOptions {
  deps?: MyDayRouteDeps;
}

export async function proxyAgencyMyDayRoutes(app: FastifyInstance, opts: ProxyAgencyMyDayOptions = {}): Promise<void> {
  const deps = opts.deps ?? defaultMyDayRouteDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);

  // ── GET /my-day ─────────────────────────────────────────────────────────────
  app.get(
    '/my-day',
    { preHandler: [requirePermission('agency.station.connect')] },
    async (request, reply) => {
      // The subject is always the caller: no parameter names another agent.
      const userId = resolveMyAgentId(request, reply);
      if (!userId) return reply;
      // The tenant context middleware has lower-cased both ids.
      const accountId = accountOrRefuse(request.accountId, reply);
      if (!accountId) return reply;
      if (!(await deps.dialerEnabled(request, reply))) return reply;
      const tenantId = request.tenantId!;
      const parsed = parseMyDayQuery(request.query as Record<string, unknown> | undefined);
      if (!parsed.ok) return sendRefusal(reply, 400, AGENCY_MY_DAY_QUERY_ERROR_CODE, parsed.message);
      const { campaignId } = parsed;

      // Three independent reads started together, judged in order (a read that throws is
      // rethrown in that order; the staffing answers are looked at only for a campaign in scope).
      const [campaignRead, staffedRead, liveRead] = await Promise.allSettled([
        deps.campaign(campaignId),
        deps.staffed(tenantId, campaignId, userId),
        deps.liveSessionCampaign(tenantId, userId),
      ]);
      const campaign = settledValue(campaignRead);
      const inScope = campaign !== null && campaign.tenant_id === tenantId && campaign.account_id === accountId;
      if (!campaign || !inScope || !(settledValue(staffedRead) || settledValue(liveRead) === campaignId)) {
        return sendRefusal(reply, 403, 'not_staffed', MY_DAY_NOT_STAFFED_MESSAGE);
      }

      const now = deps.now();
      const window = myDayWindow(campaign.default_timezone, now);
      const [counts, callLater] = await Promise.all([
        deps.counts({ agentUserId: userId, tenantId, accountId, campaignId, from: window.start, to: window.end }),
        deps.callLaters({
          campaignId,
          agentUserId: userId,
          ownerMode: ownerModeOf(campaign) !== null,
          callbackCodes: callbackCodes(campaign.disposition_catalog),
          dueBefore: window.end,
          now,
          limit: AGENCY_MY_CALL_LATER_ROWS_MAX,
        }),
      ]);
      const body: AgencyMyDay = buildMyDay(campaign, window, counts, callLater, now);
      return reply.send(body);
    },
  );
}
