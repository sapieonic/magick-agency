/**
 * **NEW.** Live calls and listening in the console (`docs/listening.md`, decisions LS1–LS14): the
 * calls in progress in an account, a supervisor's grant to listen in silently to one, the
 * customer's full number on demand, and who listened to a call. The socket's vocabularies and
 * frames are the dialer contract's (`../../agency/listen.ts`), re-exported here so a console file
 * needs one import.
 *
 * Routes (under `/proxy/agency`, Firebase session, tenant and account headers). Every route
 * answers `403 feature_disabled` while `agency_live_listen_enabled` is off for the account (the
 * consent gate, LS1):
 *  - `GET  /live-calls`                  `agency.supervise`, {@link AgencyLiveCallsQuery} → {@link AgencyLiveCallsResponse}
 *    (the console polls it every 5 s while the page is visible; numbers masked)
 *  - `GET  /live-calls/:callId/number`   `agency.supervise` → {@link AgencyLiveCallNumberResponse}
 *    (the full number, on demand; not audited, LS9; a withheld number `404 live_call_number_withheld`)
 *  - `POST /live-calls/:callId/listen`   `agency.calls.listen`, no body → 201 {@link AgencyListenGrant}
 *  - `GET  /listen/:sessionId/:listenId?token=…` the listener socket (`../../agency/listen.ts`)
 *
 * The call detail pages answer {@link AgencyCallListenSession} rows (who listened, when) beside
 * the rest of the call, to `agency.supervise` holders like the rest of those pages.
 *
 * Refusals are {@link AgencyListenErrorResponse} (`../../errors.ts` §7), the grant's 503s
 * (`listen_limit_server`, `listen_unavailable`) included: the route marks them reviewed, so the
 * server's error mask keeps their code. Built: the routes, the socket and the console
 * (docs/listening.md, "Status").
 */

import type { AgencyClientKind } from '../../agency/station';
import type { AgencyCallOrigin, AgencyListenEndReason } from '../../agency/listen';
import type { AgencyListenErrorCode, AgencyLiveCallNumberErrorCode } from '../../errors';

export {
  AGENCY_CALL_ORIGINS,
  AGENCY_LISTEN_CLOSE,
  AGENCY_LISTEN_END_CLOSE,
  AGENCY_LISTEN_END_REASONS,
  AGENCY_LISTEN_FRAME_BYTES,
  AGENCY_LISTEN_IDLE_TIMEOUT_MS,
  AGENCY_LISTEN_LEG,
  AGENCY_LISTEN_MESSAGE_BYTES,
  AGENCY_LISTEN_PING_INTERVAL_MS,
  AGENCY_LISTEN_RECONNECT_WINDOW_MS,
} from '../../agency/listen';
export type {
  AgencyCallOrigin,
  AgencyListenClientFrame,
  AgencyListenCloseCode,
  AgencyListenEndedFrame,
  AgencyListenEndReason,
  AgencyListenFormat,
  AgencyListenLeg,
  AgencyListenLegTag,
  AgencyListenPingFrame,
  AgencyListenPongFrame,
  AgencyListenReadyFrame,
  AgencyListenServerFrame,
  AgencyListenStopFrame,
} from '../../agency/listen';
export { AGENCY_LISTEN_ERROR_CODES, AGENCY_LIVE_CALL_NUMBER_ERROR_CODES } from '../../errors';
export type { AgencyListenErrorCode, AgencyLiveCallNumberErrorCode } from '../../errors';

// ─────────────────────────────────────────────────────────────────────────────
// The live list
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /live-calls`: the account's calls in progress, or one campaign's. */
export interface AgencyLiveCallsQuery {
  /** One campaign's calls only (the campaign's Calls tab, "Live"). Absent: the account's. */
  campaign_id?: string;
}

/**
 * Why the caller cannot listen to a live call: the refusal the grant would answer
 * ({@link AgencyListenErrorCode}), computed for the caller when the list was read.
 *  - `listen_recording_off`: the call is not recorded and unrecorded calls may not be listened to
 *    in its account (LS4): "Listening is turned off for unrecorded calls";
 *  - `listen_limit_call`: the call has its listeners already: "Two supervisors are already
 *    listening";
 *  - `listen_own_call`: the caller is the agent on it: "You are on this call".
 */
export const AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS = [
  'listen_recording_off',
  'listen_limit_call',
  'listen_own_call',
] as const satisfies readonly AgencyListenErrorCode[];
export type AgencyLiveCallNotListenableReason = (typeof AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS)[number];

/** Someone listening to a live call now. */
export interface AgencyLiveCallListener {
  user_id: string;
  /** Joined from `users`; null when the account has none to show. */
  name: string | null;
  /** ISO-8601. When this listen session started. */
  started_at: string;
}

/**
 * One call in progress: an agent connected to a customer (a dialler call bridged, a soft-phone
 * call bridged, or an inbound call connected).
 */
export interface AgencyLiveCall {
  /** `agency_calls.id`: the id the number and listen routes take. */
  call_id: string;
  origin: AgencyCallOrigin;
  /**
   * The call's spine row, matching `origin`: the attempt id (`campaign`), the soft-phone call id
   * (`manual`) or the inbound call id (`inbound`). The id the call pages are keyed on ("Open call").
   */
  correlation_id: string;
  /** The campaign (a dialler call's, a tagged soft-phone call's, a matched inbound call's); null otherwise. */
  campaign_id: string | null;
  campaign_name: string | null;
  /** An inbound call's route name, for "Inbound: <route>"; null for other origins. */
  inbound_route_name: string | null;
  agent_user_id: string;
  /** Joined from `users`; null when the account has none to show. */
  agent_name: string | null;
  /** The agent's session (`agency_agent_sessions.id`): the process that owns its socket owns the call. */
  agent_session_id: string;
  /** Where the agent is working from: the console or the mobile app. */
  client_kind: AgencyClientKind;
  /** The roster contact's name, or null ("Unknown caller"). */
  customer_name: string | null;
  /**
   * The customer's number with all but its last four digits hidden: `****1234`. Never the full
   * number. `****` when there is no number to mask: check {@link customer_phone_withheld}.
   */
  customer_phone_masked: string;
  /**
   * The caller withheld their number (an inbound caller with no readable number): show "Withheld"
   * and offer no Show (the number reveal answers `404 live_call_number_withheld`). The server always
   * sends it; optional only so the console's fixtures written before it still type (absent reads
   * as false). Added after the first build, additive.
   */
  customer_phone_withheld?: boolean;
  /** ISO-8601. When the agent was connected to the customer: the time-on-call clock counts from it. */
  connected_at: string;
  /**
   * The campaign's average handle time in seconds, as its stats read computes `aht_seconds` (the
   * agent's leg of its ended, bridged calls); null for a call with no campaign, or a campaign with
   * no such call yet. The console shows the time on call in amber past twice it.
   */
  aht_seconds: number | null;
  /** Whether the call is being recorded (`agency_calls.recording_requested`). */
  recording: boolean;
  /** Whether the caller may open a listen on it now (their permission, the caps, LS4, LS3). */
  listenable: boolean;
  /** Why not, when the caller holds `agency.calls.listen`; null when listenable or when the caller cannot listen at all. */
  not_listenable_reason: AgencyLiveCallNotListenableReason | null;
  /** Who is listening now, earliest first. */
  listeners: AgencyLiveCallListener[];
}

/** `GET /live-calls`. */
export interface AgencyLiveCallsResponse {
  /** Longest on call first. */
  calls: AgencyLiveCall[];
  /** ISO-8601. Server time of the read. */
  as_of: string;
}

/**
 * `GET /live-calls/:callId/number`: the customer's full number, for the row's Show control. Read
 * on demand and never kept in the polled list; the console masks it again on leaving the page. A
 * withheld number answers {@link AgencyLiveCallNumberErrorResponse} (`404 live_call_number_withheld`).
 */
export interface AgencyLiveCallNumberResponse {
  call_id: string;
  /** E.164. */
  customer_phone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Listening
// ─────────────────────────────────────────────────────────────────────────────

/** `POST /live-calls/:callId/listen`: open the listener socket with `ws_url` before `expires_at`. */
export interface AgencyListenGrant {
  /** The session (`agency_listen_sessions.id` once the socket attaches; the `ready` frame repeats it). */
  listen_id: string;
  /** RELATIVE path with the single-use token appended: `/proxy/agency/listen/:sessionId/:listenId?token=…`. */
  ws_url: string;
  /** ISO-8601. The token is refused after it (close 4401): mint a fresh grant. */
  expires_at: string;
}

/** A refusal of a live-call route. */
export interface AgencyListenErrorResponse {
  error: string;
  code: AgencyListenErrorCode;
  message: string;
}

/** The number reveal's own refusal: the caller withheld their number (404). */
export interface AgencyLiveCallNumberErrorResponse {
  error: string;
  code: AgencyLiveCallNumberErrorCode;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Who listened (the call detail pages)
// ─────────────────────────────────────────────────────────────────────────────

/** One listen session on a call, from `agency_listen_sessions`: "Listened to by". */
export interface AgencyCallListenSession {
  listen_id: string;
  listener_user_id: string;
  /** Joined from `users`; null when the account has none to show. */
  listener_name: string | null;
  /** ISO-8601. */
  started_at: string;
  /** ISO-8601; null while the session is open. */
  ended_at: string | null;
  /** Null while the session is open. */
  end_reason: AgencyListenEndReason | null;
  /** Whole seconds from start to end; null while the session is open. */
  duration_seconds: number | null;
}
