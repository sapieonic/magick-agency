/**
 * The campaign's call log as one list: its dialler attempts, the soft-phone calls tagged to it
 * and the inbound calls filed under it, newest first on one keyset (decisions SR6, CL11;
 * `docs/call-log.md`). Read through the
 * internal `GET /agency-campaigns/:id/call-log` by the campaign call export
 * (`GET /proxy/agency/campaigns/:id/attempts.csv`), which drains it, and by the console's Call
 * log (`GET /proxy/agency/campaigns/:id/call-log`), which serves its pages as the contract's
 * rows ({@link toCallLogWireRow}) with the chips' counts.
 *
 * Every row says where it came from (`source`, wire-style values). A soft-phone row carries
 * the attempt row's field names, each mapped to the manual call's own column, and NULL where
 * the soft phone has no such thing (an attempt number, a wrap-up allotment, a redial link, the
 * campaign's automatic outcome, a reserved session). Untagged soft-phone calls belong to no
 * campaign and are never in it (SR4).
 *
 * An inbound row is an ENDED inbound call filed under the campaign (`campaign_id`, 0067) that
 * we served (never `rejected`); a live one is on Live calls. It carries the attempt row's field
 * names too (`phone_e164` the caller's number, `caller_id` the number rung, `agent_user_id` who
 * answered, `created_at` when it arrived, which is what the keyset orders it by), with what only
 * an inbound call has under `inbound`. The `to_follow_up` source is the campaign's OPEN Missed
 * rows: the same inbound rows, kept by `INBOUND_MISSED_OPEN_SQL`, whatever the dates.
 *
 * A LEAF module: types and constants. No fastify, no db.
 */
import type {
  AgencyAttemptRow,
  AgencyManualCallOutcome,
  AgencyManualCallState,
} from '@magick-agency/contracts/agency';
import type {
  AgencyInboundCallOutcome,
  AgencyInboundCampaignSource,
  AgencyInboundClosedCause,
  AgencyInboundFollowUpStatus,
  AgencyInboundHandledReason,
  AgencyInboundMissedReason,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS,
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  type AgencyCallLogInboundOutcomeFilter,
  type AgencyCallLogInboundRow,
  type AgencyCallLogStatus,
  type AgencyCallLogCounts,
  type AgencyCallLogRow,
  type AgencyCallLogTypeFilter,
  type AgencyInboundJourneyStep,
} from '@magick-agency/contracts/api/agency/call-log';

/** Where a call-log row came from: the campaign's dialler, an agent's soft phone, or the customer's own call. */
export type CampaignCallSource = 'dialler' | 'soft_phone' | 'inbound';

/** Every {@link CampaignCallSource}, in the order a reader meets them. */
export const CAMPAIGN_CALL_SOURCES = ['dialler', 'soft_phone', 'inbound'] as const satisfies readonly CampaignCallSource[];

export function isCampaignCallSource(value: unknown): value is CampaignCallSource {
  return typeof value === 'string' && (CAMPAIGN_CALL_SOURCES as readonly string[]).includes(value);
}

/**
 * What the internal read's `?source=` keeps: one source, or `to_follow_up`, the campaign's open
 * Missed rows (inbound rows; a view of the list, not a fourth source).
 */
export type CampaignCallLogSourceFilter = CampaignCallSource | 'to_follow_up';

export const CAMPAIGN_CALL_LOG_SOURCE_FILTERS = [
  ...CAMPAIGN_CALL_SOURCES, 'to_follow_up',
] as const satisfies readonly CampaignCallLogSourceFilter[];

export function isCampaignCallLogSourceFilter(value: unknown): value is CampaignCallLogSourceFilter {
  return typeof value === 'string' && (CAMPAIGN_CALL_LOG_SOURCE_FILTERS as readonly string[]).includes(value);
}

/**
 * `?outcome=` on the call log holds two vocabularies: the attempt list's outcomes, and what only
 * an inbound call can have happened to it (`AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS`). Split
 * here, before the attempt filters are parsed (which know only their own): `attempt` goes on to
 * `parseAttemptFilters` as `outcome`, `inbound` to the read as `inboundOutcomes`. Blank items
 * are dropped as `multiParam` drops them.
 */
export function splitCallLogOutcomes(raw: unknown): { attempt: string | undefined; inbound: AgencyCallLogInboundOutcomeFilter[] } {
  if (raw === undefined || raw === null) return { attempt: undefined, inbound: [] };
  const items = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => String(value).split(','))
    .map((item) => item.trim()).filter((item) => item.length > 0);
  const inbound = items.filter((item): item is AgencyCallLogInboundOutcomeFilter =>
    (AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS as readonly string[]).includes(item));
  const attempt = items.filter((item) => !(inbound as string[]).includes(item));
  return { attempt: attempt.length > 0 ? attempt.join(',') : undefined, inbound: [...new Set(inbound)] };
}

/** A dialler row: the attempt list's own row, marked. */
export type CampaignDiallerLogRow = AgencyAttemptRow & { source: 'dialler' };

/**
 * A soft-phone call tagged to the campaign, in the attempt row's shape. `id` is the manual
 * call's id (`agency_manual_calls.id`, the soft-phone call detail's), `contact_id` the roster
 * contact the number matched (claimed or linked), else null; `phone_e164` the number dialled.
 */
export interface CampaignSoftphoneLogRow {
  source: 'soft_phone';
  id: string;
  campaign_id: string | null;
  contact_id: string | null;
  attempt_number: null;
  phone_e164: string;
  caller_id: string;
  /** Who placed it (a soft-phone call always has an agent). */
  agent_user_id: string;
  reserved_agent_id: null;
  state: AgencyManualCallState;
  outcome: AgencyManualCallOutcome | null;
  disposition_code: string | null;
  auto_disposition_code: null;
  notes: string | null;
  callback_at: string | null;
  /** The soft-phone call's own promise to pay (PT1): `YYYY-MM-DD`, and the amount's two-place string. */
  promise_date: string | null;
  promise_amount: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  webrtc_call_id: string | null;
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: null;
  redial_of_attempt_id: null;
  redial_number: null;
  /**
   * The soft phone's own facts, for the Call log's rows (the export has no column for them):
   * whether a Do Not Call or calling-hours refusal was overridden to place the call, whether
   * it still waits for its outcome, and when it settled.
   */
  dnc_overridden: boolean;
  hours_overridden: boolean;
  requires_disposition: boolean;
  settled_at: string | null;
  /**
   * The Missed inbound call this call rang back (`callback_of_inbound_call_id`, CL1) and when
   * that call arrived (null: its row is gone); null: not a call back.
   */
  callback_of: { inbound_call_id: string; arrived_at: string | null } | null;
  created_at: string;
}

/** What only an inbound call has ({@link CampaignInboundLogRow.inbound}). */
export interface CampaignInboundFacts {
  campaign_source: AgencyInboundCampaignSource | null;
  route_name: string | null;
  /** Whole seconds from arrival to the agent's answer, else to the end. */
  wait_seconds: number;
  /** The caller was queued for an agent. */
  queued: boolean;
  /** The agent who answered is the caller's sticky agent. */
  via_sticky_agent: boolean;
  /** The voicemail's length while the row still names one. */
  voicemail_seconds: number | null;
  /** The Missed row; null for an answered call. `assignee_name` is the public layer's. */
  follow_up: {
    status: AgencyInboundFollowUpStatus;
    reason: AgencyInboundMissedReason;
    closed_cause: AgencyInboundClosedCause | null;
    assignee_user_id: string | null;
    assignee_name?: string | null;
    handled_reason: AgencyInboundHandledReason | null;
    handled_at: string | null;
  } | null;
  /** The latest soft-phone call placed (dialled) from this call's Call back. */
  called_back: { call_id: string; at: string } | null;
}

/**
 * An ended inbound call filed under the campaign, in the attempt row's shape: NULL where an
 * inbound call has no such thing (an attempt number, a dial, a wrap-up allotment, a redial, an
 * automatic outcome, a reserved session).
 */
export interface CampaignInboundLogRow {
  source: 'inbound';
  id: string;
  campaign_id: string | null;
  /** The roster contact the caller matched, else null. */
  contact_id: string | null;
  attempt_number: null;
  /** The caller's number; null when withheld. */
  phone_e164: string | null;
  /** The number they rang. */
  caller_id: string;
  /** Who answered; null for a call that reached nobody. */
  agent_user_id: string | null;
  reserved_agent_id: null;
  state: 'ended';
  outcome: Exclude<AgencyInboundCallOutcome, 'rejected'>;
  disposition_code: string | null;
  auto_disposition_code: null;
  notes: string | null;
  callback_at: string | null;
  promise_date: string | null;
  promise_amount: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  webrtc_call_id: string | null;
  dialed_at: null;
  /** When we answered the call. */
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: null;
  redial_of_attempt_id: null;
  redial_number: null;
  dnc_overridden: false;
  hours_overridden: false;
  requires_disposition: boolean;
  settled_at: string | null;
  inbound: CampaignInboundFacts;
  /** When the call arrived (`arrived_at`): what the list orders it by. */
  created_at: string;
}

export type CampaignCallLogRow = CampaignDiallerLogRow | CampaignSoftphoneLogRow | CampaignInboundLogRow;

/**
 * How many rows of each source the filters match, across every page (the `type` filter and
 * the cursor not applied): the Call log's chips. `dialler` is every attempt the list would
 * show; `soft_phone` the tagged calls whose dial was sent (a row that never dialled is listed
 * and counted nowhere, SR2); `inbound` every inbound row listed; `all` the sum of the three;
 * `to_follow_up` the open Missed rows under the same filters without the dates.
 */
export type CampaignCallLogCounts = AgencyCallLogCounts;

/** The internal read's page: `counts` only with `?include_counts=1`. */
export interface CampaignCallLogPage {
  rows: CampaignCallLogRow[];
  next_cursor: string | null;
  limit: number;
  counts?: CampaignCallLogCounts;
}

// ─── The public JSON route's vocabulary ─────────────────────────────────────

export function isCallLogTypeFilter(value: unknown): value is AgencyCallLogTypeFilter {
  return typeof value === 'string' && (AGENCY_CALL_LOG_TYPE_FILTERS as readonly string[]).includes(value);
}

/** `?status=`: the soft-phone status filter (`softphoneStatusSql`). */
export function isCallLogStatus(value: unknown): value is AgencyCallLogStatus {
  return typeof value === 'string' && (AGENCY_CALL_LOG_STATUSES as readonly string[]).includes(value);
}

/** `?type=` → the internal read's `source`: `all` (or absent) is no source at all. */
export function callLogSourceForType(type: AgencyCallLogTypeFilter | undefined): CampaignCallLogSourceFilter | null {
  return type === undefined || type === 'all' ? null : type;
}

/** A call-log row with the agent's name beside the id, as the public layer's enrichment leaves it. */
export type NamedCampaignCallLogRow = CampaignCallLogRow & { agent_name?: string | null };

/**
 * The internal read's row → the contract's (`AgencyCallLogRow`): `source` becomes `type`, a
 * dialler row is otherwise the attempt row as it is, and a soft-phone row drops the attempt
 * columns it only ever filled with NULL (they exist for the export's columns).
 */
export function toCallLogWireRow(row: NamedCampaignCallLogRow): AgencyCallLogRow {
  if (row.source === 'dialler') {
    const { source: _source, ...attempt } = row;
    void _source;
    return { type: 'dialler', ...attempt };
  }
  if (row.source === 'inbound') return toInboundWireRow(row);
  return {
    type: 'soft_phone',
    id: row.id,
    campaign_id: row.campaign_id,
    contact_id: row.contact_id,
    phone_e164: row.phone_e164,
    caller_id: row.caller_id,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name ?? null,
    state: row.state,
    outcome: row.outcome,
    disposition_code: row.disposition_code,
    notes: row.notes,
    callback_at: row.callback_at,
    promise_date: row.promise_date,
    promise_amount: row.promise_amount,
    dispositioned_by_user_id: row.dispositioned_by_user_id,
    dispositioned_at: row.dispositioned_at,
    dispositioned_on_behalf: row.dispositioned_on_behalf,
    webrtc_call_id: row.webrtc_call_id,
    dialed_at: row.dialed_at,
    answered_at: row.answered_at,
    bridged_at: row.bridged_at,
    ended_at: row.ended_at,
    talk_seconds: row.talk_seconds,
    dnc_overridden: row.dnc_overridden,
    hours_overridden: row.hours_overridden,
    requires_disposition: row.requires_disposition,
    settled_at: row.settled_at,
    callback_of: row.callback_of ?? null,
    created_at: row.created_at,
  };
}

/** An inbound row of the internal read → the contract's: the facts under `inbound` lifted onto the row. */
export function toInboundWireRow(row: CampaignInboundLogRow & { agent_name?: string | null }): AgencyCallLogInboundRow {
  const facts = row.inbound;
  return {
    type: 'inbound',
    id: row.id,
    campaign_id: row.campaign_id,
    campaign_source: facts.campaign_source,
    contact_id: row.contact_id,
    phone_e164: row.phone_e164,
    caller_id: row.caller_id,
    route_name: facts.route_name,
    agent_user_id: row.agent_user_id,
    agent_name: row.agent_name ?? null,
    state: 'ended',
    outcome: row.outcome,
    disposition_code: row.disposition_code,
    notes: row.notes,
    callback_at: row.callback_at,
    promise_date: row.promise_date,
    promise_amount: row.promise_amount,
    dispositioned_by_user_id: row.dispositioned_by_user_id,
    dispositioned_at: row.dispositioned_at,
    dispositioned_on_behalf: row.dispositioned_on_behalf,
    webrtc_call_id: row.webrtc_call_id,
    answered_at: row.answered_at,
    bridged_at: row.bridged_at,
    ended_at: row.ended_at,
    talk_seconds: row.talk_seconds,
    wait_seconds: facts.wait_seconds,
    queued: facts.queued,
    via_sticky_agent: facts.via_sticky_agent,
    requires_disposition: row.requires_disposition,
    settled_at: row.settled_at,
    voicemail_seconds: facts.voicemail_seconds,
    follow_up: facts.follow_up
      ? { ...facts.follow_up, assignee_name: facts.follow_up.assignee_name ?? null }
      : null,
    called_back: facts.called_back,
    created_at: row.created_at,
  };
}

/**
 * Put the assignee's name on each inbound row's Missed row (`follow_up.assignee_name`): one
 * lookup for the page, the key always present, and a lookup that throws degrades to nulls
 * (`onError`), as the agent names do (`enrichAttemptAgentNames`).
 */
export async function nameCallLogAssignees<R extends CampaignCallLogRow>(
  rows: readonly R[],
  tenantId: string,
  resolveNames: (ids: readonly string[], tenantId: string) => Promise<Map<string, string | null>>,
  onError?: (err: unknown) => void,
): Promise<R[]> {
  const idOf = (row: CampaignCallLogRow) => (row.source === 'inbound' ? row.inbound?.follow_up?.assignee_user_id ?? null : null);
  const ids = [...new Set(rows.map(idOf).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  let names = new Map<string, string | null>();
  if (ids.length > 0) {
    try {
      names = await resolveNames(ids, tenantId);
    } catch (err) {
      onError?.(err);
    }
  }
  return rows.map((row) => {
    if (row.source !== 'inbound' || !row.inbound?.follow_up) return row;
    const id = row.inbound.follow_up.assignee_user_id;
    return {
      ...row,
      inbound: { ...row.inbound, follow_up: { ...row.inbound.follow_up, assignee_name: id ? names.get(id) ?? null : null } },
    };
  });
}

/**
 * The caller's path through an inbound call, in order, for its Call page: rang, our greeting
 * (when we answered), the wait (when they were queued or an agent answered), then an agent's
 * answer or the miss, a voicemail if one was left, and the end. Pure, from the row alone.
 */
export function inboundJourney(row: CampaignInboundLogRow): AgencyInboundJourneyStep[] {
  const facts = row.inbound;
  const steps: AgencyInboundJourneyStep[] = [{ kind: 'rang', at: row.created_at, seconds: null }];
  if (row.answered_at) steps.push({ kind: 'greeting', at: row.answered_at, seconds: null });
  if (row.bridged_at || facts.queued) steps.push({ kind: 'waited', at: null, seconds: facts.wait_seconds });
  if (row.bridged_at) steps.push({ kind: 'answered', at: row.bridged_at, seconds: null });
  else steps.push({ kind: 'missed', at: null, seconds: null });
  if (facts.voicemail_seconds !== null) steps.push({ kind: 'voicemail', at: null, seconds: facts.voicemail_seconds });
  steps.push({ kind: 'ended', at: row.ended_at, seconds: row.bridged_at ? row.talk_seconds : null });
  return steps;
}
