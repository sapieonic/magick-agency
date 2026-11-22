/**
 * The campaign Call log (`docs/call-log.md`, decisions CL1–CL12): one list of a campaign's
 * calls, whatever placed them, served by `GET /proxy/agency/campaigns/:id/call-log`
 * (`agency.supervise`).
 *
 * A call is a call. Its TYPE is a field on the row (`dialler`, `soft_phone`; `inbound` joins
 * them when inbound calls carry a campaign), and every row of every type shares the fields a
 * list column reads: `id`, `created_at`, `phone_e164`, `contact_id`, the agent, `outcome`,
 * the saved outcome code, `talk_seconds` and the media leg. What only one type has rides on
 * that type's row.
 *
 * The public API layer builds these rows from the dialer runtime's call-log read (the one the
 * campaign call export drains, decision SR6); there is no dialer-contract twin to keep in step
 * (`CONTRACT-DIFF.md` §4).
 */

import type { AgencyKeysetPage, AgencyManualCallOutcome, AgencyManualCallState } from '../../agency';
import type { AgencyAttempt, AgencyAttemptFilters } from './agency-spine';

/** What placed a call: the campaign's dialler, or an agent's soft phone. */
export type AgencyCallLogType = 'dialler' | 'soft_phone';

/** Every {@link AgencyCallLogType}, in chip order. */
export const AGENCY_CALL_LOG_TYPES = ['dialler', 'soft_phone'] as const satisfies readonly AgencyCallLogType[];

/** `?type=`: one type, or `all` (the default). */
export type AgencyCallLogTypeFilter = 'all' | AgencyCallLogType;

/** Every {@link AgencyCallLogTypeFilter}, in chip order. */
export const AGENCY_CALL_LOG_TYPE_FILTERS = ['all', 'dialler', 'soft_phone'] as const satisfies readonly AgencyCallLogTypeFilter[];

/**
 * The type in words: the Type column and the chips. The words Live calls uses for the same
 * three things (`AGENCY_CALL_ORIGIN_LABELS`).
 */
export const AGENCY_CALL_LOG_TYPE_LABELS: Readonly<Record<AgencyCallLogType, string>> = {
  dialler: 'Dialler',
  soft_phone: 'Soft phone',
};

/** A dialler row: the attempt list's own row (`AgencyAttempt`), marked with its type. */
export interface AgencyCallLogDiallerRow extends AgencyAttempt {
  type: 'dialler';
}

/**
 * A soft-phone call logged to the campaign. The fields a dialler row shares keep the dialler
 * row's names (`phone_e164` is the number dialled, `agent_user_id` who placed it); the rest
 * are the soft phone's own.
 */
export interface AgencyCallLogSoftphoneRow {
  type: 'soft_phone';
  /** The soft-phone call's id (`agency_manual_calls.id`): what its detail page is keyed on. */
  id: string;
  campaign_id: string;
  /** The roster contact the number matched, or null: the number is not on the campaign's list. */
  contact_id: string | null;
  /** E.164, as dialled. */
  phone_e164: string;
  caller_id: string;
  /** Who placed it (a soft-phone call always has an agent). */
  agent_user_id: string;
  /** Filled by the public API layer; null when the user row is gone. */
  agent_name: string | null;
  state: AgencyManualCallState;
  outcome: AgencyManualCallOutcome | null;
  /** The outcome the agent saved, a code of the campaign's catalog. */
  disposition_code: string | null;
  notes: string | null;
  callback_at: string | null;
  /** The call's own promise to pay (PT1): `YYYY-MM-DD` and a two-place decimal string. */
  promise_date: string | null;
  promise_amount: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  /** The media leg (`agency_calls.id`). No FK: not a promise the call row still exists. */
  webrtc_call_id: string | null;
  /** NULL: the dial was never sent (SR2). The row is listed, and is in no count. */
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  /** Whether a Do Not Call refusal (SP1) / a calling-hours refusal (SP2) was overridden to place it. */
  dnc_overridden: boolean;
  hours_overridden: boolean;
  /** Whether the call ended after it was answered and still waits for its outcome. */
  requires_disposition: boolean;
  /** Outcome saved, lapsed, or an unanswered call closed. NULL while live or awaiting an outcome. */
  settled_at: string | null;
  created_at: string;
}

/**
 * `?status=`: where a SOFT-PHONE call stands, the campaign's old Soft-phone calls view's Status
 * filter. `live`: not ended; `awaiting_outcome`: ended and not settled; `settled`: outcome
 * saved, lapsed, or closed with none owed. A dialler call has no such status, so with a status
 * chosen only soft-phone calls match, and the counts follow it like every other filter.
 */
export type AgencyCallLogStatus = 'live' | 'awaiting_outcome' | 'settled';

/** Every {@link AgencyCallLogStatus}, in the filter's order. */
export const AGENCY_CALL_LOG_STATUSES = ['live', 'awaiting_outcome', 'settled'] as const satisfies readonly AgencyCallLogStatus[];

/** One row of the Call log, discriminated by `type`. */
export type AgencyCallLogRow = AgencyCallLogDiallerRow | AgencyCallLogSoftphoneRow;

/**
 * How many calls of each type the chosen filters match (`status` among them), across every
 * page: the chips' numbers. The `type` filter is NOT applied (each chip says what choosing it would list), nor
 * is the cursor. `dialler` counts every attempt listed; `soft_phone` counts the calls whose
 * dial was sent (a row that never dialled is listed and not counted, SR2); `all` is their sum.
 */
export type AgencyCallLogCounts = { all: number } & Record<AgencyCallLogType, number>;

/** `GET /proxy/agency/campaigns/:id/call-log` query: the attempt list's filters, plus the type. */
export interface AgencyCallLogQuery extends AgencyAttemptFilters {
  type?: AgencyCallLogTypeFilter;
  /** Soft-phone calls in this status only; no dialler call matches. */
  status?: AgencyCallLogStatus;
}

/** `GET /proxy/agency/campaigns/:id/call-log`. `counts` only when asked for (`include_counts=1`). */
export interface AgencyCallLogPage extends AgencyKeysetPage<AgencyCallLogRow> {
  counts?: AgencyCallLogCounts;
}
