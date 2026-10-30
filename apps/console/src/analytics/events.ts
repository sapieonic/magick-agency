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
 * Every custom analytics event the app emits is declared here — its name and
 * its explicit, PII-free property shape as one member of {@link EventCatalog}
 * (at the end of this file), and, for the call sites, a small named emitter over
 * the generic {@link track}. Centralizing the
 * names + shapes keeps call sites consistent, prevents drift/typos across event
 * names, and makes it easy to audit that we only ever send IDs, enum labels,
 * counts, and boolean flags — never bodies, emails, phone numbers, or contact
 * data.
 *
 * Every emitter goes through `track`, then `captureEvent` — which accepts only a
 * catalogued name and is a safe no-op when analytics is disabled (no key
 * configured).
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

/**
 * Emit one catalogued event: the name and its property shape come from
 * {@link EventCatalog}, so a call cannot pair an event with another's shape.
 */
export function track<K extends EventName>(name: K, props: EventCatalog[K]): void {
  captureEvent(name, props);
}

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
// It stops short of `tenant_owner` because the TEAM page cannot invite one: the
// `team_invite_*` events are the console's own invite form, and no role it offers
// is an owner.
export type AccountRole = 'tenant_admin' | 'account_admin' | 'operator' | 'viewer' | 'agent';
// The role an invite LINK can carry, which is one wider than {@link AccountRole}:
// a super admin's tenant create invites the new workspace's owner, and their
// add-user can grant `tenant_owner` too, so an owner lands on `/join/:token` like
// any other non-agent. The two invite funnels report it as itself rather than as
// an unclassified `null` — an owner's first sign-in is the one a new tenant's
// whole onboarding hangs on.
export type InvitedRole = AccountRole | 'tenant_owner';
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

export function trackAuthAttempted(props: EventCatalog['auth_attempted']): void {
  track('auth_attempted', props);
}

export function trackAuthSucceeded(props: EventCatalog['auth_succeeded']): void {
  track('auth_succeeded', props);
}

export function trackAuthFailed(props: EventCatalog['auth_failed']): void {
  track('auth_failed', props);
}

export function trackEmailVerificationRequired(props: EventCatalog['email_verification_required']): void {
  track('email_verification_required', props);
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

export function trackFeatureGateUnavailable(props: EventCatalog['feature_gate_unavailable']): void {
  track('feature_gate_unavailable', props);
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

export function trackApiErrorEvent(props: EventCatalog['api_error']): void {
  track('api_error', props);
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

export function trackAgencyStationJoined(props: EventCatalog['agency_station_joined']): void {
  track('agency_station_joined', props);
}

export function trackAgencyStationJoinFailed(props: EventCatalog['agency_station_join_failed']): void {
  track('agency_station_join_failed', props);
}

export function trackAgencyStationConnectionChanged(props: EventCatalog['agency_station_connection_changed']): void {
  track('agency_station_connection_changed', props);
}

export function trackAgencyStationTokenMintFailed(props: EventCatalog['agency_station_token_mint_failed']): void {
  track('agency_station_token_mint_failed', props);
}

export function trackAgencyAttemptReserved(props: EventCatalog['agency_attempt_reserved']): void {
  track('agency_attempt_reserved', props);
}

export function trackAgencyAttemptBridged(props: EventCatalog['agency_attempt_bridged']): void {
  track('agency_attempt_bridged', props);
}

export function trackAgencyAttemptReleased(props: EventCatalog['agency_attempt_released']): void {
  track('agency_attempt_released', props);
}

export function trackAgencyDispositionSubmitted(props: EventCatalog['agency_disposition_submitted']): void {
  track('agency_disposition_submitted', props);
}

export function trackAgencyDispositionFailed(props: EventCatalog['agency_disposition_failed']): void {
  track('agency_disposition_failed', props);
}

export function trackAgencyDispositionBlocked(props: EventCatalog['agency_disposition_blocked']): void {
  track('agency_disposition_blocked', props);
}

export function trackAgencyWaitingForDialer(props: EventCatalog['agency_waiting_for_dialer']): void {
  track('agency_waiting_for_dialer', props);
}

export function trackAgencyPresenceChanged(props: EventCatalog['agency_presence_changed']): void {
  track('agency_presence_changed', props);
}

export function trackAgencyPresenceRefused(props: EventCatalog['agency_presence_refused']): void {
  track('agency_presence_refused', props);
}

export function trackAgencyBreakRequested(props: EventCatalog['agency_break_requested']): void {
  track('agency_break_requested', props);
}

export function trackAgencyBreakRejected(props: EventCatalog['agency_break_rejected']): void {
  track('agency_break_rejected', props);
}

export function trackAgencyQueuedBreakResolved(props: EventCatalog['agency_queued_break_resolved']): void {
  track('agency_queued_break_resolved', props);
}

export function trackAgencyMicState(props: EventCatalog['agency_mic_state']): void {
  track('agency_mic_state', props);
}

export function trackAgencyShortcutUsed(props: EventCatalog['agency_shortcut_used']): void {
  track('agency_shortcut_used', props);
}

export function trackAgencyHangupRequested(props: EventCatalog['agency_hangup_requested']): void {
  track('agency_hangup_requested', props);
}

export function trackAgencyHangupFailed(props: EventCatalog['agency_hangup_failed']): void {
  track('agency_hangup_failed', props);
}

export function trackAgencyHoldAbandoned(props: EventCatalog['agency_hold_abandoned']): void {
  track('agency_hold_abandoned', props);
}

export function trackAgencyDncMarked(props: EventCatalog['agency_dnc_marked']): void {
  track('agency_dnc_marked', props);
}

export function trackAgencyDncFailed(props: EventCatalog['agency_dnc_failed']): void {
  track('agency_dnc_failed', props);
}

export function trackAgencyStationExit(props: EventCatalog['agency_station_exit']): void {
  track('agency_station_exit', props);
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
export function trackAgencyStationSwitchCampaign(props: EventCatalog['agency_station_switch_campaign']): void {
  track('agency_station_switch_campaign', props);
}

export function trackAgencyNotesSaveFailed(props: EventCatalog['agency_notes_save_failed']): void {
  track('agency_notes_save_failed', props);
}

export function trackAgencyCampaignTabViewed(props: EventCatalog['agency_campaign_tab_viewed']): void {
  track('agency_campaign_tab_viewed', props);
}

export function trackAgencyCampaignLifecycleAction(props: EventCatalog['agency_campaign_lifecycle_action']): void {
  track('agency_campaign_lifecycle_action', props);
}

export function trackAgencyCampaignLifecycleFailed(props: EventCatalog['agency_campaign_lifecycle_failed']): void {
  track('agency_campaign_lifecycle_failed', props);
}

export function trackAgencyCampaignStallSurfaced(props: EventCatalog['agency_campaign_stall_surfaced']): void {
  track('agency_campaign_stall_surfaced', props);
}

export function trackAgencyCampaignStallExpanded(props: EventCatalog['agency_campaign_stall_expanded']): void {
  track('agency_campaign_stall_expanded', props);
}

export function trackAgencyFloorIntervention(props: EventCatalog['agency_floor_intervention']): void {
  track('agency_floor_intervention', props);
}

export function trackAgencyActivityFiltered(props: EventCatalog['agency_activity_filtered']): void {
  track('agency_activity_filtered', props);
}

export function trackAgencyActivityPartial(props: EventCatalog['agency_activity_partial']): void {
  track('agency_activity_partial', props);
}

export function trackAgencyActivityLoadMore(props: EventCatalog['agency_activity_load_more']): void {
  track('agency_activity_load_more', props);
}

export function trackAgencyRecordingOutcome(props: EventCatalog['agency_recording_outcome']): void {
  track('agency_recording_outcome', props);
}

export function trackAgencyRosterIngestStarted(props: EventCatalog['agency_roster_ingest_started']): void {
  track('agency_roster_ingest_started', props);
}

export function trackAgencyRosterIngestCompleted(props: EventCatalog['agency_roster_ingest_completed']): void {
  track('agency_roster_ingest_completed', props);
}

export function trackAgencyRosterIngestFailed(props: EventCatalog['agency_roster_ingest_failed']): void {
  track('agency_roster_ingest_failed', props);
}

export function trackAgencyCampaignBuilderStepViewed(props: EventCatalog['agency_campaign_builder_step_viewed']): void {
  track('agency_campaign_builder_step_viewed', props);
}

export function trackAgencyCampaignConfigSaved(props: EventCatalog['agency_campaign_config_saved']): void {
  track('agency_campaign_config_saved', props);
}

export function trackAgencyCampaignConfigBlocked(props: EventCatalog['agency_campaign_config_blocked']): void {
  track('agency_campaign_config_blocked', props);
}

export function trackAgentSurfaceViewed(props: EventCatalog['agent_surface_viewed']): void {
  track('agent_surface_viewed', props);
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
export function trackAgencyCampaignContributionViewed(props: EventCatalog['agency_campaign_contribution_viewed']): void {
  track('agency_campaign_contribution_viewed', props);
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
export function trackAgencyBestHoursViewed(props: EventCatalog['agency_best_hours_viewed']): void {
  track('agency_best_hours_viewed', props);
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
export function trackAgencyCompareTrayOpened(props: EventCatalog['agency_compare_tray_opened']): void {
  track('agency_compare_tray_opened', props);
}

export function trackAgentAttemptsFiltered(props: EventCatalog['agent_attempts_filtered']): void {
  track('agent_attempts_filtered', props);
}

export function trackAgentAttemptsLoadMoreFailed(props: EventCatalog['agent_attempts_load_more_failed']): void {
  track('agent_attempts_load_more_failed', props);
}

export function trackAgencyStaleResponseDiscarded(props: EventCatalog['agency_stale_response_discarded']): void {
  track('agency_stale_response_discarded', props);
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
  /**
   * The invitation is for `account_admin` or above and the account signed in with
   * is not the invited address (decision B25), so it cannot be claimed with it.
   * Recorded whether the page stopped it before the claim
   * (`requires_matching_address`) or the server refused it (`address_required`)
   * — the same outcome for the visitor either way. Neither address is sent: the
   * reason is the whole of what the funnel needs.
   */
  | 'address_required'
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
export function trackAgencyInviteViewed(props: EventCatalog['agency_invite_viewed']): void {
  track('agency_invite_viewed', props);
}

export function trackAgencyInviteClaimAttempted(props: EventCatalog['agency_invite_claim_attempted']): void {
  track('agency_invite_claim_attempted', props);
}

export function trackAgencyInviteClaimSucceeded(props: EventCatalog['agency_invite_claim_succeeded']): void {
  track('agency_invite_claim_succeeded', props);
}

export function trackAgencyInviteClaimFailed(props: EventCatalog['agency_invite_claim_failed']): void {
  track('agency_invite_claim_failed', props);
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
export function trackAgencyInviteAddressMismatch(props: EventCatalog['agency_invite_address_mismatch']): void {
  track('agency_invite_address_mismatch', props);
}

// --- Workspace invites (the `/join/:token` landing page) --------------------
//
// The same funnel as the five `agency_invite_*` events above, for every invite
// whose role is NOT `agent` — an operator, a viewer, an account admin — which now
// gets a token and an email too and lands on `pages/auth/JoinPage`.
//
// ── Its own five names rather than a `door` on the agency five ────────────
// The two pages run one claim flow (`components/agency/join/useInviteClaim`), so
// a dimension on the existing events would have been the smaller diff. It would
// also have changed what `agency_invite_claim_succeeded` MEANS for every saved
// insight built on it: those count agents joining a calling floor, and an
// optional property that older events lack reads as "agency" on every one of
// them only if somebody remembers to filter for it. Separate names keep both
// funnels exactly as wide as their titles say, and `AuthDoor`'s precedent — an
// optional dimension — was for one event family seen through two doors, not two
// products sharing a page.
//
// The properties are the SAME shapes, declared once below and named by both
// families, so the two funnels cannot drift into measuring different things.
// Everything said above about the PII rule and the token in the envelope holds
// here unchanged: no property carries an address, a name or a workspace, and the
// URL is redacted at the PostHog boundary (`/join/` is one of the shapes
// `analytics/redact.ts` knows).
//
// No `product` super-property is registered on that page (see `App.tsx`), the
// same as `/login`: it belongs to no shell, and the event names already say
// which door they came through.

/** {@link trackAgencyInviteViewed}'s workspace twin. */
export function trackWorkspaceInviteViewed(props: EventCatalog['workspace_invite_viewed']): void {
  track('workspace_invite_viewed', props);
}

export function trackWorkspaceInviteClaimAttempted(props: EventCatalog['workspace_invite_claim_attempted']): void {
  track('workspace_invite_claim_attempted', props);
}

export function trackWorkspaceInviteClaimSucceeded(props: EventCatalog['workspace_invite_claim_succeeded']): void {
  track('workspace_invite_claim_succeeded', props);
}

export function trackWorkspaceInviteClaimFailed(props: EventCatalog['workspace_invite_claim_failed']): void {
  track('workspace_invite_claim_failed', props);
}

/** {@link trackAgencyInviteAddressMismatch}'s workspace twin — the same near-miss, one page over. */
export function trackWorkspaceInviteAddressMismatch(props: EventCatalog['workspace_invite_address_mismatch']): void {
  track('workspace_invite_address_mismatch', props);
}

/** The lookup's outcome, as both invite funnels report it. */
interface InviteViewedProps {
  /**
   * Built from {@link InviteUnavailableStatus} rather than restated, so a status
   * the server adds cannot be reported by the page and silently dropped from the
   * funnel — the compiler names every place it has to be handled. `pending` and
   * `unreachable` are this page's own, and neither is a wire value.
   */
  status: InviteUnavailableStatus | 'pending' | 'unreachable';
  /** Null on every status but `pending`, where the invite body is the thing read. */
  role: InvitedRole | null;
  /** Whether the server could name who sent it. An unnamed invite is colder to receive. */
  has_inviter: boolean;
}

interface InviteClaimSucceededProps {
  method: InviteClaimMethod;
  /**
   * Whether the credential's address is the one the invite was sent to. False
   * only on the Google path, and only after the visitor was shown the mismatch
   * and confirmed it — which is the difference between a link that was made
   * deliberately and the stray tenant this page exists to stop.
   */
  address_matched: boolean;
}

interface InviteClaimFailedProps {
  method: InviteClaimMethod;
  reason: InviteClaimFailureReason;
}

interface InviteAddressMismatchProps {
  outcome: 'shown' | 'confirmed' | 'declined';
}

// --- The catalog ------------------------------------------------------------

/**
 * Every custom event this console emits, by name, with its property shape.
 *
 * The emitters above are thin names over {@link track} (the call sites and the
 * test mocks address events through them); this interface is what makes a name
 * and its shape one declaration. A new event is a member here and, if a call
 * site wants one, an emitter. `captureEvent` accepts only these names, so a
 * typo'd or undeclared event no longer type-checks.
 */
export interface EventCatalog extends SetupEventProps, ExportEventProps {
  /** {@link trackAuthAttempted} */
  auth_attempted: {
    action: AuthAction;
    provider: AuthProvider;
    door?: AuthDoor;
  };
  /** {@link trackAuthSucceeded} */
  auth_succeeded: {
    action: AuthAction;
    provider: AuthProvider;
    door?: AuthDoor;
    is_new: boolean;
    needs_phone: boolean;
  };
  /** {@link trackAuthFailed} */
  auth_failed: {
    action: AuthAction;
    provider: AuthProvider;
    door?: AuthDoor;
    reason: AuthFailureReason;
  };
  /** {@link trackEmailVerificationRequired} */
  email_verification_required: {
    source: EmailVerificationSource;
    /**
     * Which sign-in page sent them to the verification wall. Carried here as well as
     * on the three `auth_*` events because this is the step where an invited agent's
     * onboarding actually stalls — they are told to check an inbox and simply do not
     * come back — so leaving it door-blind would hide the drop-off in exactly the
     * dimension {@link AuthDoor} was added to expose.
     */
    door?: AuthDoor;
  };
  /** {@link trackFeatureGateUnavailable} */
  feature_gate_unavailable: FeatureGateUnavailableProps;
  /** {@link trackApiErrorEvent} */
  api_error: {
    status: number;
    path: AnalyticsPath;
    request_id?: string;
  };
  /** {@link trackAgencyStationJoined} */
  agency_station_joined: {
    persona: AgencyPersona;
    campaign_id: string;
    disposition_count: number;
    break_reason_count: number;
    wrapup_seconds: number;
    wrapup_auto_return: boolean;
    record_calls: boolean;
    /** Count of contact-context fields configured — never their names. */
    context_field_count: number;
  };
  /** {@link trackAgencyStationJoinFailed} */
  agency_station_join_failed: {
    reason: AgencyStationJoinFailedReason;
    /** The agent's state on the OTHER campaign, when the conflict was parseable. */
    conflict_state: AgencyAgentState | null;
  };
  /** {@link trackAgencyStationConnectionChanged} */
  agency_station_connection_changed: {
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
  };
  /** {@link trackAgencyStationTokenMintFailed} */
  agency_station_token_mint_failed: { retry_count: number };
  /** {@link trackAgencyAttemptReserved} */
  agency_attempt_reserved: {
    campaign_id: string;
    attempt_number: number;
    prior_attempt_count: number;
    context_field_count: number;
    /** Recovered via `ready.active_attempt` after a reconnect, not a fresh reservation. */
    from_reconnect: boolean;
  };
  /** {@link trackAgencyAttemptBridged} */
  agency_attempt_bridged: {
    campaign_id: string;
    /** reserved → bridged, whole seconds. Count only. */
    ring_seconds: number;
    from_reconnect: boolean;
  };
  /** {@link trackAgencyAttemptReleased} */
  agency_attempt_released: {
    campaign_id: string;
    reason: AgencyReleaseReason;
    requires_disposition: boolean;
    was_bridged: boolean;
    /** bridged_at → release, whole seconds. 0 when never bridged. */
    talk_seconds: number;
    /** Arrived via `ready.missed_release` — the agent came back to a call they never saw end. */
    missed: boolean;
  };
  /** {@link trackAgencyDispositionSubmitted} */
  agency_disposition_submitted: {
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
  };
  /** {@link trackAgencyDispositionFailed} */
  agency_disposition_failed: {
    campaign_id: string;
    kind: 'rejected' | 'conflict' | 'discarded';
    code: AgencyActionErrorCode | null;
    /** The disposition catalog had to be re-synced (`unknown_disposition_code`). */
    catalog_resynced: boolean;
    /** The number-key → code mapping shifted under the agent mid-call. */
    keys_remapped: boolean;
  };
  /** {@link trackAgencyDispositionBlocked} */
  agency_disposition_blocked: {
    campaign_id: string;
    reason: DispositionBlockReason;
    method: 'number_key' | 'click' | 'ctrl_enter';
  };
  /** {@link trackAgencyWaitingForDialer} */
  agency_waiting_for_dialer: { campaign_id: string };
  /** {@link trackAgencyPresenceChanged} */
  agency_presence_changed: {
    campaign_id: string;
    action: 'go_available' | 'end_break';
    method: 'shortcut' | 'click';
  };
  /** {@link trackAgencyPresenceRefused} */
  agency_presence_refused: {
    campaign_id: string;
    action: 'go_available' | 'end_break';
    code: AgencyActionErrorCode | null;
  };
  /** {@link trackAgencyBreakRequested} */
  agency_break_requested: {
    campaign_id: string;
    /** Position in `break_reasons` the server delivered — never the code/label. */
    reason_index: number;
    is_paid: boolean | null;
    /** The request landed as a queued (pending) break rather than an immediate one. */
    queued: boolean;
    agent_state: AgencyAgentState;
    method: 'shortcut' | 'click';
  };
  /** {@link trackAgencyBreakRejected} */
  agency_break_rejected: {
    campaign_id: string;
    code: 'unknown_break_reason' | 'other';
    catalog_resynced: boolean;
  };
  /** {@link trackAgencyQueuedBreakResolved} */
  agency_queued_break_resolved: {
    campaign_id: string;
    outcome: 'cancelled' | 'already_applied' | 'cancel_failed';
  };
  /** {@link trackAgencyMicState} */
  agency_mic_state: {
    campaign_id: string;
    outcome: 'ok' | AudioCaptureFailureKind;
    stage: 'preflight' | 'mid_call';
  };
  /** {@link trackAgencyShortcutUsed} */
  agency_shortcut_used: {
    campaign_id: string;
    key: 'a' | 'b' | 'n' | 'slash' | 'c' | 'd' | 'digit' | 'ctrl_enter';
    /** The branch actually acted, vs the key being refused (e.g. pad disabled). */
    accepted: boolean;
  };
  /** {@link trackAgencyHangupRequested} */
  agency_hangup_requested: {
    campaign_id: string;
    was_bridged: boolean;
    talk_seconds: number;
  };
  /** {@link trackAgencyHangupFailed} */
  agency_hangup_failed: {
    campaign_id: string;
    code: AgencyActionErrorCode | 'unknown';
  };
  /** {@link trackAgencyHoldAbandoned} */
  agency_hold_abandoned: {
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
  };
  /** {@link trackAgencyDncMarked} */
  agency_dnc_marked: {
    campaign_id: string;
    scope: 'campaign' | 'tenant';
    /** The tenant-wide DNC list write actually landed (vs still in flight). */
    dnc_recorded: boolean;
    opened_via: 'shortcut' | 'click';
  };
  /** {@link trackAgencyDncFailed} */
  agency_dnc_failed: {
    campaign_id: string;
    scope: 'campaign' | 'tenant';
    code: AgencyActionErrorCode | null;
  };
  /** {@link trackAgencyStationExit} */
  agency_station_exit: {
    campaign_id: string;
    action: 'leave' | 'exit' | 'history_link';
    outcome: 'completed' | 'blocked' | 'failed';
    blocked_reason: 'live_call' | 'in_pool' | 'leaving' | null;
    agent_state: AgencyAgentState;
    destination: 'landing' | 'campaign' | 'performance' | 'attempts' | null;
  };
  /** {@link trackAgencyStationSwitchCampaign} */
  agency_station_switch_campaign: {
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
  };
  /** {@link trackAgencyNotesSaveFailed} */
  agency_notes_save_failed: {
    campaign_id: string;
    failure: 'retryable' | 'terminal';
    /** Another writer moved `updated_at` out from under this save. */
    foreign_write: boolean;
  };
  /** {@link trackAgencyCampaignTabViewed} */
  agency_campaign_tab_viewed: {
    campaign_id: string;
    tab: CampaignTabId;
    from_tab: CampaignTabId | null;
    campaign_status: AgencyCampaignStatus;
  };
  /** {@link trackAgencyCampaignLifecycleAction} */
  agency_campaign_lifecycle_action: {
    campaign_id: string;
    action: 'start' | 'pause' | 'resume' | 'stop';
    from_status: AgencyCampaignStatus;
    to_status: AgencyCampaignStatus;
    confirmed: boolean;
    from_tab: CampaignTabId;
  };
  /** {@link trackAgencyCampaignLifecycleFailed} */
  agency_campaign_lifecycle_failed: {
    campaign_id: string;
    action: 'start' | 'pause' | 'resume' | 'stop';
    from_status: AgencyCampaignStatus;
    status_code: number;
  };
  /** {@link trackAgencyCampaignStallSurfaced} */
  agency_campaign_stall_surfaced: {
    campaign_id: string;
    code: AgencyStallCode;
    other_stall_count: number;
    campaign_status: AgencyCampaignStatus;
    concurrency_saturated: boolean;
    abandonment_over_ceiling: boolean;
  };
  /** {@link trackAgencyCampaignStallExpanded} */
  agency_campaign_stall_expanded: {
    campaign_id: string;
    code: AgencyStallCode;
    other_stall_count: number;
  };
  /** {@link trackAgencyFloorIntervention} */
  agency_floor_intervention: {
    campaign_id: string;
    action: 'force_available' | 'drawer_opened';
    target_state: AgencyAgentState;
    seconds_in_state_bucket: 'under_60' | '1_5m' | '5_15m' | 'over_15m';
    sort: 'risk' | 'name';
  };
  /** {@link trackAgencyActivityFiltered} */
  agency_activity_filtered: {
    campaign_id: string;
    /** Count of selected actions — never the action names/labels. */
    action_filter_count: number;
    has_date_range: boolean;
    /** `available_actions` was served by the server — false means the filter is hidden. */
    vocabulary_available: boolean;
  };
  /** {@link trackAgencyActivityPartial} */
  agency_activity_partial: {
    campaign_id: string;
    /** Client-side allow-list of the server's reason — never raw prose. */
    reason: 'core_unavailable' | 'other' | null;
  };
  /** {@link trackAgencyActivityLoadMore} */
  agency_activity_load_more: {
    campaign_id: string;
    page_index: number;
    failed: boolean;
  };
  /** {@link trackAgencyRecordingOutcome} */
  agency_recording_outcome: {
    status: 'ok' | 'forbidden' | 'purged' | 'not_recorded' | 'unreachable';
  };
  /** {@link trackAgencyRosterIngestStarted} */
  agency_roster_ingest_started: {
    campaign_id: string | null;
    source: 'builder' | 'top_up';
    dry_run: boolean;
    /** CSV headers are contact data — count only. */
    column_count: number;
    mapped_variable_count: number;
    hero_field_count: number;
  };
  /** {@link trackAgencyRosterIngestCompleted} */
  agency_roster_ingest_completed: {
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
  };
  /** {@link trackAgencyRosterIngestFailed} */
  agency_roster_ingest_failed: {
    source: 'builder' | 'top_up';
    code: AgencyIngestFailureCode;
  };
  /** {@link trackAgencyCampaignBuilderStepViewed} */
  agency_campaign_builder_step_viewed: {
    step: BuilderStepId;
    step_index: number;
  };
  /** {@link trackAgencyCampaignConfigSaved} */
  agency_campaign_config_saved: {
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
  };
  /** {@link trackAgencyCampaignConfigBlocked} */
  agency_campaign_config_blocked: {
    source: 'builder' | 'settings';
    field_error_count: number;
  };
  /** {@link trackAgentSurfaceViewed} */
  agent_surface_viewed: {
    surface: 'performance' | 'attempts';
    subject: 'me' | 'agent';
    viewer_persona: AgencyPersona;
    campaign_scoped: boolean;
    occupancy_measured: boolean;
    bucket_count: number;
    entry: 'home' | 'station_menu' | 'analytics_tab' | 'direct';
  };
  /** {@link trackAgencyCampaignContributionViewed} */
  agency_campaign_contribution_viewed: {
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
  };
  /** {@link trackAgencyBestHoursViewed} */
  agency_best_hours_viewed: {
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
  };
  /** {@link trackAgencyCompareTrayOpened} */
  agency_compare_tray_opened: {
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
  };
  /** {@link trackAgentAttemptsFiltered} */
  agent_attempts_filtered: {
    subject: 'me' | 'agent';
    filter_group_count: number;
    has_date_range: boolean;
    /** Count of disposition-code chips selected — codes themselves are free text. */
    disposition_chip_count: number;
    used_free_text: boolean;
    campaign_scoped: boolean;
  };
  /** {@link trackAgentAttemptsLoadMoreFailed} */
  agent_attempts_load_more_failed: {
    subject: 'me' | 'agent';
    pages_loaded: number;
  };
  /** {@link trackAgencyStaleResponseDiscarded} */
  agency_stale_response_discarded: {
    surface: 'disposition' | 'attempts_list' | 'dnc' | 'hangup';
    reason: 'attempt_changed' | 'attempt_id_mismatch' | 'superseded';
  };
  /** {@link trackAgencyInviteViewed} */
  agency_invite_viewed: InviteViewedProps;
  /** {@link trackAgencyInviteClaimAttempted} */
  agency_invite_claim_attempted: { method: InviteClaimMethod };
  /** {@link trackAgencyInviteClaimSucceeded} */
  agency_invite_claim_succeeded: InviteClaimSucceededProps;
  /** {@link trackAgencyInviteClaimFailed} */
  agency_invite_claim_failed: InviteClaimFailedProps;
  /** {@link trackAgencyInviteAddressMismatch} */
  agency_invite_address_mismatch: InviteAddressMismatchProps;
  /** {@link trackWorkspaceInviteViewed} */
  workspace_invite_viewed: InviteViewedProps;
  /** {@link trackWorkspaceInviteClaimAttempted} */
  workspace_invite_claim_attempted: { method: InviteClaimMethod };
  /** {@link trackWorkspaceInviteClaimSucceeded} */
  workspace_invite_claim_succeeded: InviteClaimSucceededProps;
  /** {@link trackWorkspaceInviteClaimFailed} */
  workspace_invite_claim_failed: InviteClaimFailedProps;
  /** {@link trackWorkspaceInviteAddressMismatch} */
  workspace_invite_address_mismatch: InviteAddressMismatchProps;
}

/** A declared event name. */
export type EventName = keyof EventCatalog;
