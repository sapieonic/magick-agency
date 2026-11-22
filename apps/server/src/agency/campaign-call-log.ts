/**
 * The campaign's call log as one list: its dialler attempts and the soft-phone calls tagged to
 * it, newest first on one keyset (decisions SR6, CL11; `docs/call-log.md`). Read through the
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
 * A LEAF module: types and constants. No fastify, no db.
 */
import type {
  AgencyAttemptRow,
  AgencyManualCallOutcome,
  AgencyManualCallState,
} from '@magick-agency/contracts/agency';
import {
  AGENCY_CALL_LOG_TYPE_FILTERS,
  type AgencyCallLogCounts,
  type AgencyCallLogRow,
  type AgencyCallLogTypeFilter,
} from '@magick-agency/contracts/api/agency/call-log';

/** Where a call-log row came from: the campaign's dialler, or an agent's soft phone. */
export type CampaignCallSource = 'dialler' | 'soft_phone';

/** Every {@link CampaignCallSource}, in the order a reader meets them. */
export const CAMPAIGN_CALL_SOURCES = ['dialler', 'soft_phone'] as const satisfies readonly CampaignCallSource[];

export function isCampaignCallSource(value: unknown): value is CampaignCallSource {
  return typeof value === 'string' && (CAMPAIGN_CALL_SOURCES as readonly string[]).includes(value);
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
  campaign_id: string;
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
  created_at: string;
}

export type CampaignCallLogRow = CampaignDiallerLogRow | CampaignSoftphoneLogRow;

/**
 * How many rows of each source the filters match, across every page (the `type` filter and
 * the cursor not applied): the Call log's chips. `dialler` is every attempt the list would
 * show; `soft_phone` the tagged calls whose dial was sent (a row that never dialled is listed
 * and counted nowhere, SR2); `all` their sum.
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

/** `?type=` → the internal read's `source`: `all` (or absent) is no source at all. */
export function callLogSourceForType(type: AgencyCallLogTypeFilter | undefined): CampaignCallSource | null {
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
    created_at: row.created_at,
  };
}
