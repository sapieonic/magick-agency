/**
 * The account's All calls and the agent's My calls (`docs/call-log.md` §7, CL31–CL38): what
 * the two routes do to the call log read's rows before they leave the server. Pure: no fastify,
 * no db.
 *
 *  - {@link parseCallLogQuery}: the Call log's query (the attempt list's filters, `source`,
 *    `status`, the two outcome vocabularies, `include_counts`), parsed once for the campaign's
 *    internal read and for the account's.
 *  - {@link toMyCallRow}: a row as the agent may see it. The customer's number is MASKED HERE
 *    when the row's campaign hides numbers from agents (`phone_display: 'masked'`, AS9), on
 *    every type of row, and nothing of the call's media leaves (no leg id, no recording).
 */
import { maskFactPhone } from '@magick-agency/domain/fact-phone';
import type { CustomerNameDisplay } from '@magick-agency/domain/customer-name';
import type { AgencyDisposition, AgencyPhoneDisplay } from '@magick-agency/contracts/agency';
import {
  AGENCY_CALL_LOG_STATUSES,
  type AgencyCallLogInboundOutcomeFilter,
  type AgencyCallLogStatus,
  type AgencyMyCallbackDue,
  type AgencyMyCallRow,
} from '@magick-agency/contracts/api/agency/call-log';
import type { AgencyAttemptFilters } from './spine-filters.js';
import { parseAttemptFilters, parseFlagParam, type FilterIssue } from './spine-filters.js';
import {
  CAMPAIGN_CALL_LOG_SOURCE_FILTERS,
  isCallLogStatus,
  isCampaignCallLogSourceFilter,
  splitCallLogOutcomes,
  type CampaignCallLogRow,
  type CampaignCallLogSourceFilter,
} from './campaign-call-log.js';
import { matchName } from './inbound/match-name.js';
import { UUID_RE } from '../utils/uuid.js';

/** The Call log's query, parsed ({@link parseCallLogQuery}). */
export interface ParsedCallLogQuery {
  filters: AgencyAttemptFilters;
  source: CampaignCallLogSourceFilter | null;
  softphoneStatus?: AgencyCallLogStatus;
  inboundOutcomes?: AgencyCallLogInboundOutcomeFilter[];
  includeCounts: boolean;
}

/**
 * The Call log's query: the attempt list's filters, `source` (one type, or `to_follow_up`),
 * `status` (the soft-phone status), `outcome` in its two vocabularies and `include_counts`.
 * `cursor` and `limit` are the route's. One parse for every scope the log is read at, so a
 * filter cannot mean one thing on a campaign's log and another on the account's.
 */
export function parseCallLogQuery(
  query: Record<string, unknown>,
): { ok: true; value: ParsedCallLogQuery } | { ok: false; issues: FilterIssue[] } {
  // `outcome` holds two vocabularies here: the attempt list's, and what only an inbound call
  // can have happened to it (Missed, Voicemail, Abandoned). The attempt parser knows its own.
  const happened = splitCallLogOutcomes(query['outcome']);
  const { outcome: _outcome, ...withoutOutcome } = query;
  void _outcome;
  const parsed = parseAttemptFilters({ ...withoutOutcome, ...(happened.attempt !== undefined ? { outcome: happened.attempt } : {}) });
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  if (parsed.filters.agentUserId !== undefined && !UUID_RE.test(parsed.filters.agentUserId)) {
    return { ok: false, issues: [{ param: 'agent_user_id', message: 'must be an agent id' }] };
  }
  const rawSource = query['source'];
  if (rawSource !== undefined && !isCampaignCallLogSourceFilter(rawSource)) {
    return { ok: false, issues: [{ param: 'source', message: `must be one of: ${CAMPAIGN_CALL_LOG_SOURCE_FILTERS.join(', ')}` }] };
  }
  const rawStatus = query['status'];
  if (rawStatus !== undefined && !isCallLogStatus(rawStatus)) {
    return { ok: false, issues: [{ param: 'status', message: `must be one of: ${AGENCY_CALL_LOG_STATUSES.join(', ')}` }] };
  }
  const countsFlag: FilterIssue[] = [];
  const includeCounts = parseFlagParam('include_counts', query['include_counts'], countsFlag) === true;
  if (countsFlag.length > 0) return { ok: false, issues: countsFlag };
  return {
    ok: true,
    value: {
      filters: parsed.filters,
      source: rawSource === undefined ? null : rawSource,
      ...(rawStatus === undefined ? {} : { softphoneStatus: rawStatus }),
      ...(happened.inbound.length > 0 ? { inboundOutcomes: happened.inbound } : {}),
      includeCounts,
    },
  };
}

/** A campaign as a list of calls labels it (`AgencyCallListRepository.campaigns`). */
export interface CallListCampaignLabel {
  name: string;
  phone_display: string | null;
  disposition_catalog: AgencyDisposition[] | null;
}

/** The ids a page of rows needs labels for. */
export function callListLabelIds(rows: readonly CampaignCallLogRow[]): { campaignIds: string[]; contactIds: string[] } {
  const ids = (values: Array<string | null>): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string'))];
  return { campaignIds: ids(rows.map((r) => r.campaign_id)), contactIds: ids(rows.map((r) => r.contact_id)) };
}

/** Each contact's display name by the station card's rule (`matchName`, AS19 S1); a contact with none is absent. */
export function contactNameMap(
  contacts: ReadonlyArray<{ id: string; context: Record<string, unknown> | null; display: CustomerNameDisplay | null }>,
): Map<string, string> {
  const names = new Map<string, string>();
  for (const c of contacts) {
    const name = matchName(c.context, c.display);
    if (name) names.set(c.id, name);
  }
  return names;
}

/**
 * The customer's number as an agent may see it on a row that names `campaigns`: the campaign
 * the call is filed under and, for an inbound call filed under none, the campaign of the
 * contact it matched (`matched_campaign_id`: a row written while an older server ran has that
 * and no `campaign_id`). One entry per campaign the row names; `undefined` for one the label
 * read did not return.
 *
 * Shown in full only when every campaign named says exactly `full`. **Anything else masks**
 * (fail closed): a campaign that hides numbers, one the read did not return, and a stored
 * setting this code does not know. A call that names no campaign has no setting to hide it by,
 * and is shown in full.
 */
export function agentPhone(
  phone: string | null,
  campaigns: ReadonlyArray<CallListCampaignLabel | undefined>,
): { phone: string | null; phone_masked: boolean } {
  if (phone === null) return { phone: null, phone_masked: false };
  const full: AgencyPhoneDisplay = 'full';
  const masked = campaigns.some((campaign) => campaign?.phone_display !== full);
  return masked ? { phone: maskFactPhone(phone), phone_masked: true } : { phone, phone_masked: false };
}

/** What {@link toMyCallRow} labels a page of rows with. */
export interface MyCallLabels {
  campaigns: ReadonlyMap<string, CallListCampaignLabel>;
  contactNames: ReadonlyMap<string, string>;
  /**
   * Inbound call id → the campaign of the contact it matched, for the inbound rows filed under
   * no campaign (`AgencyCallListRepository.inboundMatchedCampaigns`). Read for the mask alone:
   * the row still says it has no campaign.
   */
  matchedCampaignIds?: ReadonlyMap<string, string>;
}

/** The inbound rows of a page that are filed under no campaign: the ones whose matched campaign the mask needs. */
export function unfiledInboundIds(rows: readonly CampaignCallLogRow[]): string[] {
  return rows.filter((r) => r.source === 'inbound' && r.campaign_id === null).map((r) => r.id);
}

/**
 * A row of the call log read → the agent's own row (`AgencyMyCallRow`). Built field by field,
 * never spread, so a column added to the read (a recording link, the media leg, another
 * agent's name) cannot reach an agent by being forgotten here.
 */
export function toMyCallRow(
  row: CampaignCallLogRow,
  labels: MyCallLabels,
): AgencyMyCallRow {
  const campaign = row.campaign_id ? labels.campaigns.get(row.campaign_id) : undefined;
  const matchedId = row.source === 'inbound' && row.campaign_id === null ? labels.matchedCampaignIds?.get(row.id) : undefined;
  const named = [
    ...(row.campaign_id ? [campaign] : []),
    ...(matchedId ? [labels.campaigns.get(matchedId)] : []),
  ];
  const inbound = row.source === 'inbound' ? row.inbound : null;
  const followUp = inbound?.follow_up ?? null;
  return {
    type: row.source,
    id: row.id,
    created_at: row.created_at,
    campaign_id: row.campaign_id,
    campaign_name: campaign?.name ?? null,
    contact_id: row.contact_id,
    customer_name: row.contact_id ? labels.contactNames.get(row.contact_id) ?? null : null,
    ...agentPhone(row.phone_e164, named),
    state: row.state,
    outcome: row.outcome,
    disposition_code: row.disposition_code,
    disposition_label: row.disposition_code
      ? campaign?.disposition_catalog?.find((d) => d.code === row.disposition_code)?.label ?? null
      : null,
    auto_disposition_code: row.auto_disposition_code ?? null,
    callback_at: row.callback_at,
    promise_date: row.promise_date ?? null,
    promise_amount: row.promise_amount ?? null,
    talk_seconds: row.talk_seconds,
    notes: row.notes,
    attempt_number: row.attempt_number,
    redial: row.source === 'dialler' && (row.redial_number ?? 0) > 0,
    dialed_at: row.dialed_at,
    requires_disposition: row.source === 'dialler' ? false : row.requires_disposition,
    callback_of: row.source === 'soft_phone' ? row.callback_of : null,
    wait_seconds: inbound ? inbound.wait_seconds : null,
    queued: inbound?.queued ?? false,
    voicemail_seconds: inbound?.voicemail_seconds ?? null,
    follow_up: followUp
      ? {
        status: followUp.status,
        reason: followUp.reason,
        closed_cause: followUp.closed_cause,
        handled_reason: followUp.handled_reason,
      }
      : null,
    called_back: inbound?.called_back ?? null,
  };
}

/** The most callbacks To follow up lists. */
export const MY_CALLBACKS_DUE_MAX = 50;

/** The callbacks of several campaigns as one list, soonest due first, at most {@link MY_CALLBACKS_DUE_MAX}. */
export function mergeCallbacksDue(lists: ReadonlyArray<readonly AgencyMyCallbackDue[]>): AgencyMyCallbackDue[] {
  return lists.flat()
    .sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : a.contact_id.localeCompare(b.contact_id)))
    .slice(0, MY_CALLBACKS_DUE_MAX);
}
