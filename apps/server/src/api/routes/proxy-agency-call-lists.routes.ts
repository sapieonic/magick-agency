/*
 * The account's All calls and the agent's My calls (`docs/call-log.md` §7, CL31–CL38): the
 * campaign Call log's read (`AgencyAttemptRepository.listCallLog`) at two more scopes.
 *
 *  - `GET /proxy/agency/calls` (`agency.supervise`): every call of the account, of the three
 *    types, with the Call log's filters, chips and counts, each row's campaign named, and
 *    `campaign_id` a campaign's id or `none` (the calls filed under no campaign). The floor is
 *    the account's Soft-phone calls list's, which this replaces: that list was scoped to the
 *    whole account only for `agency.supervise`.
 *  - `GET /proxy/agency/my-calls` (`agency.station.connect`): the caller's own calls. The
 *    subject is the session's user and nothing in the query can name another. The customer's
 *    number is masked here where the row's campaign hides numbers from agents (AS9), and the
 *    rows carry no media (`agency/call-lists.ts` `toMyCallRow`). To follow up
 *    (`type=to_follow_up`) is the caller's open Missed rows (the Missed list's own rule, by its
 *    own index), then `callbacks_due`: the callbacks they booked that are due today or late,
 *    My day's call-later read on each campaign they are on.
 *
 * Both read the repositories here, as My day does (`proxy-agency-my-day.routes.ts`): nothing in
 * either touches per-session runtime state. Both sit behind the dialer's flag and neither behind
 * the soft phone's or inbound's (a list keeps the calls it holds when a flag goes off, SR5).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_CALLS_NO_CAMPAIGN,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  type AgencyAccountCallsPage,
  type AgencyMyCallbackDue,
  type AgencyMyCallsPage,
} from '@magick-agency/contracts/api/agency/call-log';
import { AGENCY_MY_CALL_LATER_ROWS_MAX } from '@magick-agency/contracts/api/agency/my-day';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { createChildLogger } from '@magick-agency/observability';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyAttemptRepository,
  agencyCallListRepository,
  agencyCallSettingsRepository,
  agencyCampaignRepository,
  agencyInboundCallRepository,
  agencyMyDayRepository,
  type CallLogScope,
  type MyCallLatersInput,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import {
  ATTEMPT_QUERY_PARAMS,
  CALL_LOG_QUERY_PARAMS,
  PAGING_QUERY_PARAMS,
  forwardAllowedQuery,
  unknownQueryParamsError,
} from '../../agency/agency-spine.js';
import { resolveAgentNames } from '../../agency/agency-agent-identity.js';
import {
  callLogSourceForType,
  isCallLogTypeFilter,
  nameCallLogAssignees,
  toCallLogWireRow,
  type CampaignCallLogRow,
} from '../../agency/campaign-call-log.js';
import {
  callListLabelIds,
  contactNameMap,
  mergeCallbacksDue,
  parseCallLogQuery,
  toMyCallRow,
} from '../../agency/call-lists.js';
import { myCallLater, myDayWindow, type MyCallLaterRead } from '../../agency/my-day.js';
import { ownerModeOf } from '../../agency/pacing/agent-queue.js';
import { clampLimit } from '../../agency/spine-filters.js';
import { UUID_RE } from '../../utils/uuid.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { dialerEnabled } from './helpers/dialer-gate.js';
import { noStoreHook } from './helpers/no-store.js';
import { replyValidationFailed } from './helpers/parse-or-400.js';
import { readKeysetCursor } from './helpers/read-cursor.js';
import { sendRefusal } from './helpers/refusal.js';
import { resolveMyAgentId } from './proxy-agency-staffing.routes.js';

const log = createChildLogger({ component: 'proxy-agency-call-lists' });

/** `GET /calls`'s own query key beside the Call log's. */
const ACCOUNT_CALLS_QUERY_PARAMS = ['campaign_id'] as const;

/** Everything `GET /my-calls` takes. No `agent_user_id`: the subject is the session's user. */
export const MY_CALLS_QUERY_PARAMS = ['type', 'campaign_id', 'from', 'to', 'include_counts', 'cursor', 'limit'] as const;

/** What the routes read; injectable for the route tests. */
export interface CallListsRouteDeps {
  campaign(campaignId: string): Promise<AgencyCampaignRecord | null>;
  /** The campaigns the user is actively staffed on in the tenant. */
  activeCampaignIds(tenantId: string, userId: string): Promise<string[]>;
  callLaters(input: MyCallLatersInput): Promise<MyCallLaterRead>;
  dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  now(): Date;
}

const defaultDeps: CallListsRouteDeps = {
  campaign: (id) => agencyCampaignRepository.findById(id),
  activeCampaignIds: async (tenantId, userId) =>
    (await agencyCampaignAgentRepository.listActiveForUser(tenantId, userId)).map((a) => a.campaign_id),
  callLaters: (input) => agencyMyDayRepository.callLaters(input),
  dialerEnabled,
  now: () => new Date(),
};

export interface ProxyAgencyCallListsOptions {
  deps?: Partial<CallListsRouteDeps>;
}

/** `?type=` (the public word) checked, and turned into the read's `source`. False once it has replied. */
function sourceForType(rawType: string | undefined, reply: FastifyReply): { source: ReturnType<typeof callLogSourceForType> } | null {
  if (rawType !== undefined && !isCallLogTypeFilter(rawType)) {
    void replyValidationFailed(reply, [
      { param: 'type', message: `must be one of: ${AGENCY_CALL_LOG_TYPE_FILTERS.join(', ')}` },
    ]);
    return null;
  }
  return { source: callLogSourceForType(rawType) };
}

/**
 * The callbacks the agent booked that are due today or late: My day's call-later read
 * (`myCallLaterStatement`, its rule for whose callbacks they are, per assignment mode) on each
 * campaign of the account they are actively on, to the end of that campaign's day. Archived
 * campaigns are left out: nothing is dialled on one.
 */
export async function myCallbacksDue(
  deps: CallListsRouteDeps,
  q: { tenantId: string; accountId: string; userId: string; now: Date },
): Promise<{ rows: AgencyMyCallbackDue[]; total: number }> {
  const ids = await deps.activeCampaignIds(q.tenantId, q.userId);
  const lists = await Promise.all(ids.map(async (id) => {
    const campaign = await deps.campaign(id);
    if (!campaign || campaign.tenant_id !== q.tenantId || campaign.account_id !== q.accountId || campaign.archived_at) {
      return { rows: [] as AgencyMyCallbackDue[], total: 0 };
    }
    const read = await deps.callLaters({
      campaignId: campaign.id,
      agentUserId: q.userId,
      ownerMode: ownerModeOf(campaign) !== null,
      callbackCodes: callbackCodes(campaign.disposition_catalog),
      dueBefore: myDayWindow(campaign.default_timezone, q.now).end,
      now: q.now,
      limit: AGENCY_MY_CALL_LATER_ROWS_MAX,
    });
    const later = myCallLater(campaign, read, q.now);
    return {
      rows: later.rows.map((r) => ({
        contact_id: r.contact_id,
        campaign_id: campaign.id,
        campaign_name: campaign.name,
        customer_name: r.customer_name,
        due_at: r.due_at,
        overdue: r.overdue,
      })),
      total: later.today + later.overdue,
    };
  }));
  return { rows: mergeCallbacksDue(lists.map((l) => l.rows)), total: lists.reduce((n, l) => n + l.total, 0) };
}

export async function proxyAgencyCallListsRoutes(app: FastifyInstance, opts: ProxyAgencyCallListsOptions = {}): Promise<void> {
  const deps: CallListsRouteDeps = { ...defaultDeps, ...opts.deps };
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // Lists of customers' numbers and what was said to them: never cached by a browser or a proxy.
  app.addHook('onRequest', noStoreHook);

  /**
   * GET /proxy/agency/calls — the account's All calls: `{ rows, next_cursor, limit, counts?, rule }`.
   *
   * The Call log's query (`type`, the attempt list's filters, `status`, `include_counts`,
   * `cursor`, `limit`) and `campaign_id`. A campaign's id reads that campaign's Call log itself
   * (the same statement, on the campaign's own indexes) once the campaign is known to be this
   * account's; another account's or tenant's is a 404, as on the Call log. `none` reads the
   * calls filed under no campaign.
   */
  app.get('/calls', { preHandler: requirePermission('agency.supervise') }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    if (!(await deps.dialerEnabled(request, reply))) return reply;
    const tenantId = request.tenantId!;

    const forwarded = forwardAllowedQuery(
      request.query, [...ATTEMPT_QUERY_PARAMS, ...CALL_LOG_QUERY_PARAMS, ...ACCOUNT_CALLS_QUERY_PARAMS], PAGING_QUERY_PARAMS,
    );
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const { type: rawType, campaign_id: rawCampaign, ...query } = forwarded.query;
    const typed = sourceForType(rawType, reply);
    if (!typed) return reply;
    const parsed = parseCallLogQuery({ ...query, ...(typed.source ? { source: typed.source } : {}) });
    if (!parsed.ok) return replyValidationFailed(reply, parsed.issues);

    let scope: CallLogScope = { kind: 'account', tenantId, accountId };
    if (rawCampaign === AGENCY_CALLS_NO_CAMPAIGN) {
      scope = { kind: 'account', tenantId, accountId, campaign: 'none' };
    } else if (rawCampaign !== undefined) {
      if (!UUID_RE.test(rawCampaign)) {
        return replyValidationFailed(reply, [{ param: 'campaign_id', message: `must be a campaign id or ${AGENCY_CALLS_NO_CAMPAIGN}` }]);
      }
      const campaign = await deps.campaign(rawCampaign);
      if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) {
        return sendRefusal(reply, 404, 'campaign_not_found', 'Campaign not found.');
      }
      scope = { kind: 'campaign', campaignId: campaign.id, tenantId };
    }

    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;
    const { filters, source, includeCounts } = parsed.value;
    const narrowed = {
      ...(parsed.value.softphoneStatus ? { softphoneStatus: parsed.value.softphoneStatus } : {}),
      ...(parsed.value.inboundOutcomes ? { inboundOutcomes: parsed.value.inboundOutcomes } : {}),
    };
    const [page, counts, rule] = await Promise.all([
      agencyAttemptRepository.listCallLog({
        scope, filters, source, ...narrowed,
        ...(cursor ? { after: cursor } : {}),
        limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
      }),
      includeCounts ? agencyAttemptRepository.countCallLog({ scope, filters, ...narrowed }) : Promise.resolve(null),
      agencyCallSettingsRepository.requireCampaign(tenantId, accountId),
    ]);

    // Names are a courtesy on top of the calls: a failed lookup serves the rows without them.
    const warn = (what: string) => (err: unknown) => log.warn(
      { tenantId, err: err instanceof Error ? err.message : String(err) }, `all calls: ${what} could not be read`,
    );
    const agentIds = [...new Set(page.rows.map((r) => r.agent_user_id).filter((id): id is string => typeof id === 'string'))];
    const [agentNames, campaigns, assigned] = await Promise.all([
      agentIds.length > 0
        ? resolveAgentNames(agentIds, tenantId).catch((err: unknown) => { warn('the agents\' names')(err); return new Map<string, string | null>(); })
        : new Map<string, string | null>(),
      agencyCallListRepository.campaigns(tenantId, accountId, callListLabelIds(page.rows).campaignIds)
        .catch((err: unknown) => { warn('the campaigns\' names')(err); return new Map<string, { name: string }>(); }),
      nameCallLogAssignees(page.rows, tenantId, resolveAgentNames, warn('the assignees\' names')),
    ]);
    const body: AgencyAccountCallsPage = {
      rows: assigned.map((row: CampaignCallLogRow) => ({
        ...toCallLogWireRow({ ...row, agent_name: row.agent_user_id ? agentNames.get(row.agent_user_id) ?? null : null }),
        campaign_name: row.campaign_id ? campaigns.get(row.campaign_id)?.name ?? null : null,
      })),
      next_cursor: page.next_cursor,
      limit: page.limit,
      ...(counts ? { counts } : {}),
      rule: { require_campaign: rule.on, require_campaign_since: rule.since ? new Date(rule.since).toISOString() : null },
    };
    return reply.send(body);
  });

  /**
   * GET /proxy/agency/my-calls — the caller's own calls: `{ rows, next_cursor, limit, counts?,
   * callbacks_due? }`. `counts` with `include_counts=1`; `callbacks_due` on the first page of
   * `type=to_follow_up`. A label read that fails is a 500, never rows served unmasked.
   */
  app.get('/my-calls', { preHandler: requirePermission('agency.station.connect') }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (userId === null) return reply;
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    if (!(await deps.dialerEnabled(request, reply))) return reply;
    const tenantId = request.tenantId!;

    const forwarded = forwardAllowedQuery(request.query, MY_CALLS_QUERY_PARAMS);
    if (!forwarded.ok) return reply.code(400).send(unknownQueryParamsError(forwarded.unknown));
    const { type: rawType, campaign_id: rawCampaign, from, to, include_counts: rawCounts } = forwarded.query;
    const typed = sourceForType(rawType, reply);
    if (!typed) return reply;
    if (rawCampaign !== undefined && rawCampaign !== AGENCY_CALLS_NO_CAMPAIGN && !UUID_RE.test(rawCampaign)) {
      return replyValidationFailed(reply, [{ param: 'campaign_id', message: `must be a campaign id or ${AGENCY_CALLS_NO_CAMPAIGN}` }]);
    }
    const parsed = parseCallLogQuery({
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(rawCounts !== undefined ? { include_counts: rawCounts } : {}),
      ...(typed.source ? { source: typed.source } : {}),
    });
    if (!parsed.ok) return replyValidationFailed(reply, parsed.issues);
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;

    const scope: CallLogScope = {
      kind: 'agent', tenantId, accountId, agentUserId: userId,
      ...(rawCampaign === AGENCY_CALLS_NO_CAMPAIGN ? { campaign: 'none' as const } : rawCampaign ? { campaign: rawCampaign } : {}),
    };
    const toFollowUp = parsed.value.source === 'to_follow_up';
    const now = deps.now();
    const wantsCallbacks = parsed.value.includeCounts || (toFollowUp && !cursor);
    const [page, callbacks, missed] = await Promise.all([
      agencyAttemptRepository.listCallLog({
        scope,
        filters: parsed.value.filters,
        source: parsed.value.source,
        ...(cursor ? { after: cursor } : {}),
        limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
      }),
      wantsCallbacks ? myCallbacksDue(deps, { tenantId, accountId, userId, now }) : Promise.resolve(null),
      // The Missed calls badge's own count of the caller's open rows.
      parsed.value.includeCounts
        ? agencyInboundCallRepository.countMissed({ tenantId, accountId, assignee: { userId } })
        : Promise.resolve(null),
    ]);

    const ids = callListLabelIds(page.rows);
    const [campaigns, contacts] = await Promise.all([
      agencyCallListRepository.campaigns(tenantId, accountId, ids.campaignIds),
      agencyCallListRepository.contactNames(tenantId, accountId, ids.contactIds),
    ]);
    const labels = { campaigns, contactNames: contactNameMap(contacts) };
    const body: AgencyMyCallsPage = {
      rows: page.rows.map((row) => toMyCallRow(row, labels)),
      next_cursor: page.next_cursor,
      limit: page.limit,
      ...(missed && callbacks
        ? { counts: { to_follow_up: missed.open + callbacks.total, missed_open: missed.open, callbacks_due: callbacks.total } }
        : {}),
      ...(toFollowUp && !cursor && callbacks ? { callbacks_due: callbacks.rows } : {}),
    };
    return reply.send(body);
  });
}
