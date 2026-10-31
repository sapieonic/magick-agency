/**
 * The console's view of the soft phone (`docs/softphone.md`), served under
 * `/proxy/agency/softphone/*`.
 *
 * The dialer contract in `../../agency/softphone.ts` is the wire truth, and every
 * shape the console reads unchanged is RE-EXPORTED below rather than copied
 * (`CONTRACT-DIFF.md` §3). This file declares only the request bodies, which are
 * the internal handler bodies without the actor fields the public API layer fills
 * from the authenticated session (§5), and the call detail, which carries the
 * media leg's `WebRtcCallRecord` and so lives beside `attempt-call.ts` (§4).
 */

import type * as Core from '../../agency';
import type { AgencyManualCall, AgencyManualCallOverrides } from '../../agency';
import type { AgencyKeysetPage } from '../../agency';
import type { AgencyCallAvailability } from './attempt-call';
import type { DialerAnalysisStatus, WebRtcCallRecord } from './webrtc-call';

export type {
  AgencyCallField,
  AgencyCallFieldType,
  AgencyCallFieldValues,
  AgencyCallingWindow,
  AgencyDncEntryScope,
  AgencyManualCall,
  AgencyManualCallContact,
  AgencyManualCallDispositionResponse,
  AgencyManualCallDispositionSource,
  AgencyManualCallDncResponse,
  AgencyManualCallDncScope,
  AgencyManualCallEndReason,
  AgencyManualCallListQuery,
  AgencyManualCallOutcome,
  AgencyManualCallOverrides,
  AgencyManualCallOverridesRequest,
  AgencyManualCallState,
  AgencyManualCallTag,
  AgencySessionKind,
  AgencySoftphoneBootstrap,
  AgencySoftphoneCallPendingRefusal,
  AgencySoftphoneCampaign,
  AgencySoftphoneContactInFlightRefusal,
  AgencySoftphoneDncListedRefusal,
  AgencySoftphoneErrorCode,
  AgencySoftphoneErrorResponse,
  AgencySoftphoneOutsideHoursRefusal,
  AgencySoftphoneProfileSummary,
  AgencySoftphoneSessionOnCampaignRefusal,
  AgencySoftphoneSessionOnSoftphoneRefusal,
  AgencySoftphoneSessionResponse,
  AgencySoftphoneSessionSummary,
  AgencySoftphoneSettings,
  AgencySoftphoneSettingsResponse,
  AgencySoftphoneSettingsUpdateRequest,
  AgencySoftphoneSwitchRequest,
  AgencySoftphoneUntagged,
  AgencyStationManualCallFrame,
} from '../../agency';

export {
  AGENCY_CALL_FIELD_TYPES,
  AGENCY_MANUAL_CALL_DISPOSITION_SOURCES,
  AGENCY_MANUAL_CALL_END_REASONS,
  AGENCY_MANUAL_CALL_OUTCOMES,
  AGENCY_MANUAL_CALL_STATES,
  AGENCY_SESSION_KINDS,
  SOFTPHONE_BREAK_REASON,
  SOFTPHONE_BREAK_REASON_LABEL,
  SOFTPHONE_CALL_FIELDS_MAX,
  SOFTPHONE_CALL_FIELD_KEY_MAX,
  SOFTPHONE_CALL_FIELD_KEY_PATTERN,
  SOFTPHONE_OUTCOME_LAPSE_MS,
  SOFTPHONE_OVERRIDE_NOTE_MAX,
  SOFTPHONE_OVERRIDE_NOTE_MIN,
} from '../../agency';
/** The runtime list of {@link Core.AgencySoftphoneErrorCode}; the console keys its copy off it. */
export { AGENCY_SOFTPHONE_ERROR_CODES } from '../../errors';

// ─── Request bodies: the internal ones without the server-filled actor ──────

/** `POST /proxy/agency/softphone/sessions`. The agent is the authenticated caller. */
export type AgencySoftphoneCreateSessionRequest = Record<string, never>;

/** `POST /proxy/agency/softphone/calls`. */
export type AgencyManualCallCreateRequest = Omit<Core.AgencyManualCallCreateRequest, 'agent_user_id'>;

/** `PATCH /proxy/agency/softphone/calls/:id`. */
export type AgencyManualCallUpdateRequest = Omit<Core.AgencyManualCallUpdateRequest, 'agent_user_id' | 'on_behalf'>;

/** `POST /proxy/agency/softphone/calls/:id/hangup`. No body. */
export type AgencyManualCallHangupRequest = Record<string, never>;

/** `POST /proxy/agency/softphone/calls/:id/disposition`. `on_behalf` is decided server-side from `agency.supervise`. */
export type AgencyManualCallDispositionRequest = Omit<
  Core.AgencyManualCallDispositionRequest,
  'agent_user_id' | 'on_behalf'
>;

/** `POST /proxy/agency/softphone/calls/:id/dnc`. */
export type AgencyManualCallDncRequest = Omit<Core.AgencyManualCallDncRequest, 'agent_user_id' | 'on_behalf'>;

// ─── The list ───────────────────────────────────────────────────────────────

/**
 * A `GET /proxy/agency/softphone/calls` row: the wire row, with `agent_name`
 * filled, plus its media leg's summary status for the list's Summary column.
 * Optional so a row built from the dialer type (the live call, a frame) still
 * fits; the list always sends it.
 */
export interface AgencyManualCallListRow extends AgencyManualCall {
  /** The media leg's `analysis_status`; NULL when there is no leg, it was purged, or analysis never ran. */
  analysis_status?: DialerAnalysisStatus | null;
}

/** `GET /proxy/agency/softphone/calls`. Rows carry no contact `context` or `prior_attempts`. */
export type AgencyManualCallsPage = AgencyKeysetPage<AgencyManualCallListRow>;

// ─── The detail ─────────────────────────────────────────────────────────────

/**
 * `GET /proxy/agency/softphone/calls/:id`: the call with its contact's `context`
 * and prior attempts, the override notes, and the media leg (recording, summary,
 * custom dimensions, transcript) in the same envelope as `AgencyAttemptCallDetail`,
 * so the detail page reuses the campaign call's media and analysis sections.
 */
export interface AgencyManualCallDetail {
  call: AgencyManualCall;
  /**
   * Who saved the outcome (`call.dispositioned_by_user_id`), joined from `users`
   * by the public API layer; NULL when no outcome is saved or the user row is
   * gone. Optional for detail fixtures built before it; the route always sends it.
   */
  dispositioned_by_name?: string | null;
  overrides: AgencyManualCallOverrides;
  /**
   * Null whenever `call_availability` is not `available`, and always for a caller
   * without `agency.supervise`: a call's recording, transcript and analysis are
   * supervise-only, the caller's own call included.
   */
  media: WebRtcCallRecord | null;
  /** `never_placed`: refused or failed before the media leg was created. */
  call_availability: AgencyCallAvailability;
}
