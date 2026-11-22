/**
 * The campaign Call log (`docs/call-log.md`, decisions CL1–CL12): one list of a campaign's
 * calls, whatever placed them, served by `GET /proxy/agency/campaigns/:id/call-log`
 * (`agency.supervise`).
 *
 * A call is a call. Its TYPE is a field on the row (`dialler`, `soft_phone`, `inbound`), and
 * every row of every type shares the fields a
 * list column reads: `id`, `created_at`, `phone_e164`, `contact_id`, the agent, `outcome`,
 * the saved outcome code, `talk_seconds` and the media leg. What only one type has rides on
 * that type's row.
 *
 * The public API layer builds these rows from the dialer runtime's call-log read (the one the
 * campaign call export drains, decision SR6); there is no dialer-contract twin to keep in step
 * (`CONTRACT-DIFF.md` §4).
 */

import type {
  AgencyInboundCallOutcome,
  AgencyInboundCampaignSource,
  AgencyInboundClosedCause,
  AgencyInboundFollowUpStatus,
  AgencyInboundHandledReason,
  AgencyInboundMissedReason,
  AgencyKeysetPage,
  AgencyManualCallOutcome,
  AgencyManualCallState,
} from '../../agency';
import type { AgencyAttempt, AgencyAttemptFilters } from './agency-spine';
import type { AgencyAttemptCallDetail } from './attempt-call';

/** What a call was: the campaign's dialler placed it, an agent's soft phone did, or the customer rang us. */
export type AgencyCallLogType = 'dialler' | 'soft_phone' | 'inbound';

/** Every {@link AgencyCallLogType}, in chip order. */
export const AGENCY_CALL_LOG_TYPES = ['dialler', 'soft_phone', 'inbound'] as const satisfies readonly AgencyCallLogType[];

/**
 * `?type=`: one type, `all` (the default), or `to_follow_up`: the campaign's OPEN Missed rows
 * (inbound calls that reached nobody and are still owed a call back). To follow up is a view of
 * the same list, not a fourth type: its rows are `inbound` rows.
 */
export type AgencyCallLogTypeFilter = 'all' | AgencyCallLogType | 'to_follow_up';

/** Every {@link AgencyCallLogTypeFilter}, in chip order. */
export const AGENCY_CALL_LOG_TYPE_FILTERS = [
  'all', 'dialler', 'soft_phone', 'inbound', 'to_follow_up',
] as const satisfies readonly AgencyCallLogTypeFilter[];

/**
 * What only an inbound call can have happened to it, as `?outcome=` values beside the attempt
 * list's (`connected`, `no_answer`, …): `missed`, the call reached no agent (every call with a
 * Missed row, whatever the reason); `voicemail`, the caller left one; `abandoned_in_queue`, the
 * caller hung up while waiting. `connected` on an inbound call is one an agent answered. No
 * dialler or soft-phone call matches one of these three, and no inbound call matches any other
 * attempt outcome.
 */
export type AgencyCallLogInboundOutcomeFilter = 'missed' | 'voicemail' | 'abandoned_in_queue';

/** Every {@link AgencyCallLogInboundOutcomeFilter}, in the filter's order. */
export const AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS = [
  'missed', 'voicemail', 'abandoned_in_queue',
] as const satisfies readonly AgencyCallLogInboundOutcomeFilter[];

/** {@link AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS} in words: the What happened filter's inbound choices. */
export const AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS: Readonly<Record<AgencyCallLogInboundOutcomeFilter, string>> = {
  missed: 'Missed',
  voicemail: 'Voicemail',
  // The dialler has its own "Abandoned (no agent free)": this one is the caller's doing.
  abandoned_in_queue: 'Abandoned (hung up while waiting)',
};

/**
 * The type in words: the Type column and the chips. The words Live calls uses for the same
 * three things (`AGENCY_CALL_ORIGIN_LABELS`).
 */
export const AGENCY_CALL_LOG_TYPE_LABELS: Readonly<Record<AgencyCallLogType, string>> = {
  dialler: 'Dialler',
  soft_phone: 'Soft phone',
  inbound: 'Inbound',
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
  /**
   * The Missed inbound call this call rang back (placed from its Call back, CL1), and when that
   * call arrived (null when its row is gone). Null: not a call back. The call stays a soft-phone
   * call; the pair point at each other ({@link AgencyCallLogInboundRow.called_back}).
   */
  callback_of: { inbound_call_id: string; arrived_at: string | null } | null;
  created_at: string;
}

/** The Missed row of an inbound call that reached nobody ({@link AgencyCallLogInboundRow.follow_up}). */
export interface AgencyCallLogFollowUp {
  status: AgencyInboundFollowUpStatus;
  reason: AgencyInboundMissedReason;
  /** With `reason` `closed`: why the caller was answered as closed. NULL otherwise. */
  closed_cause: AgencyInboundClosedCause | null;
  /** Who the row is assigned to; NULL: the account. */
  assignee_user_id: string | null;
  /** Filled by the public API layer; null for the account or a user row that is gone. */
  assignee_name: string | null;
  /** `marked` by a person or `reached` (the customer was spoken to afterwards). NULL while open. */
  handled_reason: AgencyInboundHandledReason | null;
  handled_at: string | null;
}

/**
 * An inbound call filed under the campaign: the customer rang us. Only ENDED calls are rows (a
 * live one is on Live calls), and never a `rejected` one (a call we did not serve). The fields
 * the other types share keep their names: `phone_e164` is the CALLER's number (null: withheld),
 * `caller_id` the number they rang, `agent_user_id` who answered, `created_at` when it arrived.
 */
export interface AgencyCallLogInboundRow {
  type: 'inbound';
  /** The inbound call's id (`agency_inbound_calls.id`): what its Call page is keyed on. */
  id: string;
  campaign_id: string;
  /** How the call came by this campaign: `contact`, its number is on the campaign's list. */
  campaign_source: AgencyInboundCampaignSource;
  /** The roster contact the caller's number matched, or null. */
  contact_id: string | null;
  /** The caller's number, E.164; null when withheld. */
  phone_e164: string | null;
  /** The number they rang. */
  caller_id: string;
  /** The inbound number's route, by name; null when it has gone. */
  route_name: string | null;
  /** Who answered; null for a call that reached nobody. */
  agent_user_id: string | null;
  agent_name: string | null;
  state: 'ended';
  outcome: Exclude<AgencyInboundCallOutcome, 'rejected'>;
  disposition_code: string | null;
  notes: string | null;
  callback_at: string | null;
  promise_date: string | null;
  promise_amount: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  /** The media leg (`agency_calls.id`). No FK. */
  webrtc_call_id: string | null;
  /** When we answered the call (the greeting began); `created_at` is when it arrived. */
  answered_at: string | null;
  /** When an agent was put through. */
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  /**
   * How long the caller was with us before an agent answered, or before the call ended when
   * nobody did: whole seconds from arrival, the greeting included. On a missed call that left a
   * voicemail it runs to the end of the call, the voicemail included: no column records when the
   * wait gave way to the voicemail prompt.
   */
  wait_seconds: number;
  /** Whether the caller was put in the queue (waited for an agent), rather than only played a message. */
  queued: boolean;
  /** The agent who answered is the caller's own (the sticky agent): "came through their agent". */
  via_sticky_agent: boolean;
  /** Whether the call was answered by an agent and still waits for its outcome. */
  requires_disposition: boolean;
  settled_at: string | null;
  /** The length of the voicemail the caller left; null: none (or it has aged out). */
  voicemail_seconds: number | null;
  /** The call's Missed row; null for an answered call. */
  follow_up: AgencyCallLogFollowUp | null;
  /**
   * The latest soft-phone call placed from this call's Call back, whatever campaign it was
   * logged to: "Called back 3:31 PM". Null: none.
   */
  called_back: { call_id: string; at: string } | null;
  /** When the call arrived. */
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
export type AgencyCallLogRow = AgencyCallLogDiallerRow | AgencyCallLogSoftphoneRow | AgencyCallLogInboundRow;

/**
 * How many calls of each type the chosen filters match (`status` among them), across every
 * page: the chips' numbers. The `type` filter is NOT applied (each chip says what choosing it would list), nor
 * is the cursor. `dialler` counts every attempt listed; `soft_phone` counts the calls whose
 * dial was sent (a row that never dialled is listed and not counted, SR2); `inbound` every
 * inbound row listed; `all` is the sum of the three. `to_follow_up` is the campaign's open
 * Missed rows under the same filters EXCEPT the dates: someone owed a call back yesterday is
 * still owed one today. They are inbound calls, so they are not added to `all` a second time.
 */
export type AgencyCallLogCounts = { all: number; to_follow_up: number } & Record<AgencyCallLogType, number>;

/**
 * `GET /proxy/agency/campaigns/:id/call-log` query: the attempt list's filters, plus the type.
 * `outcome` also takes the {@link AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS}. How each filter
 * reads on each type is in `docs/call-log.md` ("How a filter reads on each type"): one with no
 * meaning on a type leaves that type out.
 */
export interface AgencyCallLogQuery extends AgencyAttemptFilters {
  type?: AgencyCallLogTypeFilter;
  /** Soft-phone calls in this status only; no dialler or inbound call matches. */
  status?: AgencyCallLogStatus;
}

/** `GET /proxy/agency/campaigns/:id/call-log`. `counts` only when asked for (`include_counts=1`). */
export interface AgencyCallLogPage extends AgencyKeysetPage<AgencyCallLogRow> {
  counts?: AgencyCallLogCounts;
}

/** One step of an inbound call's path ({@link AgencyInboundCallLogDetail.journey}). */
export type AgencyInboundJourneyStepKind = 'rang' | 'greeting' | 'waited' | 'answered' | 'missed' | 'voicemail' | 'ended';

export interface AgencyInboundJourneyStep {
  kind: AgencyInboundJourneyStepKind;
  /** When the step began; null where no instant was recorded (the wait, a voicemail). */
  at: string | null;
  /** Its length in whole seconds, where it has one (`waited`, `voicemail`, `ended`: the talk time). */
  seconds: number | null;
}

/**
 * `GET /proxy/agency/campaigns/:id/call-log/inbound/:callId` (`agency.supervise`): one inbound
 * call of the campaign, for its Call page. `journey` is the caller's path in order. The media
 * leg is in the attempt detail's envelope: `call` with `call_availability` (`available`,
 * `purged`: past retention, `never_placed`: the call had no leg), its recording at
 * `…/call-log/inbound/:callId/recording` under the account's recording setting.
 */
export interface AgencyInboundCallLogDetail {
  inbound: AgencyCallLogInboundRow;
  journey: AgencyInboundJourneyStep[];
  /** Who saved the outcome, by name; null when nobody did or the user row is gone. */
  dispositioned_by_name: string | null;
  /** Where the voicemail plays from (`/inbound/missed/:id/voicemail`, relative to the proxy), when there is one. */
  voicemail_url: string | null;
  call: AgencyAttemptCallDetail['call'];
  call_availability: AgencyAttemptCallDetail['call_availability'];
  /** Who listened to the call live (docs/listening.md LS13); absent when nobody could have. */
  listen_sessions?: AgencyAttemptCallDetail['listen_sessions'];
}
