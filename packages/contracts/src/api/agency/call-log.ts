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

/**
 * The rate each type has on a campaign's **Calls by type** table (Insights and the campaign
 * report; `docs/call-log.md` §6). Three different measures, so no "All calls" rate exists (CL7):
 * the dialler's connect rate measures the list and the pacing, the soft phone's the numbers
 * agents chose, and inbound's how many callers we answered.
 */
export const AGENCY_CALLS_BY_TYPE_RATE_LABELS: Readonly<Record<AgencyCallLogType, string>> = {
  dialler: 'Dialler connect rate',
  soft_phone: 'Soft-phone connect rate',
  inbound: 'Answer rate, open hours',
};

/** What the All calls column says in the Rate row. */
export const AGENCY_CALLS_BY_TYPE_NO_RATE = 'not added';

/**
 * The dialler's and the soft phone's calls together, as a rate: people reached over first
 * dials and soft-phone calls placed (SR3). Called "All calls connect rate" until inbound calls
 * joined the figures (CL7): an inbound call always connects from the customer's end, so it is
 * never in this or any other connect rate.
 */
export const AGENCY_OUTBOUND_CONNECT_RATE_LABEL = 'Outbound connect rate';

const CALLS_BY_TYPE_RATE_MEANS: Readonly<Record<AgencyCallLogType, string>> = {
  dialler: 'the dialler’s measures the list and the pacing',
  soft_phone: 'the soft phone’s the numbers agents chose',
  inbound: 'inbound’s how many callers we answered',
};

/**
 * The footnote under a Calls by type table, for the types it shows (the proposal's words; with
 * all three: "All calls adds the three types. Each call is counted once, under the type it was.
 * Rates are not added together: the dialler's measures the list and the pacing, the soft phone's
 * the numbers agents chose, and inbound's how many callers we answered.").
 */
export function agencyCallsByTypeFootnote(types: readonly AgencyCallLogType[]): string {
  const shown = AGENCY_CALL_LOG_TYPES.filter((t) => types.includes(t));
  const means = shown.map((t) => CALLS_BY_TYPE_RATE_MEANS[t]);
  const list = means.length > 1 ? `${means.slice(0, -1).join(', ')}${means.length > 2 ? ',' : ''} and ${means[means.length - 1]}` : means[0] ?? '';
  const howMany = shown.length === 3 ? 'three' : shown.length === 2 ? 'two' : '';
  return `All calls adds the ${howMany ? `${howMany} ` : ''}types. Each call is counted once, under the type it was. Rates are not added together: ${list}.`;
}

/**
 * The words for an outcome code no campaign's list can hold, where a table of outcomes would
 * otherwise print the raw code. `no_disposition` is what the server stamps on a call whose
 * outcome window ran out with none saved; it is not "no outcome written" (a call closed with no
 * code at all), so it has its own row and its own words, Compare agents' "No outcome chosen".
 */
export const AGENCY_SYSTEM_OUTCOME_LABELS: Readonly<Record<string, string>> = {
  no_disposition: 'No outcome chosen',
};

/** A dialler row: the attempt list's own row (`AgencyAttempt`), marked with its type. */
export interface AgencyCallLogDiallerRow extends AgencyAttempt {
  type: 'dialler';
  /** The campaign's name, on the account's All calls only ({@link AgencyAccountCallsPage}). */
  campaign_name?: string | null;
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
  /**
   * The campaign the call was logged to. Never null on a campaign's Call log; null on the
   * account's All calls for a call logged to no campaign.
   */
  campaign_id: string | null;
  /** The campaign's name, on the account's All calls only ({@link AgencyAccountCallsPage}). */
  campaign_name?: string | null;
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
  /**
   * The campaign the call is filed under. Never null on a campaign's Call log; null on the
   * account's All calls for a call filed under none (and then `campaign_source` is null too).
   */
  campaign_id: string | null;
  /** The campaign's name, on the account's All calls only ({@link AgencyAccountCallsPage}). */
  campaign_name?: string | null;
  /** How the call came by this campaign: `contact`, its number is on the campaign's list. */
  campaign_source: AgencyInboundCampaignSource | null;
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

// ─── The account's All calls and the agent's My calls (docs/call-log.md §7, CL31–CL38) ────────

/**
 * `?campaign_id=` on All calls and My calls: a campaign's id, or this word for the calls filed
 * under no campaign (a soft-phone call logged to none, an inbound call from a number on no list
 * whose route files unknown callers nowhere). A dialler call always has a campaign, so with
 * `none` no dialler call matches.
 */
export const AGENCY_CALLS_NO_CAMPAIGN = 'none';

/** What a list of calls says in its Campaign column for a call filed under no campaign (CL10). */
export const AGENCY_CALLS_NO_CAMPAIGN_LABEL = 'No campaign';

/**
 * The same, for a call older than the account's switch-on of "Every call must belong to a
 * campaign" (`require_campaign_since`): it was allowed when it was made, and is never given a
 * campaign afterwards (CL10).
 */
export const AGENCY_CALLS_BEFORE_THE_RULE_LABEL = 'Before the rule';

/**
 * `GET /proxy/agency/calls` query (`agency.supervise`): the campaign Call log's
 * ({@link AgencyCallLogQuery}), at the account's scope, plus the campaign.
 */
export interface AgencyAccountCallsQuery extends AgencyCallLogQuery {
  /** A campaign's id, or {@link AGENCY_CALLS_NO_CAMPAIGN}. */
  campaign_id?: string;
}

/** A row of the account's All calls: the Call log's row, with its campaign named. */
export type AgencyAccountCallRow = AgencyCallLogRow;

/**
 * `GET /proxy/agency/calls` (`agency.supervise`): every call of the account, of the three
 * types, newest first on one keyset. `to_follow_up` is the account's open Missed rows. `rule`
 * is the account's "Every call must belong to a campaign" setting, for the Campaign column's
 * {@link AGENCY_CALLS_BEFORE_THE_RULE_LABEL}.
 */
export interface AgencyAccountCallsPage extends AgencyKeysetPage<AgencyAccountCallRow> {
  counts?: AgencyCallLogCounts;
  rule: { require_campaign: boolean; require_campaign_since: string | null };
}

/** Which label a call filed under no campaign carries in the Campaign column (CL10). */
export function agencyNoCampaignLabel(
  createdAt: string,
  rule: { require_campaign: boolean; require_campaign_since: string | null } | null | undefined,
): string {
  if (!rule?.require_campaign || !rule.require_campaign_since) return AGENCY_CALLS_NO_CAMPAIGN_LABEL;
  const since = Date.parse(rule.require_campaign_since);
  const at = Date.parse(createdAt);
  return Number.isFinite(since) && Number.isFinite(at) && at < since
    ? AGENCY_CALLS_BEFORE_THE_RULE_LABEL
    : AGENCY_CALLS_NO_CAMPAIGN_LABEL;
}

/**
 * `?type=` on My calls, in chip order: To follow up first (CL9), then All and the three types.
 * The same values as {@link AGENCY_CALL_LOG_TYPE_FILTERS}.
 */
export const AGENCY_MY_CALLS_TYPE_FILTERS = [
  'to_follow_up', 'all', 'dialler', 'soft_phone', 'inbound',
] as const satisfies readonly AgencyCallLogTypeFilter[];

/** The chips' words on My calls and All calls. */
export const AGENCY_CALLS_TYPE_FILTER_LABELS: Readonly<Record<AgencyCallLogTypeFilter, string>> = {
  to_follow_up: 'To follow up',
  all: 'All',
  dialler: 'Dialler',
  soft_phone: 'Soft phone',
  inbound: 'Inbound',
};

/** What My calls says under To follow up when the agent owes nobody a call. */
export const AGENCY_MY_CALLS_NOTHING_TO_FOLLOW_UP = 'Nobody is waiting for a call from you.';

/** The Missed part of an inbound row on My calls ({@link AgencyMyCallRow.follow_up}). */
export interface AgencyMyCallFollowUp {
  status: AgencyInboundFollowUpStatus;
  reason: AgencyInboundMissedReason;
  closed_cause: AgencyInboundClosedCause | null;
  /** `marked` by a person or `reached` (the customer was spoken to afterwards). NULL while open. */
  handled_reason: AgencyInboundHandledReason | null;
}

/**
 * One call on the agent's own My calls (`GET /proxy/agency/my-calls`). One shape for the three
 * types, with what only one type has null on the others. It carries NO media: no leg id, no
 * recording, no summary (an agent does not hear recordings, their own included).
 *
 * **The number is as this agent may see it.** `phone` is the customer's number in full (E.164)
 * when the call's campaign shows numbers in full or the call has no campaign, and the masked
 * text (`98••• ••210`, the domain's `maskFactPhone`) when the campaign hides them
 * (`phone_display: 'masked'`, AS9); `phone_masked` says which. The server masks: a hidden
 * number is never sent on this route, on any type of row.
 */
export interface AgencyMyCallRow {
  type: AgencyCallLogType;
  /** The attempt's, the soft-phone call's or the inbound call's id. */
  id: string;
  /** When the call began: the dial's row for a dialler or soft-phone call, the arrival for an inbound one. */
  created_at: string;
  campaign_id: string | null;
  /** Null: no campaign, or its row is gone. */
  campaign_name: string | null;
  contact_id: string | null;
  /** The roster contact's name by the station card's rule (AS19 S1); null: none, or no contact. */
  customer_name: string | null;
  /** See the interface note. Null: the caller withheld their number. */
  phone: string | null;
  phone_masked: boolean;
  /** The call's own state (`ended` on every inbound row). */
  state: string;
  /** What happened, in the type's own vocabulary; null while the call is on or before it has one. */
  outcome: string | null;
  disposition_code: string | null;
  /** The saved outcome in the campaign's own words; null when its list no longer has the code, or there is no campaign. */
  disposition_label: string | null;
  /** Dialler: the campaign's automatic outcome for an unanswered call. */
  auto_disposition_code: string | null;
  callback_at: string | null;
  promise_date: string | null;
  promise_amount: string | null;
  talk_seconds: number | null;
  /** The agent's own notes on the call. */
  notes: string | null;
  /** Dialler: "Try 2". Null on the other types. */
  attempt_number: number | null;
  /** Dialler: a wrap-up redial. */
  redial: boolean;
  /** Dialler and soft phone: when the dial was sent; null: it never was (SR2), and on inbound. */
  dialed_at: string | null;
  /** Soft phone and inbound: the call was answered and still waits for its outcome. */
  requires_disposition: boolean;
  /** Soft phone: the Missed inbound call it rang back (CL1). */
  callback_of: { inbound_call_id: string; arrived_at: string | null } | null;
  /** Inbound: how long the caller waited, whole seconds. Null on the other types. */
  wait_seconds: number | null;
  /** Inbound: the caller was put in the queue. */
  queued: boolean;
  /** Inbound: the voicemail's length; null: none. */
  voicemail_seconds: number | null;
  /** Inbound: its Missed row; null for an answered call and on the other types. */
  follow_up: AgencyMyCallFollowUp | null;
  /** Inbound: the latest soft-phone call dialled from its Call back. */
  called_back: { call_id: string; at: string } | null;
}

/**
 * A callback the agent booked that is due today or already late (To follow up's second part):
 * My day's call-later rule (`AgencyMyCallLaterRow`), across the campaigns the agent is on.
 */
export interface AgencyMyCallbackDue {
  contact_id: string;
  campaign_id: string;
  campaign_name: string | null;
  customer_name: string | null;
  due_at: string;
  /** Due before now. */
  overdue: boolean;
}

/**
 * What the agent still owes, for the To follow up chip's badge: `to_follow_up` is their open
 * Missed rows PLUS the callbacks due today or late; `missed_open` the Missed rows alone (the
 * Missed calls badge's own count, capped as that badge is); `callbacks_due` the callbacks. The
 * other chips carry no number on My calls.
 */
export interface AgencyMyCallsCounts {
  to_follow_up: number;
  missed_open: number;
  callbacks_due: number;
}

/**
 * `GET /proxy/agency/my-calls` query (`agency.station.connect`). The subject is the session's
 * user: nothing here can name another agent.
 */
export interface AgencyMyCallsQuery {
  type?: AgencyCallLogTypeFilter;
  /** A campaign's id, or {@link AGENCY_CALLS_NO_CAMPAIGN}. */
  campaign_id?: string;
  /** Inclusive, ISO-8601, on when the call began. Not applied to To follow up (CL14). */
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
  /** `1`: add `counts`. */
  include_counts?: string;
}

/**
 * `GET /proxy/agency/my-calls`: the agent's own calls of the three types (inbound: the calls
 * they answered, and their open Missed rows), newest first on one keyset. With
 * `type=to_follow_up` the rows are the agent's open Missed rows and `callbacks_due` (first page
 * only) the callbacks they booked that are due today or late, soonest due first.
 */
export interface AgencyMyCallsPage extends AgencyKeysetPage<AgencyMyCallRow> {
  counts?: AgencyMyCallsCounts;
  callbacks_due?: AgencyMyCallbackDue[];
}

/**
 * When a callback is due, in the words To follow up uses: "Due 4:00 PM" for one still to come
 * today, "Late by 2 hours" (or "Late by 20 minutes", "Late by 3 days") for one that has passed.
 * `time` is the due time already formatted for the reader ("4:00 PM").
 */
export function agencyCallbackDueLabel(dueAt: string, now: Date, time: string): string {
  const lateMs = now.getTime() - Date.parse(dueAt);
  if (!Number.isFinite(lateMs) || lateMs <= 0) return `Due ${time}`;
  const minutes = Math.floor(lateMs / 60_000);
  if (minutes < 1) return 'Late by less than a minute';
  if (minutes < 60) return `Late by ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Late by ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const days = Math.floor(hours / 24);
  return `Late by ${days} ${days === 1 ? 'day' : 'days'}`;
}
