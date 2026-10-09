import { captureEvent } from './posthog';
import type { AgencyAgentState, AgencyReleaseReason, AgencyActionErrorCode } from '../types/agency';
import type {
  AgencyCampaignStatus,
  AgencyStallCode,
  AgencyIngestReasonCode,
  AgencyIngestFailureCode,
} from '../types/agency-campaign';
import type { InviteUnavailableStatus } from '../types/invite';
import type { DispositionBlockReason } from '../utils/agencyDispositionForm';
import type { AudioCaptureFailureKind } from '../hooks/useAudioCapture';
import type { CampaignTabId } from '../utils/agencyCampaignTabs';
import type { AgencyPersona } from '../utils/agencyPersona';
import type { AgentStatsWindow } from '../utils/agencyAgentPerformance';
import type { BuilderStepId } from '../pages/campaigns/agency/builderFlow';

/**
 * Typed product-event catalog.
 *
 * Every custom analytics event the app emits is declared here as a small
 * emitter function with an explicit, PII-free property shape. Centralizing the
 * names + shapes keeps call sites consistent, prevents drift/typos across event
 * names, and makes it easy to audit that we only ever send IDs, enum labels,
 * counts, and boolean flags — never bodies, emails, phone numbers, or contact
 * data.
 *
 * All emitters delegate to `captureEvent`, which is a safe no-op when analytics
 * is disabled (no key configured).
 *
 * ── The product dimension is NOT declared here ─────────────────────────
 * The names in this catalog are flat and stay flat. The separator between shells
 * is a `product` super-property — `'ai'` | `'agency'` — registered by whichever
 * shell is mounted (`useProductSurface`, called by `AppLayout` for the `/app`
 * zone and by `AgencyLayout`). Every
 * event below carries it without any emitter or call site knowing it exists, and
 * so do autocapture, pageviews and errors. Do NOT add a `product` property to an
 * emitter's shape: two sources for one dimension is how the two disagree.
 *
 * Events fired outside both shells (login, onboarding, super-admin) deliberately
 * carry no `product` at all.
 */

// --- Activation, setup, monetization, and reliability -------------------

declare const analyticsPathBrand: unique symbol;
export type AnalyticsPath = string & { readonly [analyticsPathBrand]: true };
// Cut to the agency gates. The capability ids deliberately omit the AI
// product's (`calls.dialer`, `calls.dialer.analytics`, `ivr`,
// `scheduling`, `campaigns`, `messaging`, `sip`, `escalation`, `automations`,
// `automations.branching`), and its flag ids `custom_sip` / `ai_call_transfer`;
// none exists in Magick Agency. `agency_call_analysis` is added because it is the
// one other flag a console route is gated on (`/app/call-summaries`).
type CapabilityGateId =
  // Agency Dialer. Mirrors the server's capability gates; keep in lockstep with
  // `KNOWN_CAPABILITY_GATES` in RequireCapability.tsx — a gate missing from
  // either list is a gate whose unavailability is invisible in analytics.
  | 'agency'
  | 'agency.recording'
  | 'agency.analytics';
type FeatureFlagGateId = 'agency_dialer_enabled' | 'agency_call_analysis';
type FeatureGateUnavailableProps =
  | {
      gate_type: 'capability';
      /** Gate identifier only, never UI copy or user-provided data. */
      gate: CapabilityGateId;
    }
  | {
      gate_type: 'feature_flag';
      /** Gate identifier only, never UI copy or user-provided data. */
      gate: FeatureFlagGateId;
    };

type AuthAction = 'signup' | 'login' | 'password_reset';
type AuthProvider = 'email' | 'google';
/**
 * Which sign-in page the attempt was made on.
 *
 * The platform has two front doors onto ONE identity system — `/login` and the
 * Agency Dialer's `/agency/login` — and without this dimension they are
 * indistinguishable in the funnel: same events, same provider, same outcomes. The
 * questions it exists to answer are operational rather than curious (is the agency
 * door being reached at all; do agents fail sign-in more often than platform users;
 * did an invite link change move traffic), and none of them can be reconstructed
 * afterwards from the events already captured.
 *
 * Optional so `/login`'s existing call sites stay unchanged and its historical
 * events keep the same shape; an absent value means the primary door.
 */
type AuthDoor = 'agency';
type AuthFailureReason =
  | 'validation_error'
  | 'auth_error'
  | 'session_error'
  /**
   * Credentials were accepted, but the address is not on an agency workspace —
   * the server answered with a brand-new tenant instead of the membership the invite
   * wrote. Only the agency door reports this: at `/login` a new tenant is somebody
   * signing up, which is the product working.
   *
   * Distinct from `auth_error` on purpose. Nothing failed to authenticate, so
   * collapsing the two would send whoever reads the funnel looking at Firebase
   * and at credential entry, when the actual cause is an address mismatch between
   * the invite and the sign-in — which is a supervisor-facing onboarding problem,
   * not an auth one.
   */
  | 'unrecognised_account'
  | 'unknown_error';
type EmailVerificationSource = 'signup' | 'login';
type FileSizeBucket =
  | 'under_10kb'
  | '10kb_100kb'
  | '100kb_1mb'
  | '1mb_10mb'
  | '10mb_plus';
// `agent` is here because the invite picker now offers it (the invite picker's role list). The enum
// has to cover every role a `team_invite_*` event can actually carry, or the one
// role the Agency Dialer exists for is the one invite nobody ever measures.
//
// Exported because `AgencyJoinPage` reads an invite's role off the wire as the
// app's own `Role` union — which carries `tenant_owner`, a role no invite can
// grant — and has to narrow it before reporting it. Narrowing at the call site
// rather than widening this enum keeps the analytics vocabulary equal to the set
// of roles an invite can actually carry.
export type AccountRole = 'tenant_admin' | 'account_admin' | 'operator' | 'viewer' | 'agent';
type SetupFailureReason =
  | 'validation_error'
  | 'parse_error'
  | 'upload_error'
  | 'download_error'
  | 'unsupported_format'
  | 'invite_error'
  | 'unknown_error';
type ExportScope =
  | 'ai_calls'
  | 'static_calls'
  | 'contact_lists'
  | 'super_admin_usage'
  | 'agency_activity'
  | 'agency_attempts'
  | 'agency_contacts'
  | 'agency_ingest_rejects';
type ExportFailureReason =
  | 'timeout'
  | 'network_error'
  | 'permission_error'
  // The server refused to write a file that would be missing part of the trail
  // (the 424 `AgencyCampaignActivityPage` already renders as a banner).
  | 'incomplete_source'
  | 'unknown_error';

export function trackAuthAttempted(props: {
  action: AuthAction;
  provider: AuthProvider;
  door?: AuthDoor;
}): void {
  captureEvent('auth_attempted', props);
}

export function trackAuthSucceeded(props: {
  action: AuthAction;
  provider: AuthProvider;
  door?: AuthDoor;
  is_new: boolean;
  needs_phone: boolean;
}): void {
  captureEvent('auth_succeeded', props);
}

export function trackAuthFailed(props: {
  action: AuthAction;
  provider: AuthProvider;
  door?: AuthDoor;
  reason: AuthFailureReason;
}): void {
  captureEvent('auth_failed', props);
}

export function trackEmailVerificationRequired(props: {
  source: EmailVerificationSource;
  /**
   * Which sign-in page sent them to the verification wall. Carried here as well as
   * on the three `auth_*` events because this is the step where an invited agent's
   * onboarding actually stalls — they are told to check an inbox and simply do not
   * come back — so leaving it door-blind would hide the drop-off in exactly the
   * dimension {@link AuthDoor} was added to expose.
   */
  door?: AuthDoor;
}): void {
  captureEvent('email_verification_required', props);
}

type SetupEventProps = {
  // Only the team-invite events exist; the contact
  // list, audio, API-key and phone-number setup events went with their pages.
  team_invite_sent: {
    role: AccountRole;
    account_scoped: boolean;
  };
  team_invite_failed: {
    role: AccountRole;
    account_scoped: boolean;
    reason: SetupFailureReason;
  };
};

export function trackSetupEvent<EventName extends keyof SetupEventProps>(
  eventName: EventName,
  props: SetupEventProps[EventName]
): void {
  captureEvent(eventName, props);
}

export function trackFeatureGateUnavailable(props: FeatureGateUnavailableProps): void {
  captureEvent('feature_gate_unavailable', props);
}

type ExportEventProps = {
  csv_export_started: {
    scope: ExportScope;
    field_count: number;
  };
  csv_export_succeeded: {
    scope: ExportScope;
    field_count: number;
    /** The export hit a server-side row ceiling — the file is a prefix, not everything. */
    truncated?: boolean;
  };
  csv_export_failed: {
    scope: ExportScope;
    field_count: number;
    reason: ExportFailureReason;
  };
};

export function trackExportEvent<EventName extends keyof ExportEventProps>(
  eventName: EventName,
  props: ExportEventProps[EventName]
): void {
  captureEvent(eventName, props);
}

export function trackApiErrorEvent(props: {
  status: number;
  path: AnalyticsPath;
  request_id?: string;
}): void {
  captureEvent('api_error', props);
}

// --- Agency Dialer --------------------------------------------------------
//
// Principal-design-engineer consultancy (2026-08-25): the entire agency/dialer
// surface previously had NO custom events — only `product: 'agency'` on
// autocapture/pageviews via `useProductSurface`. What follows instruments the
// real-time console's state machine and the supervisor campaign workspace so
// adoption, friction and failure are all answerable from PostHog.
//
// The PII discipline above applies unchanged, but the shape of what is safe
// does not transfer from the rest of the catalog by default — this surface's
// enums (disposition codes, break-reason codes, campaign names, CSV columns,
// contact context) are almost all OPERATOR- or CONTACT-authored free text.
// Every event below sends a closed union, a count, or a boolean — never a
// code, a label, a name, a message, or a phone number. In particular:
//
//   - A disposition/break-reason is identified by its `code_index`/
//     `reason_index` — its position in the catalog the server delivered (the same
//     index the agent's number keys bind to) — never its `code` or `label`.
//   - `err.message` / `AgencyActionErrorResponse.message` / `stallCopy()`
//     text is never sent; only the closed `AgencyActionErrorCode` /
//     `AgencyStallCode` union member.
//   - Contact `context`, CSV headers, notes, and any `phone_e164` are never
//     sent — counts and booleans only.
//   - A supervisor acting on a named colleague (force-available, floor
//     drawer) never carries that colleague's user id/name/email — the
//     ACTING user is already `distinct_id`; the target is a bucketed state.
//   - Cue settings (`CueSettings.tsx`) are deliberately NOT instrumented per
//     user: the feature exists so an agent can set an accessibility need
//     "without telling their employer anything about themselves",
//     and an event carrying `connect_flash` would be exactly that
//     disclosure, readable by any tenant admin with project access. Do not
//     add one.

type AgencyStationJoinFailedReason =
  | 'session_on_other_campaign'
  | 'conflict_unreadable'
  | 'no_campaign'
  | 'api_error';

export function trackAgencyStationJoined(props: {
  persona: AgencyPersona;
  campaign_id: string;
  disposition_count: number;
  break_reason_count: number;
  wrapup_seconds: number;
  wrapup_auto_return: boolean;
  record_calls: boolean;
  /** Count of contact-context fields configured — never their names. */
  context_field_count: number;
}): void {
  captureEvent('agency_station_joined', props);
}

export function trackAgencyStationJoinFailed(props: {
  reason: AgencyStationJoinFailedReason;
  /** The agent's state on the OTHER campaign, when the conflict was parseable. */
  conflict_state: AgencyAgentState | null;
}): void {
  captureEvent('agency_station_join_failed', props);
}

export function trackAgencyStationConnectionChanged(props: {
  state: 'open' | 'reconnecting' | 'session_gone' | 'superseded' | 'disconnected';
  close_code: number | null;
  retry_count: number;
  had_live_attempt: boolean;
  had_wrapup: boolean;
  /**
   * Why the console stopped, on `disconnected` only. The two causes need
   * different responses — `flapping` points at the network or a load balancer,
   * `heartbeat` at the server's own pong path — and a single `disconnected` bucket
   * made the incident visible but not triageable.
   */
  cause?: 'heartbeat' | 'flapping';
}): void {
  captureEvent('agency_station_connection_changed', props);
}

export function trackAgencyStationTokenMintFailed(props: { retry_count: number }): void {
  captureEvent('agency_station_token_mint_failed', props);
}

export function trackAgencyAttemptReserved(props: {
  campaign_id: string;
  attempt_number: number;
  prior_attempt_count: number;
  context_field_count: number;
  /** Recovered via `ready.active_attempt` after a reconnect, not a fresh reservation. */
  from_reconnect: boolean;
}): void {
  captureEvent('agency_attempt_reserved', props);
}

export function trackAgencyAttemptBridged(props: {
  campaign_id: string;
  /** reserved → bridged, whole seconds. Count only. */
  ring_seconds: number;
  from_reconnect: boolean;
}): void {
  captureEvent('agency_attempt_bridged', props);
}

export function trackAgencyAttemptReleased(props: {
  campaign_id: string;
  reason: AgencyReleaseReason;
  requires_disposition: boolean;
  was_bridged: boolean;
  /** bridged_at → release, whole seconds. 0 when never bridged. */
  talk_seconds: number;
  /** Arrived via `ready.missed_release` — the agent came back to a call they never saw end. */
  missed: boolean;
}): void {
  captureEvent('agency_attempt_released', props);
}

export function trackAgencyDispositionSubmitted(props: {
  campaign_id: string;
  code_index: number;
  is_success: boolean;
  terminal: boolean;
  suppress: boolean;
  requires_note: boolean;
  requires_datetime: boolean;
  has_note: boolean;
  scheduled_callback: boolean;
  selection_method: 'number_key' | 'click';
  /** release → submit, whole seconds: the real wrap-up handle time. */
  seconds_to_submit: number;
}): void {
  captureEvent('agency_disposition_submitted', props);
}

export function trackAgencyDispositionFailed(props: {
  campaign_id: string;
  kind: 'rejected' | 'conflict' | 'discarded';
  code: AgencyActionErrorCode | null;
  /** The disposition catalog had to be re-synced (`unknown_disposition_code`). */
  catalog_resynced: boolean;
  /** The number-key → code mapping shifted under the agent mid-call. */
  keys_remapped: boolean;
}): void {
  captureEvent('agency_disposition_failed', props);
}

export function trackAgencyDispositionBlocked(props: {
  campaign_id: string;
  reason: DispositionBlockReason;
  method: 'number_key' | 'click' | 'ctrl_enter';
}): void {
  captureEvent('agency_disposition_blocked', props);
}

export function trackAgencyWaitingForDialer(props: { campaign_id: string }): void {
  captureEvent('agency_waiting_for_dialer', props);
}

export function trackAgencyPresenceChanged(props: {
  campaign_id: string;
  action: 'go_available' | 'end_break';
  method: 'shortcut' | 'click';
}): void {
  captureEvent('agency_presence_changed', props);
}

export function trackAgencyPresenceRefused(props: {
  campaign_id: string;
  action: 'go_available' | 'end_break';
  code: AgencyActionErrorCode | null;
}): void {
  captureEvent('agency_presence_refused', props);
}

export function trackAgencyBreakRequested(props: {
  campaign_id: string;
  /** Position in `break_reasons` the server delivered — never the code/label. */
  reason_index: number;
  is_paid: boolean | null;
  /** The request landed as a queued (pending) break rather than an immediate one. */
  queued: boolean;
  agent_state: AgencyAgentState;
  method: 'shortcut' | 'click';
}): void {
  captureEvent('agency_break_requested', props);
}

export function trackAgencyBreakRejected(props: {
  campaign_id: string;
  code: 'unknown_break_reason' | 'other';
  catalog_resynced: boolean;
}): void {
  captureEvent('agency_break_rejected', props);
}

export function trackAgencyQueuedBreakResolved(props: {
  campaign_id: string;
  outcome: 'cancelled' | 'already_applied' | 'cancel_failed';
}): void {
  captureEvent('agency_queued_break_resolved', props);
}

export function trackAgencyMicState(props: {
  campaign_id: string;
  outcome: 'ok' | AudioCaptureFailureKind;
  stage: 'preflight' | 'mid_call';
}): void {
  captureEvent('agency_mic_state', props);
}

export function trackAgencyShortcutUsed(props: {
  campaign_id: string;
  key: 'a' | 'b' | 'n' | 'slash' | 'c' | 'd' | 'digit' | 'ctrl_enter';
  /** The branch actually acted, vs the key being refused (e.g. pad disabled). */
  accepted: boolean;
}): void {
  captureEvent('agency_shortcut_used', props);
}

export function trackAgencyHangupRequested(props: {
  campaign_id: string;
  was_bridged: boolean;
  talk_seconds: number;
}): void {
  captureEvent('agency_hangup_requested', props);
}

export function trackAgencyHangupFailed(props: {
  campaign_id: string;
  code: AgencyActionErrorCode | 'unknown';
}): void {
  captureEvent('agency_hangup_failed', props);
}

export function trackAgencyHoldAbandoned(props: {
  /**
   * Which press-and-hold was abandoned.
   *
   * `retry_campaign` is the supervisor's create-a-retry confirmation, which
   * shares the gesture with the agent's hang-up and nothing else — the two are
   * different people, different surfaces and different consequences, so they
   * must stay distinguishable in the funnel rather than being folded into one
   * "hold" count.
   */
  control: 'hangup' | 'retry_campaign';
  held_ms_bucket: 'under_200' | '200_400' | '400_500';
}): void {
  captureEvent('agency_hold_abandoned', props);
}

export function trackAgencyDncMarked(props: {
  campaign_id: string;
  scope: 'campaign' | 'tenant';
  /** The tenant-wide DNC list write actually landed (vs still in flight). */
  dnc_recorded: boolean;
  opened_via: 'shortcut' | 'click';
}): void {
  captureEvent('agency_dnc_marked', props);
}

export function trackAgencyDncFailed(props: {
  campaign_id: string;
  scope: 'campaign' | 'tenant';
  code: AgencyActionErrorCode | null;
}): void {
  captureEvent('agency_dnc_failed', props);
}

export function trackAgencyStationExit(props: {
  campaign_id: string;
  action: 'leave' | 'exit' | 'history_link';
  outcome: 'completed' | 'blocked' | 'failed';
  blocked_reason: 'live_call' | 'in_pool' | 'leaving' | null;
  agent_state: AgencyAgentState;
  destination: 'landing' | 'campaign' | 'performance' | 'attempts' | null;
}): void {
  captureEvent('agency_station_exit', props);
}

/**
 * The join-conflict screen's one-click remedy: leave the OTHER campaign's
 * station and join this one, without navigating away first. Distinct from
 * `trackAgencyStationExit` because this is three chained requests behind one
 * button (resume the other session to learn its id, leave it, rejoin here),
 * and `failed_stage` is which of the three did not land — the detail a leave
 * failure alone cannot carry, and the one that decides whether the agent is
 * still safely at their old station or now at neither.
 */
export function trackAgencyStationSwitchCampaign(props: {
  from_campaign_id: string;
  to_campaign_id: string;
  /**
   * The agent's state on the OTHER campaign. For `blocked_mid_call` this is
   * the FRESH state the resume request just returned — the one fact that
   * decided the abort — not the (possibly stale) state the conflict screen
   * opened with; every other outcome uses the state from the original 409.
   */
  agent_state: AgencyAgentState;
  /**
   * `blocked_mid_call`: the resumed session turned out to be mid-call, so
   * `leave` was never even attempted — distinct from `failed`, which is a
   * request that was tried and did not land.
   */
  outcome: 'completed' | 'failed' | 'blocked_mid_call';
  failed_stage: 'resume' | 'leave' | 'rejoin' | null;
}): void {
  captureEvent('agency_station_switch_campaign', props);
}

export function trackAgencyNotesSaveFailed(props: {
  campaign_id: string;
  failure: 'retryable' | 'terminal';
  /** Another writer moved `updated_at` out from under this save. */
  foreign_write: boolean;
}): void {
  captureEvent('agency_notes_save_failed', props);
}

export function trackAgencyCampaignTabViewed(props: {
  campaign_id: string;
  tab: CampaignTabId;
  from_tab: CampaignTabId | null;
  campaign_status: AgencyCampaignStatus;
}): void {
  captureEvent('agency_campaign_tab_viewed', props);
}

export function trackAgencyCampaignLifecycleAction(props: {
  campaign_id: string;
  action: 'start' | 'pause' | 'resume' | 'stop';
  from_status: AgencyCampaignStatus;
  to_status: AgencyCampaignStatus;
  confirmed: boolean;
  from_tab: CampaignTabId;
}): void {
  captureEvent('agency_campaign_lifecycle_action', props);
}

export function trackAgencyCampaignLifecycleFailed(props: {
  campaign_id: string;
  action: 'start' | 'pause' | 'resume' | 'stop';
  from_status: AgencyCampaignStatus;
  status_code: number;
}): void {
  captureEvent('agency_campaign_lifecycle_failed', props);
}

export function trackAgencyCampaignStallSurfaced(props: {
  campaign_id: string;
  code: AgencyStallCode;
  other_stall_count: number;
  campaign_status: AgencyCampaignStatus;
  concurrency_saturated: boolean;
  abandonment_over_ceiling: boolean;
}): void {
  captureEvent('agency_campaign_stall_surfaced', props);
}

export function trackAgencyCampaignStallExpanded(props: {
  campaign_id: string;
  code: AgencyStallCode;
  other_stall_count: number;
}): void {
  captureEvent('agency_campaign_stall_expanded', props);
}

export function trackAgencyFloorIntervention(props: {
  campaign_id: string;
  action: 'force_available' | 'drawer_opened';
  target_state: AgencyAgentState;
  seconds_in_state_bucket: 'under_60' | '1_5m' | '5_15m' | 'over_15m';
  sort: 'risk' | 'name';
}): void {
  captureEvent('agency_floor_intervention', props);
}

export function trackAgencyActivityFiltered(props: {
  campaign_id: string;
  /** Count of selected actions — never the action names/labels. */
  action_filter_count: number;
  has_date_range: boolean;
  /** `available_actions` was served by the server — false means the filter is hidden. */
  vocabulary_available: boolean;
}): void {
  captureEvent('agency_activity_filtered', props);
}

export function trackAgencyActivityPartial(props: {
  campaign_id: string;
  /** Client-side allow-list of the server's reason — never raw prose. */
  reason: 'core_unavailable' | 'other' | null;
}): void {
  captureEvent('agency_activity_partial', props);
}

export function trackAgencyActivityLoadMore(props: {
  campaign_id: string;
  page_index: number;
  failed: boolean;
}): void {
  captureEvent('agency_activity_load_more', props);
}

export function trackAgencyRecordingOutcome(props: {
  status: 'ok' | 'forbidden' | 'purged' | 'not_recorded' | 'unreachable';
}): void {
  captureEvent('agency_recording_outcome', props);
}

export function trackAgencyRosterIngestStarted(props: {
  campaign_id: string | null;
  source: 'builder' | 'top_up';
  dry_run: boolean;
  /** CSV headers are contact data — count only. */
  column_count: number;
  mapped_variable_count: number;
  hero_field_count: number;
}): void {
  captureEvent('agency_roster_ingest_started', props);
}

export function trackAgencyRosterIngestCompleted(props: {
  campaign_id: string;
  source: 'builder' | 'top_up';
  rows_read: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  dnc_suppressed: number;
  /** Rejection ratio crossed the mis-mapped-column threshold. */
  high_rejection: boolean;
  /** accepted + rejected === rows_read. False is a server-side arithmetic alarm. */
  reconciles: boolean;
  top_reason: AgencyIngestReasonCode | null;
}): void {
  captureEvent('agency_roster_ingest_completed', props);
}

export function trackAgencyRosterIngestFailed(props: {
  source: 'builder' | 'top_up';
  code: AgencyIngestFailureCode;
}): void {
  captureEvent('agency_roster_ingest_failed', props);
}

export function trackAgencyCampaignBuilderStepViewed(props: {
  step: BuilderStepId;
  step_index: number;
}): void {
  captureEvent('agency_campaign_builder_step_viewed', props);
}

export function trackAgencyCampaignConfigSaved(props: {
  campaign_id: string | null;
  source: 'builder' | 'settings';
  disposition_count: number;
  /** Dispositions beyond the built-in catalog. */
  custom_disposition_count: number;
  /** `suppress` + `terminal` both set — legal, but the second flag is unreachable. */
  suppress_and_terminal_pairs: number;
  disposition_retry_rule_count: number;
  retry_policy_outcome_count: number;
  wrapup_seconds: number;
  auto_return: boolean;
  recording_enabled: boolean;
  analysis_profile_set: boolean;
  /** The disposition order was changed via the row arrows. */
  reordered: boolean;
}): void {
  captureEvent('agency_campaign_config_saved', props);
}

export function trackAgencyCampaignConfigBlocked(props: {
  source: 'builder' | 'settings';
  field_error_count: number;
}): void {
  captureEvent('agency_campaign_config_blocked', props);
}

export function trackAgentSurfaceViewed(props: {
  surface: 'performance' | 'attempts';
  subject: 'me' | 'agent';
  viewer_persona: AgencyPersona;
  campaign_scoped: boolean;
  occupancy_measured: boolean;
  bucket_count: number;
  entry: 'home' | 'station_menu' | 'analytics_tab' | 'direct';
}): void {
  captureEvent('agent_surface_viewed', props);
}

/**
 * The contribution view was opened for one campaign — "who drove this campaign".
 *
 * ── Its own event, beside `agent_surface_viewed` rather than inside it ─────
 * The per-agent drill-down's event describes a PERSON's payload:
 * `occupancy_measured` and `bucket_count` are properties of the three tiles, and
 * this screen has neither — the grouped read carries no occupancy and no buckets.
 * Widening that union to a third `surface` would put two fields on it that are
 * meaningless for one of the three, which is how a funnel comes to filter on a
 * flag that means nothing.
 *
 * What this one carries instead is the honesty state of the page, because that is
 * what a question about this screen will be about: whether the campaign's own line
 * (the Share column's denominator) was readable at all, whether the server hid rows,
 * and whether `limit` cut the page. `truncated` is the derived answer rather than
 * three counts to re-derive downstream — the console already owns that arithmetic,
 * and two places computing it is how the two disagree.
 *
 * Fired once per campaign in scope, not once per render and not once per window:
 * the campaign selector re-reads without remounting, so the guard keys on the
 * campaign rather than on the mount.
 */
export function trackAgencyCampaignContributionViewed(props: {
  campaign_id: string;
  /** The window the figures were read over — the roster's own vocabulary. */
  window: AgentStatsWindow;
  /** Rows actually on screen, after the server's filtering and the dialer runtime's `limit`. */
  rows: number;
  /** The server's pre-limit, pre-filter count of groups — with one campaign, agents. */
  total_groups: number;
  /** The campaign-grouped line came back. `false` means the Share column is blank. */
  total_read: boolean;
  inactive_omitted: number;
  unattributed_omitted: number;
  include_inactive: boolean;
  truncated: boolean;
}): void {
  captureEvent('agency_campaign_contribution_viewed', props);
}

/**
 * The best-hours map was opened for one campaign — "when does this connect".
 *
 * ── Its own emitter, for the reason the contribution event is its own ──────
 * `agent_surface_viewed` carries `occupancy_measured` and `bucket_count`, and both
 * are meaningless here: the grouped read carries no occupancy and no buckets. A
 * third `surface` on that union would put two fields on it that mean nothing for one
 * of the three, which is how a funnel comes to filter on a flag that means nothing.
 *
 * ── What it carries is the HONESTY state of the map ────────────────────────
 * Because that is what a question about this screen will be about. Whether the zone
 * could be read at all (an unlabelled hour axis is a different screen), how many of
 * the 168 cells had a dial, and **how many were withheld** — the console's own
 * answer, derived once here rather than re-derived downstream from three counts,
 * which is how two places come to disagree. A map that is mostly withheld is a
 * window that was too short, and that is a product question rather than a bug.
 *
 * Fired once per campaign in scope, not once per view switch: a view switch is a
 * re-render by design, and one event per view would make "how often is this map
 * opened" a count of how often three radio buttons were pressed.
 */
export function trackAgencyBestHoursViewed(props: {
  campaign_id: string;
  /** The window the figures were read over — the roster's own vocabulary. */
  window: AgentStatsWindow;
  /** Which metric the colour encoded when the map was opened. */
  view: 'connect_rate' | 'volume' | 'conversion_rate';
  /**
   * The zone the buckets were cut in, or `null` when the field did not arrive.
   *
   * The campaign's zone, never the reader's — the two are different and the axis is
   * labelled from this one or not at all.
   */
  resolved_timezone: string | null;
  /** `false` means the axis carried no zone and the surface said so. */
  zone_read: boolean;
  /** 168 on every honest read — stated so a truncated map is visible as one. */
  cells: number;
  /** Cells with at least one dial. */
  cells_with_dials: number;
  /** Cells the server said not to rate, so they carry no colour. */
  withheld_cells: number;
  /** Cells never inside `[from, to)`. `0` when coverage could not be derived. */
  out_of_window_cells: number;
  /** `false` when there was no zone to derive coverage in, so blanks are ambiguous. */
  coverage_known: boolean;
  /** The server's pre-limit count of groups, for the one case where 168 is not the whole map. */
  total_groups: number;
}): void {
  captureEvent('agency_best_hours_viewed', props);
}

/**
 * The compare tray was opened on the roster.
 *
 * ── It describes a page, not a request ────────────────────────────────────
 * The tray issues **zero** reads: it compares people already on the roster page
 * against that page's own benchmark. So this event carries the state of the page it
 * was opened over — how many people were available to pick from, and whether the
 * cohort behind the bands was thin — rather than anything about a fetch, because
 * there is no fetch to describe.
 *
 * `campaign_id` is a string rather than nullable: the tray is suppressed entirely on
 * a pooled cohort (a pooled multi-campaign band is not a peer group), so a firing
 * with no campaign in scope would be a bug rather than a state.
 */
export function trackAgencyCompareTrayOpened(props: {
  campaign_id: string;
  window: AgentStatsWindow;
  /** People on the roster page, i.e. how many the picker offered. */
  rows_available: number;
  /** How many were picked at the moment it opened. */
  agents_selected: number;
  /** The cohort behind every band in the tray — `benchmark.agents_rated`. */
  agents_rated: number;
  /** `false` when the cohort is too thin for the bands to mean much. */
  benchmark_usable: boolean;
}): void {
  captureEvent('agency_compare_tray_opened', props);
}

export function trackAgentAttemptsFiltered(props: {
  subject: 'me' | 'agent';
  filter_group_count: number;
  has_date_range: boolean;
  /** Count of disposition-code chips selected — codes themselves are free text. */
  disposition_chip_count: number;
  used_free_text: boolean;
  campaign_scoped: boolean;
}): void {
  captureEvent('agent_attempts_filtered', props);
}

export function trackAgentAttemptsLoadMoreFailed(props: {
  subject: 'me' | 'agent';
  pages_loaded: number;
}): void {
  captureEvent('agent_attempts_load_more_failed', props);
}

export function trackAgencyStaleResponseDiscarded(props: {
  surface: 'disposition' | 'attempts_list' | 'dnc' | 'hangup';
  reason: 'attempt_changed' | 'attempt_id_mismatch' | 'superseded';
}): void {
  captureEvent('agency_stale_response_discarded', props);
}

// --- Agency invites (the `/agency/join/:token` landing page) ----------------
//
// The one surface an agent sees BEFORE they have an account, and therefore the
// one whose drop-off cannot be reconstructed from anything else: nothing here
// is attached to a `distinct_id` that means anything yet, and a visitor who
// closes the tab leaves no session behind to notice was never created.
//
// The PII rule bites unusually hard on this page, because almost everything on
// it is exactly what must not be sent: the invited address, the address the
// visitor signed in with, the inviter's name, and the workspace's name. None of
// those appear below. What is left — the role, whether the server could name the
// inviter, which credential method was used, and whether the address matched —
// is the whole of what the funnel needs, and none of it identifies anybody.
//
// ── That was true of the properties and NOT of the events ──────────────────
// This comment used to stop at the paragraph above, and reading it as an
// assurance about the events was the mistake. The most sensitive value on this
// page is not a property anybody writes here: it is the single-use invite TOKEN,
// and it is in the URL. posthog-js attaches `$current_url`, `$pathname` and
// `$host` to every capture, so the token travelled in the envelope of all five
// events below — `agency_invite_viewed` included, which fires while the
// invitation is still pending and unclaimed and is therefore still worth
// stealing — as well as in every autocapture click on the page, which no catalog
// entry could ever have covered.
//
// It is redacted at the PostHog boundary instead (`before_send` in
// `analytics/posthog.ts`, rules in `analytics/redact.ts`), which is the only
// place that holds for a capture this file does not write. Nothing below needs
// to do anything about it, and nothing below should be read as evidence that it
// is handled.

/** How the visitor produced a Firebase credential to claim with. */
type InviteClaimMethod = 'create' | 'sign_in' | 'google';

type InviteClaimFailureReason =
  /** Firebase refused the credential: wrong password, closed popup, network. */
  | 'credential_error'
  /** The address already has a credential — an agent invited to a second tenant. */
  | 'email_in_use'
  /** Refused before the network, by the page's own strength rule. */
  | 'weak_password'
  /** The invite went terminal between the lookup and the claim (409 / 404). */
  | 'invite_unavailable'
  /** They answered the address-mismatch confirmation with "use a different account". */
  | 'mismatch_declined'
  /**
   * The server refused the claim because that Firebase account already belongs to a
   * different user row here (`identity_in_use`).
   *
   * Its own reason rather than `claim_error`, because it is the one conflict this
   * page's own design makes reachable: allowing a mismatched Google address is
   * what lets somebody claim with a personal account that already has a workspace
   * of its own. How often that happens is how often the mismatch confirmation is
   * being answered by people who cannot actually complete it.
   */
  | 'identity_in_use'
  /** The claim endpoint failed for any other reason. */
  | 'claim_error';

/**
 * The invite link was opened, and what was behind it.
 *
 * `status` covers the four terminal states as well as `pending`, because "how
 * many of these links are opened after they have expired" is a supervisor-process
 * question that nothing else can answer — and `unreachable` is here so a spell of
 * failed lookups is distinguishable from a spell of nobody clicking.
 */
export function trackAgencyInviteViewed(props: {
  /**
   * Built from {@link InviteUnavailableStatus} rather than restated, so a status
   * the server adds cannot be reported by the page and silently dropped from the
   * funnel — the compiler names every place it has to be handled. `pending` and
   * `unreachable` are this page's own, and neither is a wire value.
   */
  status: InviteUnavailableStatus | 'pending' | 'unreachable';
  /** Null on every status but `pending`, where the invite body is the thing read. */
  role: AccountRole | null;
  /** Whether the server could name who sent it. An unnamed invite is colder to receive. */
  has_inviter: boolean;
}): void {
  captureEvent('agency_invite_viewed', props);
}

export function trackAgencyInviteClaimAttempted(props: { method: InviteClaimMethod }): void {
  captureEvent('agency_invite_claim_attempted', props);
}

export function trackAgencyInviteClaimSucceeded(props: {
  method: InviteClaimMethod;
  /**
   * Whether the credential's address is the one the invite was sent to. False
   * only on the Google path, and only after the visitor was shown the mismatch
   * and confirmed it — which is the difference between a link that was made
   * deliberately and the stray tenant this page exists to stop.
   */
  address_matched: boolean;
}): void {
  captureEvent('agency_invite_claim_succeeded', props);
}

export function trackAgencyInviteClaimFailed(props: {
  method: InviteClaimMethod;
  reason: InviteClaimFailureReason;
}): void {
  captureEvent('agency_invite_claim_failed', props);
}

/**
 * The Google account signed in with is not the address the invite was sent to.
 *
 * The most valuable measurement on this page, and the reason is historical: this
 * exact case used to pass in silence and produce a stray empty tenant, with
 * nobody told — an agent who could not work, a supervisor whose invite sat
 * unclaimed, and no event anywhere. `shown` is how often onboarding nearly went
 * wrong; `confirmed` and `declined` are what the agent did about it.
 *
 * `shown` is emitted separately rather than being derived from the other two,
 * because the interesting third outcome is neither: closing the tab. Without it
 * an abandoned mismatch is indistinguishable from one that never happened.
 */
export function trackAgencyInviteAddressMismatch(props: {
  outcome: 'shown' | 'confirmed' | 'declined';
}): void {
  captureEvent('agency_invite_address_mismatch', props);
}
