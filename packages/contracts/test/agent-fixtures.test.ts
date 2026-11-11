import { describe, expect, it } from 'vitest';
import type * as Core from '../src/agency';
import type { AgencyApi, PlatformApi } from '../src/index';
import type { AgencyClientFlagMap } from '../src/flags';
import { buildLiterals } from '../../../tooling/contracts-literals.mjs';
import actions from '../fixtures/agent/actions.json';
import customerHistory from '../fixtures/agent/customer-history.json';
import inbound from '../fixtures/agent/inbound.json';
import literals from '../fixtures/agent/literals.json';
import platform from '../fixtures/agent/platform.json';
import reads from '../fixtures/agent/reads.json';
import session from '../fixtures/agent/session.json';
import softphone from '../fixtures/agent/softphone.json';
import stationClient from '../fixtures/agent/station-client.json';
import station from '../fixtures/agent/station.json';

/**
 * The agent app's golden wire samples (`fixtures/agent/*.json`) against the contract.
 *
 * The mobile app is Dart, so it cannot compile against these types; its wire package
 * (`apps/mobile/packages/agency_wire`) decodes the same JSON files in its own suite. This
 * file is the TypeScript half: a contract change that a fixture no longer satisfies fails
 * `pnpm lint` here, and the fixture then has to be updated, which fails the Dart suite
 * until the Dart type follows.
 *
 * ── What the type check can and cannot see ──────────────────────────────────
 * A JSON import is typed with its literals WIDENED (`"ready"` is `string`), so a fixture
 * cannot be checked against a literal union directly. {@link fits} therefore checks the
 * fixture against the contract type with every literal union widened to its primitive
 * (`Widen`), plus a strict no-extra-keys rule (`Stray`), which together catch:
 *
 *   - a required field added to the contract and missing from the fixture;
 *   - a field removed or renamed in the contract and still present in the fixture
 *     (the error names the path, as `__stray_keys__: ".attempt.old_name"`);
 *   - a type or nullability change (`string` → `number`, `string | null` → `string`).
 *
 * The literal VALUES are covered elsewhere: `literals.json` is extracted from the sources
 * (and checked fresh below), the Dart suite fails on a literal its enums do not know, and
 * {@link LITERAL_FIELDS} checks the discriminants here at runtime.
 *
 * Type-level failures surface in `pnpm lint`; the runtime checks in `pnpm test`.
 */

// ── The type-level checks ────────────────────────────────────────────────────

/** `T` with every literal widened to its primitive, recursively. Optionality is kept. */
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null | undefined
        ? T
        : T extends readonly (infer E)[]
          ? Widen<E>[]
          : T extends object
            ? { [K in keyof T]: Widen<T[K]> }
            : T;

/** The object part of `T` (drops `null`, `undefined` and primitives from a union). */
type ObjectPart<T> = Extract<NonNullable<T>, object>;

/**
 * The paths of keys in the fixture `J` that the contract type `T` does not declare, as a
 * union of `".a.b"` strings; `never` when there are none. An index-signature object
 * (`Record<string, unknown>`) declares every key, and `unknown` ends the walk.
 */
type Stray<J, T, P extends string = ''> = unknown extends T
  ? never
  : J extends readonly (infer JE)[]
    ? ObjectPart<T> extends readonly (infer TE)[]
      ? Stray<JE, TE, `${P}[]`>
      : never
    : J extends object
      ? {
          [K in keyof J & string]: K extends keyof ObjectPart<T>
            ? Stray<J[K], ObjectPart<T>[K], `${P}.${K}`>
            : `${P}.${K}`;
        }[keyof J & string]
      : never;

/**
 * Checks one fixture against its contract type at compile time and returns it unchanged.
 * `fits<T>()(json)` fails `tsc` when `json` does not fit `Widen<T>` or has a stray key.
 */
function fits<T>() {
  return <J extends Widen<T>>(
    json: J & ([Stray<J, T>] extends [never] ? unknown : { __stray_keys__: Stray<J, T> }),
  ): J => json;
}

/** The request bodies the app sends: the server injects the actor fields itself. */
type AppBody<T> = Omit<T, keyof Core.AgencyActorFields>;

/** The body the invite-claim route sends on a 404/409 (`invites.routes.ts`). */
interface InviteClaimRefusalBody {
  error: string;
  message: string;
  status: PlatformApi.InviteUnavailableStatus | PlatformApi.InviteClaimRefusalStatus;
  email?: string;
}

// Customer history (docs/customer-history.md): the search, the timeline and their refusals.
/**
 * The search answer with its timeline's entries checked one by one below: a JSON array of mixed
 * entries is typed as a union of shapes, which the stray-key walk cannot match to the
 * contract's discriminated union as a whole.
 */
type CustomerSearchResponseShell = Omit<AgencyApi.CustomerSearchResponse, 'timeline'> & {
  timeline: { entries: unknown[]; next_cursor: string | null };
};

const CUSTOMER_HISTORY = {
  search_request: fits<AgencyApi.CustomerSearchRequest>()(customerHistory.search_request),
  search_response: fits<CustomerSearchResponseShell>()(customerHistory.search_response),
  // The answer's timeline entries, one sample per kind (the runtime test below holds them equal).
  entry_softphone_call: fits<AgencyApi.CustomerTimelineSoftphoneCall>()(customerHistory.entry_softphone_call),
  entry_callback: fits<AgencyApi.CustomerTimelineCallback>()(customerHistory.entry_callback),
  entry_campaign_call: fits<AgencyApi.CustomerTimelineCampaignCall>()(customerHistory.entry_campaign_call),
  entry_dnc_mark: fits<AgencyApi.CustomerTimelineDncMark>()(customerHistory.entry_dnc_mark),
  entry_roster_entry: fits<AgencyApi.CustomerTimelineRosterEntry>()(customerHistory.entry_roster_entry),
  search_response_empty: fits<AgencyApi.CustomerSearchResponse>()(customerHistory.search_response_empty),
  timeline_request: fits<AgencyApi.CustomerTimelineRequest>()(customerHistory.timeline_request),
  timeline_page_last: fits<AgencyApi.CustomerTimelinePage>()(customerHistory.timeline_page_last),
  error_invalid_number: fits<AgencyApi.CustomerHistoryErrorResponse>()(customerHistory.error_invalid_number),
  error_search_expired: fits<AgencyApi.CustomerHistoryErrorResponse>()(customerHistory.error_search_expired),
  options_response: fits<AgencyApi.CustomerSearchOptionsResponse>()(customerHistory.options_response),
};

// The station frames are the dialer runtime's own shapes (the proxy relays them unchanged).
const STATION = {
  ready_first_join: fits<Core.AgencyStationReadyFrame>()(station.ready_first_join),
  ready_reconnect_live: fits<Core.AgencyStationReadyFrame>()(station.ready_reconnect_live),
  ready_reconnect_wrapup: fits<Core.AgencyStationReadyFrame>()(station.ready_reconnect_wrapup),
  ready_missed_release: fits<Core.AgencyStationReadyFrame>()(station.ready_missed_release),
  ready_device_away: fits<Core.AgencyStationReadyFrame>()(station.ready_device_away),
  reserved: fits<Core.AgencyStationReservedFrame>()(station.reserved),
  reserved_redial: fits<Core.AgencyStationReservedFrame>()(station.reserved_redial),
  countdown: fits<Core.AgencyStationCountdownFrame>()(station.countdown),
  bridged: fits<Core.AgencyStationBridgedFrame>()(station.bridged),
  released_completed: fits<Core.AgencyStationReleasedFrame>()(station.released_completed),
  released_no_answer: fits<Core.AgencyStationReleasedFrame>()(station.released_no_answer),
  wrapup_timed: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_timed),
  wrapup_held_timerless: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_held_timerless),
  wrapup_redial_offered: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_redial_offered),
  wrapup_redial_used_up: fits<Core.AgencyStationWrapupFrame>()(station.wrapup_redial_used_up),
  agent_state_available: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_available),
  agent_state_break: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_break),
  agent_state_break_queued: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_break_queued),
  campaign_state_exhausted: fits<Core.AgencyStationCampaignStateFrame>()(station.campaign_state_exhausted),
  pong: fits<Core.AgencyStationPongFrame>()(station.pong),
  pong_without_ts: fits<Core.AgencyStationPongFrame>()(station.pong_without_ts),
  error: fits<Core.AgencyStationErrorFrame>()(station.error),
  bridge_status: fits<Core.AgencyStationBridgeStatusFrame>()(station.bridge_status),
  bridge_ended: fits<Core.AgencyStationBridgeEndedFrame>()(station.bridge_ended),
  media: fits<Core.AgencyStationMediaFrame>()(station.media),
  manual_call: fits<Core.AgencyStationManualCallFrame>()(station.manual_call),
  manual_call_owed: fits<Core.AgencyStationManualCallFrame>()(station.manual_call_owed),
  ready_softphone_session: fits<Core.AgencyStationReadyFrame>()(station.ready_softphone_session),
  agent_state_soft_phone: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_soft_phone),
  agent_state_switch_queued: fits<Core.AgencyStationAgentStateFrame>()(station.agent_state_switch_queued),
  queue_nothing_due: fits<Core.AgencyStationQueueFrame>()(station.queue_nothing_due),
  queue_due: fits<Core.AgencyStationQueueFrame>()(station.queue_due),
  // Inbound calls (docs/inbound.md §6): one call through its states, a withheld caller, the wait notice.
  inbound_call_offered: fits<Core.AgencyStationInboundCallFrame>()(station.inbound_call_offered),
  inbound_call_connected: fits<Core.AgencyStationInboundCallFrame>()(station.inbound_call_connected),
  inbound_call_outcome_owed: fits<Core.AgencyStationInboundCallFrame>()(station.inbound_call_outcome_owed),
  inbound_call_settled: fits<Core.AgencyStationInboundCallFrame>()(station.inbound_call_settled),
  inbound_call_withheld: fits<Core.AgencyStationInboundCallFrame>()(station.inbound_call_withheld),
  customer_waiting: fits<Core.AgencyStationCustomerWaitingFrame>()(station.customer_waiting),
  customer_waiting_cleared: fits<Core.AgencyStationCustomerWaitingFrame>()(station.customer_waiting_cleared),
};

const STATION_CLIENT = {
  ping: fits<Core.AgencyStationPingFrame>()(stationClient.ping),
  ping_without_ts: fits<Core.AgencyStationPingFrame>()(stationClient.ping_without_ts),
  media: fits<Core.AgencyStationMediaFrame>()(stationClient.media),
};

const SESSION = {
  create_session_request: fits<Omit<Core.AgencyCreateSessionRequest, 'agent_user_id'>>()(
    session.create_session_request,
  ),
  bootstrap_first_join: fits<Core.AgencySessionBootstrap>()(session.bootstrap_first_join),
  bootstrap_retry_rehydrated: fits<Core.AgencySessionBootstrap>()(session.bootstrap_retry_rehydrated),
  station_token: fits<Core.AgencyStationTokenResponse>()(session.station_token),
  break_request: fits<Core.AgencySessionBreakRequest>()(session.break_request),
  session_state_available: fits<Core.AgencySessionStateResponse>()(session.session_state_available),
  session_state_break_queued: fits<Core.AgencySessionStateResponse>()(session.session_state_break_queued),
  break_request_device_away: fits<Core.AgencySessionBreakRequest>()(session.break_request_device_away),
  session_state_device_away: fits<Core.AgencySessionStateResponse>()(session.session_state_device_away),
  session_state_left: fits<Core.AgencySessionStateResponse>()(session.session_state_left),
  conflict_other_campaign: fits<Core.AgencySessionCampaignConflict>()(session.conflict_other_campaign),
  conflict_softphone: fits<Core.AgencySoftphoneSessionOnSoftphoneRefusal>()(session.conflict_softphone),
};

const ACTIONS = {
  hangup_response: fits<Core.AgencyHangupResponse>()(actions.hangup_response),
  disposition_request_callback: fits<AppBody<Core.AgencyDispositionRequest>>()(actions.disposition_request_callback),
  disposition_request_plain: fits<AppBody<Core.AgencyDispositionRequest>>()(actions.disposition_request_plain),
  disposition_response_callback: fits<Core.AgencyDispositionResponse>()(actions.disposition_response_callback),
  disposition_response_completed: fits<Core.AgencyDispositionResponse>()(actions.disposition_response_completed),
  notes_request: fits<AppBody<Core.AgencyNotesRequest>>()(actions.notes_request),
  notes_response: fits<Core.AgencyNotesResponse>()(actions.notes_response),
  dnc_request: fits<AppBody<Core.AgencyDncRequest>>()(actions.dnc_request),
  dnc_response: fits<Core.AgencyDncResponse>()(actions.dnc_response),
  error_unknown_disposition_code: fits<Core.AgencyActionErrorResponse>()(actions.error_unknown_disposition_code),
  error_break_already_applied: fits<Core.AgencyActionErrorResponse>()(actions.error_break_already_applied),
  error_session_ended: fits<Core.AgencyActionErrorResponse>()(actions.error_session_ended),
  redial_request: fits<AppBody<Core.AgencyRedialRequest>>()(actions.redial_request),
  redial_response: fits<Core.AgencyRedialResponse>()(actions.redial_response),
  error_redial_limit_reached: fits<Core.AgencyActionErrorResponse>()(actions.error_redial_limit_reached),
  error_redial_blocked_dnc: fits<Core.AgencyActionErrorResponse>()(actions.error_redial_blocked_dnc),
  // Contact assignment: the agent's own-contact actions (public API layer shapes).
  agent_retry_request_selected: fits<AgencyApi.AgencyAgentRetryRequest>()(actions.agent_retry_request_selected),
  agent_retry_request_all: fits<AgencyApi.AgencyAgentRetryRequest>()(actions.agent_retry_request_all),
  agent_retry_response: fits<AgencyApi.AgencyAgentRetryResponse>()(actions.agent_retry_response),
  my_contact_call_request: fits<AgencyApi.AgencyMyContactCallRequest>()(actions.my_contact_call_request),
  my_contact_call_request_hours_override: fits<AgencyApi.AgencyMyContactCallRequest>()(
    actions.my_contact_call_request_hours_override,
  ),
  my_contact_call_response: fits<AgencyApi.AgencyMyContactCallResponse>()(actions.my_contact_call_response),
  error_contact_not_retryable: fits<AgencyApi.AgencyAgentRetryErrorResponse>()(actions.error_contact_not_retryable),
};

// The soft phone's routes (`/proxy/agency/softphone/*` and the SP7 switch). Bodies the
// app sends are the console's (`AgencyApi`, no actor fields); answers and refusals are
// the dialer contract's, which the public API layer passes through (the list and the
// detail are `AgencyApi` shapes: `agent_name` filled, `analysis_status`, the media leg).
const SOFTPHONE = {
  bootstrap_enabled: fits<Core.AgencySoftphoneBootstrap>()(softphone.bootstrap_enabled),
  bootstrap_finish_mode: fits<Core.AgencySoftphoneBootstrap>()(softphone.bootstrap_finish_mode),
  bootstrap_idle: fits<Core.AgencySoftphoneBootstrap>()(softphone.bootstrap_idle),
  session_response: fits<Core.AgencySoftphoneSessionResponse>()(softphone.session_response),
  call_create_request: fits<AgencyApi.AgencyManualCallCreateRequest>()(softphone.call_create_request),
  call_update_request: fits<AgencyApi.AgencyManualCallUpdateRequest>()(softphone.call_update_request),
  call_disposition_request: fits<AgencyApi.AgencyManualCallDispositionRequest>()(softphone.call_disposition_request),
  call_disposition_response: fits<Core.AgencyManualCallDispositionResponse>()(softphone.call_disposition_response),
  call_hangup_response: fits<Core.AgencyManualCall>()(softphone.call_hangup_response),
  call_dnc_request: fits<AgencyApi.AgencyManualCallDncRequest>()(softphone.call_dnc_request),
  call_dnc_response: fits<Core.AgencyManualCallDncResponse>()(softphone.call_dnc_response),
  calls_page: fits<AgencyApi.AgencyManualCallsPage>()(softphone.calls_page),
  call_detail_agent: fits<AgencyApi.AgencyManualCallDetail>()(softphone.call_detail_agent),
  session_state_switch_queued: fits<Core.AgencySessionStateResponse>()(softphone.session_state_switch_queued),
  refusal_dnc_listed: fits<Core.AgencySoftphoneDncListedRefusal>()(softphone.refusal_dnc_listed),
  refusal_outside_hours: fits<Core.AgencySoftphoneOutsideHoursRefusal>()(softphone.refusal_outside_hours),
  refusal_contact_in_flight: fits<Core.AgencySoftphoneContactInFlightRefusal>()(softphone.refusal_contact_in_flight),
  refusal_session_on_campaign: fits<Core.AgencySoftphoneSessionOnCampaignRefusal>()(
    softphone.refusal_session_on_campaign,
  ),
  refusal_outcome_pending: fits<Core.AgencySoftphoneCallPendingRefusal>()(softphone.refusal_outcome_pending),
  refusal_fields_invalid: fits<Core.AgencySoftphoneErrorResponse>()(softphone.refusal_fields_invalid),
  refusal_disposition_invalid: fits<Core.AgencySoftphoneDispositionInvalidRefusal>()(softphone.refusal_disposition_invalid),
  refusal_softphone_disabled: fits<Core.AgencySoftphoneErrorResponse>()(softphone.refusal_softphone_disabled),
  refusal_contact_assigned_elsewhere: fits<Core.AgencySoftphoneErrorResponse>()(
    softphone.refusal_contact_assigned_elsewhere,
  ),
};

// Inbound calls (`/proxy/agency/inbound/*`). Bodies the app sends are the console's (`AgencyApi`,
// no actor fields); the call routes' answers are the dialer contract's, which the public layer
// passes through; the Missed list, its count and the refusals are `AgencyApi` shapes.
const INBOUND = {
  call_response: fits<Core.AgencyInboundCallResponse>()(inbound.call_response),
  call_update_request: fits<AgencyApi.AgencyInboundCallUpdateRequest>()(inbound.call_update_request),
  call_hangup_response: fits<Core.AgencyInboundCallResponse>()(inbound.call_hangup_response),
  call_disposition_request: fits<AgencyApi.AgencyInboundCallDispositionRequest>()(inbound.call_disposition_request),
  call_disposition_response: fits<Core.AgencyInboundCallDispositionResponse>()(inbound.call_disposition_response),
  call_dnc_request: fits<AgencyApi.AgencyInboundCallDncRequest>()(inbound.call_dnc_request),
  call_dnc_response: fits<Core.AgencyInboundCallDncResponse>()(inbound.call_dnc_response),
  missed_page: fits<AgencyApi.AgencyInboundMissedPage>()(inbound.missed_page),
  missed_page_last: fits<AgencyApi.AgencyInboundMissedPage>()(inbound.missed_page_last),
  missed_handled_response: fits<AgencyApi.AgencyInboundMarkHandledResponse>()(inbound.missed_handled_response),
  missed_reopen_response: fits<AgencyApi.AgencyInboundReopenResponse>()(inbound.missed_reopen_response),
  missed_count: fits<AgencyApi.AgencyInboundMissedCountResponse>()(inbound.missed_count),
  missed_count_capped: fits<AgencyApi.AgencyInboundMissedCountResponse>()(inbound.missed_count_capped),
  missed_claim_response: fits<AgencyApi.AgencyInboundMissedClaimResponse>()(inbound.missed_claim_response),
  missed_count_since: fits<AgencyApi.AgencyInboundMissedCountResponse>()(inbound.missed_count_since),
  refusal_disposition_unknown_code: fits<AgencyApi.AgencyInboundErrorResponse>()(
    inbound.refusal_disposition_unknown_code,
  ),
  refusal_disposition_note_required: fits<AgencyApi.AgencyInboundErrorResponse>()(
    inbound.refusal_disposition_note_required,
  ),
  refusal_outcome_already_saved: fits<AgencyApi.AgencyInboundErrorResponse>()(inbound.refusal_outcome_already_saved),
  refusal_call_not_found: fits<AgencyApi.AgencyInboundErrorResponse>()(inbound.refusal_call_not_found),
  refusal_call_live: fits<AgencyApi.AgencyInboundCallLiveRefusal>()(inbound.refusal_call_live),
  refusal_inbound_disabled: fits<AgencyApi.AgencyInboundErrorResponse>()(inbound.refusal_inbound_disabled),
  refusal_missed_call_claimed: fits<AgencyApi.AgencyInboundErrorResponse>()(inbound.refusal_missed_call_claimed),
};

// The agent's reads are public-API-layer shapes, so they are checked against `AgencyApi`.
const READS = {
  my_assignments: fits<AgencyApi.AgencyMyAssignments>()(reads.my_assignments),
  my_assignments_empty: fits<AgencyApi.AgencyMyAssignments>()(reads.my_assignments_empty),
  my_campaigns: fits<AgencyApi.AgencyStaffingHistory>()(reads.my_campaigns),
  my_stats: fits<AgencyApi.AgencyAgentStats>()(reads.my_stats),
  my_stats_unmeasured: fits<AgencyApi.AgencyAgentStats>()(reads.my_stats_unmeasured),
  my_attempts: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyAttempt>>()(reads.my_attempts),
  my_attempts_last_page: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyAttempt>>()(reads.my_attempts_last_page),
  my_contacts_summary: fits<AgencyApi.AgencyMyContactsSummary>()(reads.my_contacts_summary),
  my_contacts: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyMyContact>>()(reads.my_contacts),
  my_contacts_last_page: fits<AgencyApi.AgencyKeysetPage<AgencyApi.AgencyMyContact>>()(reads.my_contacts_last_page),
};

const PLATFORM = {
  session_request: fits<PlatformApi.SessionRequest>()(platform.session_request),
  session_response: fits<PlatformApi.SessionResponse>()(platform.session_response),
  me_response: fits<PlatformApi.MeResponse>()(platform.me_response),
  session_refusal: fits<PlatformApi.SessionRefusal>()(platform.session_refusal),
  my_accounts: fits<PlatformApi.MyAccountsResponse>()(platform.my_accounts),
  invite_lookup_pending: fits<Extract<PlatformApi.InviteLookup, { status: 'pending' }>>()(
    platform.invite_lookup_pending,
  ),
  invite_lookup_expired: fits<Exclude<PlatformApi.InviteLookup, { status: 'pending' }>>()(
    platform.invite_lookup_expired,
  ),
  invite_claim_request: fits<{ id_token: string }>()(platform.invite_claim_request),
  invite_claim_refusal: fits<InviteClaimRefusalBody>()(platform.invite_claim_refusal),
  feature_flags: fits<AgencyClientFlagMap>()(platform.feature_flags),
  notification_preferences: fits<PlatformApi.NotificationPreferencesResponse>()(platform.notification_preferences),
  notification_update: fits<PlatformApi.NotificationPreferenceUpdate>()(platform.notification_update),
  error_generic: fits<{ error: string; code?: string; message: string }>()(platform.error_generic),
  client_config: fits<PlatformApi.ClientConfigResponse>()(platform.client_config),
  uplink_probe_response: fits<PlatformApi.UplinkProbeResponse>()(platform.uplink_probe_response),
  error_not_staffed: fits<Core.AgencyActionErrorResponse>()(platform.error_not_staffed),
};

// ── The runtime checks ───────────────────────────────────────────────────────

type Vocabulary = { source: string; values: string[] };
const vocab = (key: string): string[] => {
  const entry = (literals as unknown as Record<string, Vocabulary | undefined>)[key];
  if (!entry) throw new Error(`literals.json has no "${key}"`);
  return entry.values;
};

/**
 * The literal-typed fields of the fixtures, checked against the extracted vocabularies at
 * runtime because the JSON import cannot carry them to the type check. `path` is a dotted
 * path into one sample; a `null`/absent value is skipped (nullability is the type check's).
 */
const LITERAL_FIELDS: Array<[file: string, sample: string, path: string, vocabulary: string]> = [
  ...Object.keys(station).map((s): [string, string, string, string] => ['station', s, 'event', 'station_server_events']),
  ['station', 'ready_first_join', 'state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'pending_state', 'agent_states'],
  ['station', 'ready_reconnect_live', 'active_attempt.state', 'attempt_states'],
  ['station', 'ready_reconnect_live', 'active_attempt.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['station', 'ready_missed_release', 'missed_release.reason', 'release_reasons'],
  ['station', 'ready_device_away', 'state', 'agent_states'],
  ['station', 'ready_device_away', 'break_reason', 'reserved_break_codes'],
  ['station', 'reserved', 'attempt.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['station', 'released_completed', 'reason', 'release_reasons'],
  ['station', 'released_no_answer', 'reason', 'release_reasons'],
  ['station', 'wrapup_held_timerless', 'wrapup.held_reason', 'wrapup_hold_reasons'],
  ['station', 'agent_state_available', 'state', 'agent_states'],
  ['station', 'agent_state_break', 'state', 'agent_states'],
  ['station', 'agent_state_break_queued', 'pending_state', 'agent_states'],
  ['station', 'campaign_state_exhausted', 'status', 'campaign_statuses'],
  ['station', 'campaign_state_exhausted', 'reason', 'campaign_change_reasons'],
  ['station', 'error', 'code', 'station_error_codes'],
  ['station', 'bridge_status', 'status', 'bridge_statuses'],
  ['station', 'manual_call', 'call.state', 'attempt_states'],
  ['session', 'bootstrap_first_join', 'state', 'agent_states'],
  ['session', 'bootstrap_first_join', 'campaign_status', 'campaign_statuses'],
  ['session', 'bootstrap_retry_rehydrated', 'state', 'agent_states'],
  ['session', 'bootstrap_retry_rehydrated', 'break_reason', 'reserved_break_codes'],
  ['session', 'session_state_break_queued', 'kind', 'session_kinds'],
  ['session', 'session_state_break_queued', 'pending_state', 'agent_states'],
  ['session', 'session_state_device_away', 'state', 'agent_states'],
  ['session', 'session_state_device_away', 'break_reason', 'reserved_break_codes'],
  ['session', 'break_request_device_away', 'reason', 'reserved_break_codes'],
  ['platform', 'error_not_staffed', 'code', 'action_error_codes'],
  ['session', 'conflict_other_campaign', 'code', 'action_error_codes'],
  ['session', 'conflict_other_campaign', 'state', 'agent_states'],
  ['actions', 'hangup_response', 'state', 'attempt_states'],
  ['actions', 'disposition_response_callback', 'contact_state', 'contact_states'],
  ['actions', 'disposition_response_callback', 'agent_state', 'agent_states'],
  ['actions', 'dnc_request', 'scope', 'dnc_scopes'],
  ['actions', 'dnc_response', 'contact_state', 'contact_states'],
  ['actions', 'error_unknown_disposition_code', 'code', 'action_error_codes'],
  ['actions', 'error_break_already_applied', 'code', 'action_error_codes'],
  ['actions', 'error_session_ended', 'code', 'action_error_codes'],
  ['reads', 'my_attempts', 'rows.0.state', 'attempt_states'],
  ['reads', 'my_attempts', 'rows.0.outcome', 'attempt_outcomes'],
  ['reads', 'my_attempts', 'rows.1.outcome', 'attempt_outcomes'],
  ['platform', 'session_response', 'memberships.0.role', 'roles'],
  ['platform', 'invite_lookup_pending', 'invite.role', 'roles'],
  ['platform', 'invite_lookup_expired', 'status', 'invite_unavailable_statuses'],
  ['platform', 'invite_claim_refusal', 'status', 'invite_claim_refusal_statuses'],
  // The soft phone.
  ['station', 'ready_softphone_session', 'state', 'agent_states'],
  ['station', 'ready_softphone_session', 'break_reason', 'reserved_break_codes'],
  ['station', 'agent_state_soft_phone', 'state', 'agent_states'],
  ['station', 'agent_state_soft_phone', 'break_reason', 'reserved_break_codes'],
  ['station', 'agent_state_switch_queued', 'state', 'agent_states'],
  ['station', 'agent_state_switch_queued', 'pending_state', 'agent_states'],
  ['station', 'agent_state_switch_queued', 'pending_break_reason', 'reserved_break_codes'],
  ['station', 'manual_call', 'call.state', 'manual_call_states'],
  ['station', 'manual_call_owed', 'call.state', 'manual_call_states'],
  ['station', 'manual_call_owed', 'call.outcome', 'manual_call_outcomes'],
  ['station', 'manual_call_owed', 'call.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'bootstrap_enabled', 'session.kind', 'session_kinds'],
  ['softphone', 'bootstrap_enabled', 'session.state', 'agent_states'],
  ['softphone', 'bootstrap_enabled', 'session.break_reason', 'reserved_break_codes'],
  ['softphone', 'bootstrap_enabled', 'call.state', 'manual_call_states'],
  ['softphone', 'bootstrap_enabled', 'call.contact.state', 'contact_states'],
  ['softphone', 'bootstrap_enabled', 'call.contact.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['softphone', 'bootstrap_enabled', 'taggable_campaigns.0.status', 'campaign_statuses'],
  ['softphone', 'bootstrap_enabled', 'call_campaign.status', 'campaign_statuses'],
  ...[0, 1, 2, 3, 4].map((i): [string, string, string, string] => [
    'softphone', 'bootstrap_enabled', `call_fields.${i}.type`, 'call_field_types',
  ]),
  ['softphone', 'bootstrap_finish_mode', 'session.kind', 'session_kinds'],
  ['softphone', 'bootstrap_finish_mode', 'session.state', 'agent_states'],
  ['softphone', 'bootstrap_finish_mode', 'call.state', 'manual_call_states'],
  ['softphone', 'bootstrap_finish_mode', 'call.outcome', 'manual_call_outcomes'],
  ['softphone', 'bootstrap_finish_mode', 'call.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'bootstrap_finish_mode', 'call_fields.0.type', 'call_field_types'],
  ['softphone', 'bootstrap_idle', 'taggable_campaigns.0.status', 'campaign_statuses'],
  ['softphone', 'session_response', 'kind', 'session_kinds'],
  ['softphone', 'session_response', 'state', 'agent_states'],
  ['softphone', 'session_response', 'break_reason', 'reserved_break_codes'],
  ['softphone', 'call_disposition_response', 'call.state', 'manual_call_states'],
  ['softphone', 'call_disposition_response', 'call.outcome', 'manual_call_outcomes'],
  ['softphone', 'call_disposition_response', 'call.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'call_disposition_response', 'call.disposition_source', 'manual_call_disposition_sources'],
  ['softphone', 'call_disposition_response', 'contact_state', 'contact_states'],
  ['softphone', 'call_hangup_response', 'state', 'manual_call_states'],
  ['softphone', 'call_dnc_response', 'scope', 'dnc_entry_scopes'],
  ['softphone', 'call_dnc_response', 'contact_state', 'contact_states'],
  ['softphone', 'calls_page', 'rows.0.state', 'manual_call_states'],
  ['softphone', 'calls_page', 'rows.0.outcome', 'manual_call_outcomes'],
  ['softphone', 'calls_page', 'rows.0.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'calls_page', 'rows.0.disposition_source', 'manual_call_disposition_sources'],
  ['softphone', 'calls_page', 'rows.0.contact.state', 'contact_states'],
  ['softphone', 'calls_page', 'rows.1.outcome', 'manual_call_outcomes'],
  ['softphone', 'calls_page', 'rows.1.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'call_detail_agent', 'call.state', 'manual_call_states'],
  ['softphone', 'call_detail_agent', 'call.outcome', 'manual_call_outcomes'],
  ['softphone', 'call_detail_agent', 'call.end_reason', 'manual_call_end_reasons'],
  ['softphone', 'call_detail_agent', 'call.disposition_source', 'manual_call_disposition_sources'],
  ['softphone', 'call_detail_agent', 'call.contact.state', 'contact_states'],
  ['softphone', 'call_detail_agent', 'call.contact.prior_attempts.0.outcome', 'attempt_outcomes'],
  ['softphone', 'call_detail_agent', 'overrides.dnc_entry.scope', 'dnc_entry_scopes'],
  ['softphone', 'call_detail_agent', 'call_availability', 'call_availabilities'],
  // Contact assignment.
  ['station', 'queue_nothing_due', 'reason', 'queue_idle_reasons'],
  ['session', 'bootstrap_first_join', 'assignment_mode', 'assignment_modes'],
  ['session', 'bootstrap_first_join', 'queue.reason', 'queue_idle_reasons'],
  ['reads', 'my_contacts_summary', 'assignment_mode', 'assignment_modes'],
  ['reads', 'my_contacts_summary', 'queue.reason', 'queue_idle_reasons'],
  ['reads', 'my_contacts', 'rows.0.bucket', 'my_contact_buckets'],
  ['reads', 'my_contacts', 'rows.0.state', 'contact_states'],
  ['reads', 'my_contacts', 'rows.1.bucket', 'my_contact_buckets'],
  ['reads', 'my_contacts', 'rows.2.bucket', 'my_contact_buckets'],
  ['reads', 'my_contacts', 'rows.1.retry.blocked', 'agent_retry_blocks'],
  ['reads', 'my_contacts', 'rows.2.retry.blocked', 'agent_retry_blocks'],
  ['actions', 'agent_retry_response', 'skipped.0.blocked', 'agent_retry_blocks'],
  ['actions', 'my_contact_call_response', 'override_applied.0', 'override_kinds'],
  ['actions', 'error_contact_not_retryable', 'code', 'agent_retry_error_codes'],
  ['actions', 'error_contact_not_retryable', 'details.blocked', 'agent_retry_blocks'],
  ['softphone', 'refusal_contact_assigned_elsewhere', 'code', 'softphone_error_codes'],
  ['softphone', 'session_state_switch_queued', 'kind', 'session_kinds'],
  ['softphone', 'session_state_switch_queued', 'state', 'agent_states'],
  ['softphone', 'session_state_switch_queued', 'pending_state', 'agent_states'],
  ['softphone', 'session_state_switch_queued', 'break_reason', 'reserved_break_codes'],
  ['softphone', 'refusal_dnc_listed', 'entry.scope', 'dnc_entry_scopes'],
  ['softphone', 'refusal_outside_hours', 'timezone_source', 'hours_timezone_sources'],
  ['softphone', 'refusal_session_on_campaign', 'state', 'agent_states'],
  ['softphone', 'refusal_outcome_pending', 'call.state', 'manual_call_states'],
  // Customer history.
  ['customer-history', 'search_request', 'by', 'customer_search_bys'],
  ['customer-history', 'search_response', 'key.by', 'customer_search_bys'],
  ['customer-history', 'search_response', 'summary.contacts.0.state', 'contact_states'],
  ['customer-history', 'search_response', 'summary.contacts.1.state', 'contact_states'],
  ['customer-history', 'search_response', 'summary.contacts.0.campaign.status', 'campaign_statuses'],
  ['customer-history', 'search_response', 'summary.totals.last_contacted.channel', 'customer_timeline_channels'],
  ['customer-history', 'search_response', 'summary.totals.last_contacted.outcome', 'attempt_outcomes'],
  ['customer-history', 'search_response', 'summary.dnc.0.scope', 'dnc_entry_scopes'],
  ['customer-history', 'search_response', 'summary.open.live_calls.0.channel', 'customer_timeline_channels'],
  ['customer-history', 'search_response', 'summary.filter_options.outcomes.0', 'attempt_outcomes'],
  ...[0, 1, 2, 3, 4].map((i): [string, string, string, string] => [
    'customer-history', 'search_response', `timeline.entries.${i}.kind`, 'customer_timeline_kinds',
  ]),
  ['customer-history', 'search_response', 'timeline.entries.0.outcome', 'attempt_outcomes'],
  ['customer-history', 'search_response', 'timeline.entries.0.recording', 'customer_recording_states'],
  ['customer-history', 'search_response', 'timeline.entries.1.status', 'customer_callback_statuses'],
  ['customer-history', 'search_response', 'timeline.entries.1.source.channel', 'customer_timeline_channels'],
  ['customer-history', 'search_response', 'timeline.entries.2.recording', 'customer_recording_states'],
  ['customer-history', 'search_response', 'timeline.entries.2.override_applied.0', 'override_kinds'],
  ['customer-history', 'search_response', 'timeline.entries.3.entry.scope', 'dnc_entry_scopes'],
  ['customer-history', 'timeline_request', 'filters.channel', 'customer_timeline_channels'],
  ['customer-history', 'timeline_request', 'filters.outcomes.0', 'attempt_outcomes'],
  ['customer-history', 'error_invalid_number', 'code', 'customer_history_error_codes'],
  ['customer-history', 'error_invalid_number', 'number_error', 'customer_search_number_errors'],
  ['customer-history', 'error_search_expired', 'code', 'customer_history_error_codes'],
  // Inbound calls: the vocabularies they share with outbound (the inbound ones: INBOUND_LITERAL_FIELDS).
  ...['inbound_call_offered', 'inbound_call_connected', 'inbound_call_outcome_owed', 'inbound_call_settled']
    .flatMap((s): Array<[string, string, string, string]> => [
      ['station', s, 'call.match.contact_state', 'contact_states'],
      ['station', s, 'call.match.prior_attempts.0.outcome', 'attempt_outcomes'],
      ['station', s, 'call.match.prior_attempts.1.outcome', 'attempt_outcomes'],
    ]),
  ['inbound', 'call_disposition_response', 'contact_state', 'contact_states'],
  ['inbound', 'call_dnc_response', 'scope', 'dnc_entry_scopes'],
  ['inbound', 'call_dnc_response', 'contact_state', 'contact_states'],
  ...Object.keys(softphone)
    .filter((s) => s.startsWith('refusal_'))
    .map((s): [string, string, string, string] => ['softphone', s, 'code', 'softphone_error_codes']),
];

/**
 * The inbound literal fields, checked against the inbound vocabularies `literals.json` extracts
 * (the ones the app switches on). Same path and vocabulary rules as {@link LITERAL_FIELDS}.
 */
const INBOUND_CALL_SAMPLES = [
  'inbound_call_offered', 'inbound_call_connected', 'inbound_call_outcome_owed', 'inbound_call_settled',
  'inbound_call_withheld',
] as const;
const MISSED_ROWS: Array<[string, string]> = [
  ['missed_page', 'rows.0'], ['missed_page', 'rows.1'], ['missed_page', 'rows.2'], ['missed_page_last', 'rows.0'],
  ['missed_handled_response', 'call'], ['missed_reopen_response', 'call'], ['missed_claim_response', 'call'],
];
type InboundField = [file: string, sample: string, path: string, vocabulary: string];
const INBOUND_LITERAL_FIELDS: InboundField[] = [
  ...INBOUND_CALL_SAMPLES.flatMap((s): InboundField[] => [
    ['station', s, 'call.state', 'inbound_call_states'],
    ['station', s, 'call.outcome', 'inbound_call_outcomes'],
    ['station', s, 'call.catalog_source', 'inbound_catalog_sources'],
    ['station', s, 'call.sticky.reason', 'inbound_sticky_reasons'],
  ]),
  ...['call_response', 'call_hangup_response', 'call_disposition_response'].flatMap((s): InboundField[] => [
    ['inbound', s, 'call.state', 'inbound_call_states'],
    ['inbound', s, 'call.outcome', 'inbound_call_outcomes'],
    ['inbound', s, 'call.catalog_source', 'inbound_catalog_sources'],
    ['inbound', s, 'call.sticky.reason', 'inbound_sticky_reasons'],
  ]),
  ...MISSED_ROWS.flatMap(([s, row]): InboundField[] => [
    ['inbound', s, `${row}.reason`, 'inbound_missed_reasons'],
    ['inbound', s, `${row}.closed_cause`, 'inbound_closed_causes'],
    ['inbound', s, `${row}.outcome`, 'inbound_call_outcomes'],
    ['inbound', s, `${row}.status`, 'inbound_follow_up_statuses'],
    ['inbound', s, `${row}.handled_reason`, 'inbound_handled_reasons'],
  ]),
  ...Object.keys(inbound)
    .filter((s) => s.startsWith('refusal_'))
    .map((s): InboundField => ['inbound', s, 'code', 'inbound_error_codes']),
];

const FILES: Record<string, Record<string, unknown>> = {
  station, session, softphone, actions, reads, platform, 'customer-history': customerHistory, inbound,
};

function at(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v == null ? v : (v as Record<string, unknown>)[k]), value);
}

describe('agent fixtures (fixtures/agent/*.json)', () => {
  it('registers every sample of every file with a contract type', () => {
    const registered: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['station', station, STATION],
      ['station-client', stationClient, STATION_CLIENT],
      ['session', session, SESSION],
      ['softphone', softphone, SOFTPHONE],
      ['actions', actions, ACTIONS],
      ['reads', reads, READS],
      ['platform', platform, PLATFORM],
      ['customer-history', customerHistory, CUSTOMER_HISTORY],
      ['inbound', inbound, INBOUND],
    ];
    for (const [name, file, checked] of registered) {
      expect(Object.keys(checked).sort(), `${name}.json`).toEqual(Object.keys(file).sort());
    }
  });

  it('covers every station server event the contract declares', () => {
    // The inbound frames included: a station that declares the inbound capability (the app's
    // `caps=inbound`) is sent them, so the app decodes them like every other frame.
    const events = new Set(Object.values(station).map((frame) => frame.event));
    expect([...events].sort()).toEqual([...vocab('station_server_events')].sort());
  });

  it.each(LITERAL_FIELDS)('%s.%s: `%s` is a member of %s', (file, sample, path, vocabulary) => {
    const value = at(FILES[file]?.[sample], path);
    expect(value, `${file}.${sample} has no ${path}`).not.toBeUndefined();
    if (value !== null) expect(vocab(vocabulary)).toContain(value);
  });

  it.each(INBOUND_LITERAL_FIELDS)('%s.%s: `%s` is a member of %s', (file, sample, path, vocabulary) => {
    const value = at(FILES[file]?.[sample], path);
    expect(value, `${file}.${sample} has no ${path}`).not.toBeUndefined();
    if (value !== null) expect(vocab(vocabulary)).toContain(value);
  });

  it('inbound: one call through offered, connected, owed and settled, as the frames send it', () => {
    const calls = INBOUND_CALL_SAMPLES.slice(0, 4).map((s) => station[s].call);
    expect(new Set(calls.map((c) => c.id)).size).toBe(1);
    expect(calls.map((c) => c.state)).toEqual(['offered', 'connected', 'ended', 'ended']);
    expect(calls.map((c) => c.connects_at !== null)).toEqual([true, false, false, false]);
    expect(calls.map((c) => c.outcome_due_at !== null)).toEqual([false, false, true, false]);
    expect(calls.map((c) => c.settled_at !== null)).toEqual([false, false, false, true]);
    expect(station.inbound_call_withheld.call.from_e164).toBeNull();
    expect(inbound.call_hangup_response.call).toEqual(station.inbound_call_outcome_owed.call);
    expect(inbound.call_disposition_response.call).toEqual(station.inbound_call_settled.call);
  });

  it('customer history: the search answer\'s timeline is the five per-kind entry samples, in order', () => {
    expect(customerHistory.search_response.timeline.entries).toEqual([
      customerHistory.entry_softphone_call,
      customerHistory.entry_callback,
      customerHistory.entry_campaign_call,
      customerHistory.entry_dnc_mark,
      customerHistory.entry_roster_entry,
    ]);
  });

  it('keeps the client frames the server reads to ping and media', () => {
    expect(new Set(Object.values(STATION_CLIENT).map((f) => f.event))).toEqual(new Set(['ping', 'media']));
  });
});

describe('fixtures/agent/literals.json', () => {
  it('matches the vocabularies extracted from the sources (run `node tooling/contracts-literals.mjs`)', () => {
    expect(literals).toEqual(buildLiterals());
  });

  it('extracts the station close codes the console switches on', () => {
    expect(buildLiterals()['station_close_codes']).toMatchObject({
      values: {
        TOKEN_REJECTED: 4401,
        SESSION_GONE: 4404,
        HEARTBEAT_TIMEOUT: 4408,
        SUPERSEDED: 4409,
        INVALID_UPGRADE: 1008,
        INTERNAL_ERROR: 1011,
      },
    });
  });
});
