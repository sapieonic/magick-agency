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
  type AgencyAccountCallsPage,
  type AgencyMyCallbackDue,
  type AgencyMyCallsPage,
} from '@magick-agency/contracts/api/agency/call-log';
import { AGENCY_MY_CALL_LATER_ROWS_MAX } from '@magick-agency/contracts/api/agency/my-day';
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
  type StaffedCampaign,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import {
  ATTEMPT_QUERY_PARAMS,
  CALL_LOG_QUERY_PARAMS,
  PAGING_QUERY_PARAMS,
  forwardAllowedQuery,
  unknownQueryParamsError,
} from '../../agency/agency-spine.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { callLogPeopleIds, toCallLogWireRow, withCallLogNames } from '../../agency/campaign-call-log.js';
import {
  callListLabelIds,
  unfiledInboundIds,
  contactNameMap,
  mergeCallbacksDue,
  parseCallLogQuery,
  toMyCallRow,
} from '../../agency/call-lists.js';
import { myCallLater, myDayWindow, type MyCallLaterRead } from '../../agency/my-day.js';
import { ownerModeOf } from '../../agency/pacing/agent-queue.js';
import { clampLimit } from '../../agency/spine-filters.js';
import { UUID_RE } from '../../utils/uuid.js';
import { accountCampaignOrRefuse, accountOrRefuse } from './helpers/account-scope.js';
import { parseCallLogType } from './helpers/call-log-query.js';
import { dialerEnabled } from './helpers/dialer-gate.js';
import { noStoreHook } from './helpers/no-store.js';
import { replyValidationFailed } from './helpers/parse-or-400.js';
import { readKeysetCursor } from './helpers/read-cursor.js';
import { resolveMyAgentId } from './proxy-agency-staffing.routes.js';

const log = createChildLogger({ component: 'proxy-agency-call-lists' });

/** `GET /calls`'s own query key beside the Call log's. */
const ACCOUNT_CALLS_QUERY_PARAMS = ['campaign_id'] as const;

/** Everything `GET /my-calls` takes. No `agent_user_id`: the subject is the session's user. */
export const MY_CALLS_QUERY_PARAMS = ['type', 'campaign_id', 'from', 'to', 'include_counts', 'cursor', 'limit'] as const;

/** What the routes read; injectable for the route tests. */
export interface CallListsRouteDeps {
  campaign(campaignId: string): Promise<AgencyCampaignRecord | null>;
  /** The account's campaigns the user is actively staffed on, archived ones left out. */
  staffedCampaigns(tenantId: string, accountId: string, userId: string): Promise<StaffedCampaign[]>;
  callLaters(input: MyCallLatersInput): Promise<MyCallLaterRead>;
  dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  now(): Date;
}

const defaultDeps: CallListsRouteDeps = {
  campaign: (id) => agencyCampaignRepository.findById(id),
  staffedCampaigns: (tenantId, accountId, userId) => agencyCallListRepository.staffedCampaigns(tenantId, accountId, userId),
  callLaters: (input) => agencyMyDayRepository.callLaters(input),
  dialerEnabled,
  now: () => new Date(),
};

export interface ProxyAgencyCallListsOptions {
  deps?: Partial<CallListsRouteDeps>;
}

/**
 * The callbacks the agent booked that are due today or late: My day's call-later read
 * (`myCallLaterStatement`, its rule for whose callbacks they are, per assignment mode) on each
 * campaign of the account they are actively on, to the end of that campaign's day. Archived
 * campaigns are left out: nothing is dialled on one (`staffedCampaigns`, one read).
 *
 * `campaign` is the list's Campaign filter: the rows of that campaign alone, and none under "No
 * campaign" (a callback is booked on a campaign's contact, so it always has one). `total` stays
 * the whole count, the number on the To follow up chip, which no filter narrows.
 */
export async function myCallbacksDue(
  deps: CallListsRouteDeps,
  q: { tenantId: string; accountId: string; userId: string; now: Date; campaign?: string },
): Promise<{ rows: AgencyMyCallbackDue[]; total: number }> {
  const staffed = await deps.staffedCampaigns(q.tenantId, q.accountId, q.userId);
  const lists = await Promise.all(staffed.map(async (campaign) => {
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
  const shown = q.campaign === undefined
    ? lists
    : lists.filter((l, i) => q.campaign !== AGENCY_CALLS_NO_CAMPAIGN && staffed[i]!.id === q.campaign);
  return { rows: mergeCallbacksDue(shown.map((l) => l.rows)), total: lists.reduce((n, l) => n + l.total, 0) };
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
    const typed = parseCallLogType(rawType, reply);
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
      const campaign = await accountCampaignOrRefuse(reply, deps.campaign, rawCampaign, tenantId, accountId);
      if (!campaign) return reply;
      scope = { kind: 'campaign', campaignId: campaign.id, tenantId };
    }

    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;
    const { filters, source, includeCounts, ...narrowed } = parsed.value;
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
    // The agents and the Missed rows' assignees are one lookup over both.
    const [people, campaignNames] = await Promise.all([
      agentNamesOrNone(callLogPeopleIds(page.rows), tenantId, 'all calls'),
      agencyCallListRepository.campaignNames(tenantId, accountId, callListLabelIds(page.rows).campaignIds)
        .catch((err: unknown) => {
          log.warn(
            { tenantId, err: err instanceof Error ? err.message : String(err) },
            'all calls: the campaigns\' names could not be read',
          );
          return new Map<string, string>();
        }),
    ]);
    const body: AgencyAccountCallsPage = {
      rows: page.rows.map((row) => ({
        ...toCallLogWireRow(withCallLogNames(row, people)),
        campaign_name: row.campaign_id ? campaignNames.get(row.campaign_id) ?? null : null,
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
   * `type=to_follow_up`, narrowed by `campaign_id` as the rows are (the counts are not). A label read that fails is a 500, never rows served unmasked.
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
    const typed = parseCallLogType(rawType, reply);
    if (!typed) return reply;
    if (rawCampaign !== undefined && rawCampaign !== AGENCY_CALLS_NO_CAMPAIGN) {
      if (!UUID_RE.test(rawCampaign)) {
        return replyValidationFailed(reply, [{ param: 'campaign_id', message: `must be a campaign id or ${AGENCY_CALLS_NO_CAMPAIGN}` }]);
      }
      // The read keys two of its branches on the campaign alone, so the campaign is checked to be
      // this account's first; another account's or tenant's is as unknown as one that does not exist.
      if (!(await accountCampaignOrRefuse(reply, deps.campaign, rawCampaign, tenantId, accountId))) return reply;
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
      wantsCallbacks
        ? myCallbacksDue(deps, { tenantId, accountId, userId, now, ...(rawCampaign !== undefined ? { campaign: rawCampaign } : {}) })
        : Promise.resolve(null),
      // The Missed calls badge's own count of the caller's open rows.
      parsed.value.includeCounts
        ? agencyInboundCallRepository.countMissed({ tenantId, accountId, assignee: { userId } })
        : Promise.resolve(null),
    ]);

    const ids = callListLabelIds(page.rows);
    // An inbound row filed under no campaign is masked by its matched contact's campaign, when it
    // has one: only the campaigns' read waits for those; the contacts' names are read beside both.
    const campaignLabels = async () => {
      const matched = await agencyCallListRepository.inboundMatchedCampaigns(tenantId, accountId, unfiledInboundIds(page.rows));
      return {
        matchedCampaignIds: matched,
        campaigns: await agencyCallListRepository.campaigns(tenantId, accountId, [...new Set([...ids.campaignIds, ...matched.values()])]),
      };
    };
    const [{ matchedCampaignIds, campaigns }, contacts] = await Promise.all([
      campaignLabels(),
      agencyCallListRepository.contactNames(tenantId, accountId, ids.contactIds),
    ]);
    const labels = { campaigns, contactNames: contactNameMap(contacts), matchedCampaignIds };
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
