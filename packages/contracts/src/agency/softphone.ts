/**
 * The soft phone: an agent types a number and calls it from the browser, outside
 * campaign pacing (`docs/softphone.md`, rulings SP1–SP7, Manas 2026-10-30).
 *
 * Declares the session kind, the manual-call row and its vocabularies, the call
 * fields, the soft-phone settings, the station frame, and the request, response
 * and refusal bodies of every route in `docs/softphone.md` §6. The refusal union
 * `AgencySoftphoneErrorCode` is declared in `../errors.ts` with its runtime list,
 * like the action union, and re-exported by the barrel.
 *
 * Request types are the INTERNAL handler bodies (`/api/v1/agency/softphone/*`), so
 * they carry the actor fields the public API layer fills from the authenticated
 * session (`agent_user_id`, `on_behalf`); the console's bodies are the same
 * without them (`../api/agency/softphone.ts`).
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencySoftphoneErrorCode } from '../errors';
import type { AllListed } from '../primitives';
import type { AgencyActorFields } from './actions';
import type {
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyCampaignStatus,
  AgencyContactState,
} from './enums';
import type { AgencyContextDisplay, AgencyDisposition, AgencyStationIntervals } from './session';
import type { AgencyKeysetPage } from './spine';
import type { AgencyPriorAttempt, AgencyReleaseReason } from './station';

// ─── The break, and the session kind ────────────────────────────────────────

/**
 * The reserved break reason of an agent who is on the soft phone.
 *
 * **The soft phone is a break** (`docs/softphone.md` §2). Pacing reserves only
 * `available` agents, so an agent on the soft phone can never be reserved for a
 * campaign call, by construction, and occupancy reports soft-phone time as one
 * more break reason with no new agent state. A campaign's `break_reasons` never
 * lists it: it is entered only through the soft-phone routes, and
 * `POST /sessions/:id/break` refuses it as `unknown_break_reason`.
 */
export const SOFTPHONE_BREAK_REASON = 'soft_phone' as const;

/** How the console and occupancy reports label {@link SOFTPHONE_BREAK_REASON}. */
export const SOFTPHONE_BREAK_REASON_LABEL = 'Soft phone';

/**
 * `agency_agent_sessions.kind`.
 *
 * - `campaign`: a session on one campaign (`campaign_id` set). It can switch to
 *   the soft phone and back (SP7, §4.2) without leaving the campaign.
 * - `softphone`: opened by an agent who is on no campaign. `campaign_id` is NULL,
 *   it is created in `break/soft_phone` and it can never become `available`, so
 *   nothing campaign-scoped (pacing, staffing counts, the supervisor's per-campaign
 *   floor) ever sees it.
 *
 * Both kinds count against `uq_agency_agent_live_tenant`: one live session per
 * agent per tenant, one pair of ears.
 */
export type AgencySessionKind = 'campaign' | 'softphone';

export const AGENCY_SESSION_KINDS = [
  'campaign',
  'softphone',
] as const satisfies readonly AgencySessionKind[];

const _allSessionKindsListed: AllListed<AgencySessionKind, typeof AGENCY_SESSION_KINDS> = true;
void _allSessionKindsListed;

// ─── Limits ─────────────────────────────────────────────────────────────────

/**
 * Bounds of a DNC or calling-hours override note (SP1, SP2), in characters after
 * trimming. Long enough that "ok" cannot pass as a reason, short enough to sit on
 * an audit row. `agency_manual_calls` CHECKs the same bounds.
 */
export const SOFTPHONE_OVERRIDE_NOTE_MIN = 10;
export const SOFTPHONE_OVERRIDE_NOTE_MAX = 500;

/**
 * The campaign statuses a soft-phone call may be logged to: a campaign that is live
 * (`running`) or will be again (`paused`). A draft has not started, and a stopping,
 * stopped or completed campaign is over, so a call logged to one would settle roster
 * contacts nobody is working. A call already logged keeps its tag whatever the
 * campaign does next; only the choice at dial is limited.
 */
export const SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES = [
  'running',
  'paused',
] as const satisfies readonly AgencyCampaignStatus[];

/** At most this many call fields per account (`agency_softphone_settings.call_fields`). */
export const SOFTPHONE_CALL_FIELDS_MAX = 20;

/** A call field's `key`: snake_case, starting with a letter, at most 50 characters. */
export const SOFTPHONE_CALL_FIELD_KEY_MAX = 50;
export const SOFTPHONE_CALL_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Keys a call field may not take: every name a plain object answers through
 * `Object.prototype` (`constructor`, `__proto__`, `toString`, …) and `prototype`. A
 * field keyed `constructor` reads as filled on an empty value object
 * (`{}.constructor` is a function), so a required one would never be enforced, and
 * the values travel as a plain object end to end. `PUT /settings` refuses them
 * (`settings_invalid` on `call_fields[i].key`); under the key pattern only
 * `constructor` and `prototype` can be typed, the rest are listed for completeness.
 */
export const SOFTPHONE_CALL_FIELD_RESERVED_KEYS: ReadonlySet<string> = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]);

/**
 * How long an ended call may wait for its outcome before the reaper closes it
 * `no_disposition` and releases its contact claim (§4.1 step 8). Until then the
 * agent cannot dial again from that session: one unsettled call per session.
 */
export const SOFTPHONE_OUTCOME_LAPSE_MS = 30 * 60_000;

// ─── The manual call's vocabularies ─────────────────────────────────────────

/**
 * `agency_manual_calls.state`: the attempt lifecycle, the same six states in the
 * same order (`ended` is the single terminal state). An alias rather than a copy,
 * so the station's and the soft phone's state rails cannot disagree about a word.
 */
export type AgencyManualCallState = AgencyAttemptState;

export const AGENCY_MANUAL_CALL_STATES = [
  'queued',
  'dialing',
  'ringing',
  'answered',
  'bridged',
  'ended',
] as const satisfies readonly AgencyManualCallState[];

const _allManualCallStatesListed: AllListed<AgencyManualCallState, typeof AGENCY_MANUAL_CALL_STATES> = true;
void _allManualCallStatesListed;

/**
 * How a manual call finished, classified from carrier events by the same
 * classifier as an attempt, so it is the attempt vocabulary unchanged.
 *
 * Two members are close to unreachable and kept anyway: `abandoned` (the agent
 * leg is up before the customer is dialled, so an answer finds the agent unless
 * their socket died in the same instant) and `machine` (no AMD). Narrowing the
 * union would make `agency_manual_calls`' outcome CHECK refuse a value the shared
 * classifier can return, and fail a call's terminal write over a label.
 */
export type AgencyManualCallOutcome = AgencyAttemptOutcome;

export const AGENCY_MANUAL_CALL_OUTCOMES = [
  'connected',
  'no_answer',
  'busy',
  'failed',
  'machine',
  'invalid',
  'abandoned',
  'agent_disconnected',
  'orphaned',
  'canceled',
] as const satisfies readonly AgencyManualCallOutcome[];

const _allManualCallOutcomesListed: AllListed<AgencyManualCallOutcome, typeof AGENCY_MANUAL_CALL_OUTCOMES> = true;
void _allManualCallOutcomesListed;

/**
 * Why a manual call ended (`agency_manual_calls.end_reason`): the members of the
 * station's release vocabulary a manual call can reach, so the console reuses its
 * per-reason copy. The campaign-lifecycle reasons (`campaign_paused`,
 * `campaign_stopped`, `reservation_expired`) cannot happen to a call outside
 * pacing.
 */
export type AgencyManualCallEndReason = Extract<
  AgencyReleaseReason,
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'invalid'
  | 'agent_disconnected'
  | 'agent_hangup'
  | 'remote_hangup'
  | 'supervisor_released'
  | 'orphaned'
>;

export const AGENCY_MANUAL_CALL_END_REASONS = [
  'completed',
  'no_answer',
  'busy',
  'failed',
  'invalid',
  'agent_disconnected',
  'agent_hangup',
  'remote_hangup',
  'supervisor_released',
  'orphaned',
] as const satisfies readonly AgencyManualCallEndReason[];

const _allManualCallEndReasonsListed: AllListed<AgencyManualCallEndReason, typeof AGENCY_MANUAL_CALL_END_REASONS> = true;
void _allManualCallEndReasonsListed;

/**
 * Which catalog an outcome was resolved against: the tagged campaign's
 * `disposition_catalog`, or the soft phone's own (settings, else the built-in
 * `AGENCY_DEFAULT_DISPOSITION_CATALOG`) for an untagged call. Stored because the
 * campaign's catalog can change after the call, and a code is only readable
 * against the catalog it came from.
 */
export type AgencyManualCallDispositionSource = 'campaign' | 'softphone';

export const AGENCY_MANUAL_CALL_DISPOSITION_SOURCES = [
  'campaign',
  'softphone',
] as const satisfies readonly AgencyManualCallDispositionSource[];

const _allDispositionSourcesListed: AllListed<
  AgencyManualCallDispositionSource,
  typeof AGENCY_MANUAL_CALL_DISPOSITION_SOURCES
> = true;
void _allDispositionSourcesListed;

// ─── Call fields ────────────────────────────────────────────────────────────

/** The value types a call field may declare. */
export type AgencyCallFieldType = 'text' | 'number' | 'choice' | 'boolean' | 'date';

export const AGENCY_CALL_FIELD_TYPES = [
  'text',
  'number',
  'choice',
  'boolean',
  'date',
] as const satisfies readonly AgencyCallFieldType[];

const _allCallFieldTypesListed: AllListed<AgencyCallFieldType, typeof AGENCY_CALL_FIELD_TYPES> = true;
void _allCallFieldTypesListed;

/**
 * One call detail the agent fills in on every soft-phone call
 * (`agency_softphone_settings.call_fields`, at most {@link SOFTPHONE_CALL_FIELDS_MAX}).
 * The set is per account, not per campaign (§8).
 */
export interface AgencyCallField {
  /** Unique in the set; matches {@link SOFTPHONE_CALL_FIELD_KEY_PATTERN}. The value's key on the call. */
  key: string;
  label: string;
  type: AgencyCallFieldType;
  /** `choice` only, and required there: the allowed values, distinct. */
  options?: string[];
  /** The outcome cannot be saved while a required field is empty. Live edits may leave it empty. */
  required?: boolean;
}

/**
 * A call's field values, keyed by {@link AgencyCallField.key}. `text` and `choice`
 * are strings (a `choice` one of the field's `options`), `number` a finite number,
 * `boolean` a boolean, `date` an ISO calendar date (`YYYY-MM-DD`). `null` or an
 * absent key is empty.
 *
 * Validated against the field set in force when the values are saved, not when
 * the call started: an unknown key, or a value of the wrong type, is refused
 * `fields_invalid`, never dropped.
 */
export type AgencyCallFieldValues = Record<string, string | number | boolean | null>;

// ─── Soft-phone settings ────────────────────────────────────────────────────

/**
 * `agency_softphone_settings`, one row per (tenant, account). Every field has a
 * default and an account with no row reads as all defaults. Used for UNTAGGED
 * calls; `call_fields` apply to every call, tagged or not.
 */
export interface AgencySoftphoneSettings {
  /** `[]` means the built-in `AGENCY_DEFAULT_DISPOSITION_CATALOG`, not "no outcomes". */
  disposition_catalog: AgencyDisposition[];
  /** `[]` means no call fields. */
  call_fields: AgencyCallField[];
  /** NULL: the account's default analysis profile (the analysis hook's fallback). */
  analysis_profile_id: string | null;
  /** Record untagged calls; still gated by the account's `allow_recording` in the bridge. */
  record_calls: boolean;
  /** Pre-selected caller ID for untagged calls; must be one of the account's assigned numbers. */
  default_caller_id: string | null;
  /** ISO-8601; NULL when the account has no row yet. */
  updated_at: string | null;
}

/** `PUT /settings`: replaces the whole row. `agency.softphone.manage`. */
export type AgencySoftphoneSettingsUpdateRequest = Omit<AgencySoftphoneSettings, 'updated_at'>;

/** `GET /settings` and `PUT /settings`. */
export interface AgencySoftphoneSettingsResponse {
  settings: AgencySoftphoneSettings;
}

// ─── The manual call, on the wire ───────────────────────────────────────────

/** The campaign a call is logged to: chosen before Call and fixed for the call (§2). */
export interface AgencyManualCallTag {
  campaign_id: string;
  campaign_name: string;
}

/**
 * The roster contact the dialled number matched on the tagged campaign (SP6, §5).
 *
 * `context` and `prior_attempts` ride on the live call only (the `manual_call`
 * frame, the `POST /calls` answer, bootstrap) and on the detail, NEVER on a list
 * row: the spine's privacy rule that a contact's CSV columns appear only on a
 * drill-down (`./spine.ts`, decision 1) holds here too.
 */
export interface AgencyManualCallContact {
  contact_id: string;
  /** The contact's state now, not at dial. */
  state: AgencyContactState;
  /**
   * Whether this call claimed the contact (`pending → in_flight`), so its outcome
   * settles the roster row. False when the contact was linked only (§5).
   */
  claimed: boolean;
  /** Render with the tag's `context_display`; untrusted display text. Live call and detail only. */
  context?: Record<string, unknown>;
  /** Earlier dials of this contact, newest first. Live call and detail only. */
  prior_attempts?: AgencyPriorAttempt[];
}

/**
 * One soft-phone dial (`agency_manual_calls`), as the console renders a live or
 * past call. The `manual_call` station frame carries it whole on every state
 * change, so the console replaces its copy rather than patching it.
 */
export interface AgencyManualCall {
  id: string;
  session_id: string;
  /** The agent who placed it (the public API layer's user id). */
  agent_user_id: string;
  /**
   * Joined from `users` by the public API layer on the list, the detail and
   * bootstrap; NULL there only when the user row is gone. The station frame and
   * the call routes' answers go to the agent who placed the call and carry NULL.
   */
  agent_name: string | null;
  /** E.164, as dialled. */
  destination_e164: string;
  caller_id: string;
  /** NULL for an untagged call. */
  tag: AgencyManualCallTag | null;
  /** NULL when untagged or when the number is not on the tag's roster. */
  contact: AgencyManualCallContact | null;
  state: AgencyManualCallState;
  /** NULL until classified. */
  outcome: AgencyManualCallOutcome | null;
  /** NULL until `ended`. */
  end_reason: AgencyManualCallEndReason | null;
  /** Whether recording was asked for at dial (the account's `allow_recording` still applies). */
  recording_requested: boolean;
  /** Whether a DNC refusal (SP1) / a calling-hours refusal (SP2) was overridden to place it. */
  dnc_overridden: boolean;
  hours_overridden: boolean;
  /**
   * Whether the call waits for an outcome before the session can dial again: it
   * ended after it was answered and is not settled. The console keeps the outcome
   * pad up while this is true.
   */
  requires_disposition: boolean;
  /**
   * ISO-8601: when an awaited outcome lapses (`ended_at` +
   * {@link SOFTPHONE_OUTCOME_LAPSE_MS}); NULL when no outcome is awaited.
   */
  outcome_due_at: string | null;
  disposition_code: string | null;
  disposition_source: AgencyManualCallDispositionSource | null;
  notes: string | null;
  /** ISO-8601; a callback asked for in the outcome. */
  callback_at: string | null;
  fields: AgencyCallFieldValues;
  /** Who saved the outcome, which is not always who took the call. */
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  /** The media leg (`agency_calls.id`). No FK: not a promise the call row still exists. */
  webrtc_call_id: string | null;
  // ISO-8601 timestamps.
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  /** Outcome saved, lapsed, or an unanswered call closed. NULL while live or awaiting an outcome. */
  settled_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The override notes of a call, for the supervisor's detail. The row carries
 * only whether each override was used; the note text is the agent's reason and
 * belongs on the drill-down and the audit trail.
 */
export interface AgencyManualCallOverrides {
  dnc_note: string | null;
  /** The `dnc_entries.id` the DNC override was for. */
  dnc_entry_id: string | null;
  /**
   * That entry as the `dnc_listed` refusal showed it — how far it reaches, why, since
   * when — plus its campaign (`campaign` scope). NULL when no DNC override was used, or
   * the entry has since been removed from the list (`dnc_entry_id` still names it).
   */
  dnc_entry: (AgencySoftphoneDncListedRefusal['entry'] & { campaign_id: string | null }) | null;
  hours_note: string | null;
}

/**
 * Every state change of a manual call on this session (§4.1 step 5), and once
 * more after a station reconnect reattaches a live call (step 9). The payload is
 * the whole row; the console replaces its copy.
 *
 * Unlike a campaign attempt there is no separate `reserved` / `bridged` /
 * `released` sequence: `state` is the authority, and `bridged_at` non-null is the
 * instant audio is live both ways.
 */
export interface AgencyStationManualCallFrame {
  event: 'manual_call';
  call: AgencyManualCall;
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────

/** A calling window as the pre-dial gate evaluates it. `start`/`end` are `HH:MM` or `HH:MM:SS`. */
export interface AgencyCallingWindow {
  start: string;
  end: string;
  /** ISO-8601 day numbers, 1=Mon … 7=Sun. */
  days: number[];
  /** IANA zone. */
  timezone: string;
}

/** An analysis profile by id and name, for "this call will be summarised with …". */
export interface AgencySoftphoneProfileSummary {
  id: string;
  name: string;
}

/**
 * A campaign the caller may log a call to, in {@link SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES}:
 * for an agent, the campaigns they are actively staffed on; for an `agency.supervise`
 * holder, every such campaign in the account. Everything the tagged call uses, so
 * choosing a tag needs no second request. Bootstrap's `call_campaign` has the same
 * shape for the campaign the caller's call is already logged to.
 */
export interface AgencySoftphoneCampaign {
  campaign_id: string;
  campaign_name: string;
  status: AgencyCampaignStatus;
  caller_ids: string[];
  disposition_catalog: AgencyDisposition[];
  /** In the campaign's default timezone; a roster match is evaluated in the contact's (SP2). */
  calling_window: AgencyCallingWindow;
  /** Advisory, at bootstrap time, in the default timezone: whether a dial would pass the window gate. */
  calling_window_open: boolean;
  record_calls: boolean;
  /** NULL: the account default applies. */
  analysis_profile: AgencySoftphoneProfileSummary | null;
  /** How to render a matched contact's `context`. */
  context_display: AgencyContextDisplay;
}

/** What an untagged call dials with and is dispositioned against. */
export interface AgencySoftphoneUntagged {
  /** The account's assigned numbers (`findAvailableForAccount`). */
  caller_ids: string[];
  default_caller_id: string | null;
  /** Resolved: settings' catalog, else the built-in one. Never empty. */
  disposition_catalog: AgencyDisposition[];
  record_calls: boolean;
  analysis_profile: AgencySoftphoneProfileSummary | null;
}

/** The caller's live session as the soft phone sees it. */
export interface AgencySoftphoneSessionSummary {
  session_id: string;
  /**
   * The account the session is in. The live session is the agent's one in the TENANT
   * (`uq_agency_agent_live_tenant`), so it may be in a sibling account of the one the
   * bootstrap was read for: then `call` is not read, and the session routes (`leave`,
   * scoped to the session's account) must be sent with this account, not the caller's.
   */
  account_id: string;
  kind: AgencySessionKind;
  /** NULL for a `softphone` session. */
  campaign_id: string | null;
  campaign_name: string | null;
  state: AgencyAgentState;
  break_reason: string | null;
  /** `state = break` with `break_reason = soft_phone`: the session can dial. */
  on_softphone: boolean;
  /** A switch to the soft phone queued behind a call or wrap-up (§4.2). */
  pending_state?: AgencyAgentState;
  pending_break_reason?: string;
}

/** `GET /bootstrap`. */
export interface AgencySoftphoneBootstrap {
  /**
   * `agency_softphone_enabled` for the caller's tenant and account, read by the public
   * API layer. Bootstrap answers while it is off, as do the routes that FINISH work
   * already started (hang up, details, outcome, Mark DNC, the call reads, the return
   * to the campaign, and `POST /sessions` rehydrating an existing soft-phone session;
   * docs/softphone.md §6), so an agent the flag was switched off under can finish their
   * call: with `false` the console offers only that. Starting work (open a new session,
   * dial, switch) is refused `softphone_disabled`.
   */
  softphone_enabled: boolean;
  taggable_campaigns: AgencySoftphoneCampaign[];
  untagged: AgencySoftphoneUntagged;
  /** Applies to every call, tagged or not. */
  call_fields: AgencyCallField[];
  /** Country code a number typed without one is read in (the account's country, else `+91`). */
  default_country_code: string;
  /** NULL when the caller holds no live session in this tenant. */
  session: AgencySoftphoneSessionSummary | null;
  /** The session's live call, or its ended call still awaiting an outcome; NULL otherwise. */
  call: AgencyManualCall | null;
  /**
   * The campaign `call` is logged to, described as a taggable campaign is, whether or
   * not it can still be chosen as a tag (paused since, completed or stopped, the agent
   * unstaffed): its `disposition_catalog` is the one the call's outcome is saved
   * against. NULL when there is no call, it is untagged, or the campaign is gone.
   */
  call_campaign: AgencySoftphoneCampaign | null;
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/** `POST /sessions`: open a soft-phone session. The body is only the server-filled actor. */
export interface AgencySoftphoneCreateSessionRequest {
  /** Filled by the public API layer from the authenticated session, never by the browser. */
  agent_user_id: string;
}

/**
 * `POST /sessions` answer (201, or 200 when the caller's live soft-phone session
 * is rehydrated). The station socket fields mean what they mean on the campaign
 * bootstrap; the token is re-minted through `POST /sessions/:id/station-token`.
 */
export interface AgencySoftphoneSessionResponse {
  session_id: string;
  kind: 'softphone';
  /** Always `break`, with {@link SOFTPHONE_BREAK_REASON}. */
  state: AgencyAgentState;
  break_reason: string;
  station_ws_url: string;
  /** ISO-8601. Single-use and short; see `AgencySessionBootstrap.station_token_expires_at`. */
  station_token_expires_at: string;
  intervals: AgencyStationIntervals;
}

/**
 * `POST /proxy/agency/sessions/:id/softphone` and `/softphone/return` (SP7, §4.2).
 * No body. Both answer `AgencySessionStateResponse`; a switch asked for while the
 * agent is reserved, on a call or in wrap-up comes back with
 * `pending_state: 'break'` and `break_reason: 'soft_phone'`, and the console
 * switches on the `agent_state` frame that applies it.
 */
export type AgencySoftphoneSwitchRequest = Record<string, never>;

// ─── Calls ──────────────────────────────────────────────────────────────────

/**
 * The agent's reasons for dialling through a refusal: `dnc_note` overrides
 * `dnc_listed` (SP1), `hours_note` overrides `outside_calling_hours` (SP2). Each
 * {@link SOFTPHONE_OVERRIDE_NOTE_MIN}–{@link SOFTPHONE_OVERRIDE_NOTE_MAX} characters
 * after trimming, else `override_note_invalid`. A note is used only when its
 * refusal would otherwise fire; `dnc_unavailable` and `contact_in_flight` have no
 * override.
 */
export interface AgencyManualCallOverridesRequest {
  dnc_note?: string;
  hours_note?: string;
}

/** `POST /calls` → 201 {@link AgencyManualCall}. */
export interface AgencyManualCallCreateRequest extends Pick<AgencyActorFields, 'agent_user_id'> {
  /** The caller's live session, on the soft phone (`break/soft_phone`). */
  session_id: string;
  /** As typed; normalised to E.164 in the account's default region. */
  to: string;
  /** Absent: the tag's first caller ID, else the settings' default, else the first assigned number. */
  caller_id?: string;
  /** The tag. Absent or NULL: untagged. */
  campaign_id?: string | null;
  fields?: AgencyCallFieldValues;
  overrides?: AgencyManualCallOverridesRequest;
}

/**
 * `PATCH /calls/:id` while the call is live or awaiting an outcome. `fields`
 * replaces the stored values wholesale and `notes` replaces the notes (empty
 * string clears them), last write wins, so an autosave needs no merge. Does not
 * save an outcome. Answers the row.
 */
export interface AgencyManualCallUpdateRequest extends AgencyActorFields {
  fields?: AgencyCallFieldValues;
  notes?: string;
}

/**
 * `POST /calls/:id/hangup`. Answers the row as read right after the hangup was
 * issued, which may still be live: the `manual_call` frame is the authority for
 * "the call is over" (the same rule as `AgencyHangupResponse`). Hanging up a ringing
 * call cannot stop the customer's phone ringing on VoiceLink (SP3); the console
 * says so.
 */
export type AgencyManualCallHangupRequest = AgencyActorFields;

/**
 * `POST /calls/:id/disposition`: save the outcome. `agency.supervise` may act on
 * behalf (`on_behalf`). Accepted once the call has ended and is not settled; the
 * same `code` again is an idempotent 200 with notes and callback last-write-wins,
 * a different code on a settled call is `call_settled`. Suppress codes write DNC
 * in the same transaction (B8), then the contact settles (§5).
 */
export interface AgencyManualCallDispositionRequest extends AgencyActorFields {
  /** A code of the catalog the call resolves against (`disposition_source`). */
  code: string;
  notes?: string;
  /** ISO-8601. Required when the catalog entry sets `requires_datetime`. */
  callback_at?: string;
  /** Saved with the outcome, replacing the stored values; required fields must be filled. */
  fields?: AgencyCallFieldValues;
}

export interface AgencyManualCallDispositionResponse {
  call: AgencyManualCall;
  /** Where the outcome left the matched contact; NULL when there is none. */
  contact_state: AgencyContactState | null;
  /** ISO-8601: when the dialer will call the contact again (window-adjusted), or NULL. */
  next_attempt_at: string | null;
  /** ISO-8601: the `callback_at` asked for, echoed; NULL when none. */
  callback_requested_at: string | null;
}

/**
 * `POST /calls/:id/dnc`: mark the dialled number Do Not Call. Campaign scope when
 * the call is tagged, else the call's ACCOUNT (§6); the client never asserts the
 * scope. Never tenant-wide: that escalation is the station's, behind
 * `agency.dnc.manage`.
 */
export interface AgencyManualCallDncRequest extends AgencyActorFields {
  reason?: string;
}

/** How far a soft-phone DNC mark reaches: the tagged campaign, or (untagged) the call's account. */
export type AgencyManualCallDncScope = Extract<AgencyDncEntryScope, 'campaign' | 'account'>;

export interface AgencyManualCallDncResponse {
  call_id: string;
  phone_e164: string;
  scope: AgencyManualCallDncScope;
  /** False when the `dnc_entries` write is still in flight; the roster row is suppressed either way. */
  dnc_recorded: boolean;
  /** The matched contact's state after the mark (`suppressed`), or NULL when there is none. */
  contact_state: AgencyContactState | null;
}

// `GET /calls/:id` answers `AgencyManualCallDetail`, a console wire type
// (`../api/agency/softphone.ts`) because it carries the media leg's record.

/**
 * `GET /calls` query. An agent sees their own calls; `agency.supervise` sees the
 * whole account and may filter by agent. Keyset on `(created_at DESC, id DESC)`.
 */
export interface AgencyManualCallListQuery {
  /** Opaque, from the previous page's `next_cursor`. */
  cursor?: string;
  limit?: number;
  /** `agency.supervise` only; an agent's own id otherwise. */
  agent_user_id?: string;
  /** A campaign id, or `untagged` for calls logged to none. */
  campaign_id?: string;
  /** `live`: not ended; `awaiting_outcome`: ended, unsettled; `settled`. */
  status?: 'live' | 'awaiting_outcome' | 'settled';
  outcome?: AgencyManualCallOutcome;
  disposition_code?: string;
  /** Digits matched against `destination_e164`. */
  phone?: string;
  /** The roster contact the call matched (claimed or linked): the contact detail's soft-phone calls. */
  contact_id?: string;
  /** ISO-8601 bounds on `created_at`, inclusive start, exclusive end. */
  from?: string;
  to?: string;
}

/** `GET /calls`. Rows carry no contact `context` or `prior_attempts`. */
export type AgencyManualCallsPage = AgencyKeysetPage<AgencyManualCall>;

// ─── Refusals ───────────────────────────────────────────────────────────────

/**
 * The body of every 4xx/5xx a soft-phone route answers with a soft-phone code,
 * and of the two soft-phone refusals the campaign session routes raise
 * (`wrong_session_kind`, `manual_call_live`). The same `error` + `code` +
 * `message` convention as `AgencyActionErrorResponse`, so the proxy passes it
 * through unchanged; `message` is the floor a client that does not know the code
 * can show.
 */
export interface AgencySoftphoneErrorResponse {
  error: string;
  code: AgencySoftphoneErrorCode;
  message: string;
  /** `disposition_invalid`: the codes the call's catalog accepts. `caller_id_not_allowed`: the allowed caller IDs. */
  allowed_codes?: string[];
  /** `fields_invalid`, `settings_invalid`: one entry per offending path. */
  details?: Array<{ path: string; message: string }>;
}

/** How far a DNC entry reaches (decision B8): the whole tenant, one account, or one campaign. */
export type AgencyDncEntryScope = 'tenant' | 'account' | 'campaign';

/**
 * 409 `dnc_listed` (SP1): the number is on the DNC list for this tenant, account
 * or the tagged campaign. Redial with `overrides.dnc_note` to place it anyway.
 */
export interface AgencySoftphoneDncListedRefusal extends AgencySoftphoneErrorResponse {
  code: 'dnc_listed';
  entry: {
    id: string;
    scope: AgencyDncEntryScope;
    reason: string | null;
    /** ISO-8601. */
    created_at: string;
  };
}

/**
 * 409 `outside_calling_hours` (SP2): the tagged campaign's window is closed for
 * this number, in the contact's timezone when the number is on the roster, else
 * the campaign default. Redial with `overrides.hours_note` to place it anyway.
 */
export interface AgencySoftphoneOutsideHoursRefusal extends AgencySoftphoneErrorResponse {
  code: 'outside_calling_hours';
  window: AgencyCallingWindow;
  timezone_source: 'contact' | 'campaign_default';
  /** ISO-8601: when the window next opens; NULL when it never does (no calling days). */
  next_open_at: string | null;
}

/** 409 `contact_in_flight`: a campaign attempt is live on the matched contact. No override. */
export interface AgencySoftphoneContactInFlightRefusal extends AgencySoftphoneErrorResponse {
  code: 'contact_in_flight';
  campaign_id: string;
  contact_id: string;
}

/**
 * 409 `session_on_campaign` from `POST /sessions`: the agent is live on a
 * campaign. The remedy is the switch on that session (§4.2), not a second session.
 */
export interface AgencySoftphoneSessionOnCampaignRefusal extends AgencySoftphoneErrorResponse {
  code: 'session_on_campaign';
  session_id: string;
  campaign_id: string;
  campaign_name: string;
  state: AgencyAgentState;
}

/**
 * 409 `session_on_softphone` from the campaign join (`POST /proxy/agency/sessions`):
 * the agent's live session is a soft-phone session, which has no campaign to name
 * in `session_on_other_campaign`. The remedy is leaving the soft phone.
 */
export interface AgencySoftphoneSessionOnSoftphoneRefusal extends AgencySoftphoneErrorResponse {
  code: 'session_on_softphone';
  session_id: string;
}

/**
 * 409 `manual_call_live` (the session has a call that is live, or ended and
 * awaiting its outcome, where `/softphone/return` and `available` are refused; a
 * live call where `POST /calls` and a disposition are) and 409 `outcome_pending`
 * (`POST /calls` while the session's last call awaits its outcome): the session's
 * unsettled call, so the console can show it rather than an error.
 */
export interface AgencySoftphoneCallPendingRefusal extends AgencySoftphoneErrorResponse {
  code: 'outcome_pending' | 'manual_call_live';
  call: AgencyManualCall;
}
