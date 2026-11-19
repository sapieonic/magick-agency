/**
 * **NEW.** The account's whole floor in one read (the Live floor page, decision B28b):
 * `GET /proxy/agency/floor?from=<instant>`, one row per agent of the account.
 *
 * - **Gate:** `agency.supervise`, then the account scope (`400 account_scope_required`), then the
 *   dialer flag (`403 feature_disabled`), in that order, as Home's board. Not the listening flag:
 *   the floor is served whether listening is on or off; only `call.listenable` follows it.
 * - **Query:** `from`, an ISO-8601 instant with its offset (the viewer's local midnight), at most
 *   {@link AGENCY_FLOOR_MAX_LOOKBACK_HOURS} hours before the server's now and not after it (a few
 *   minutes of clock skew are allowed, {@link AGENCY_FLOOR_FROM_SKEW_MS}). A missing, malformed or
 *   out-of-range `from` is `400` with code {@link AGENCY_FLOOR_QUERY_ERROR_CODE}.
 * - **Rows:** every agent with an open session in the account (a campaign session on any of its
 *   campaigns, or a soft-phone session), and one row per agent staffed on an ACTIVE campaign of the
 *   account (`running`, `stopping`, `paused`) with no open session in it. One row per person:
 *   one live session per agent (OS1); should a person ever hold two open rows, the newest joined
 *   (then the greatest session id) is kept.
 * - **Never cached** (`Cache-Control: no-store`): rows name customers.
 * - The console polls it every 5 s while the page is visible.
 */

import type { AgencyAgentLiveState } from '../../agency/campaign-stats';
import type { AgencyClientKind } from '../../agency/station';
import type { AgencyCallOrigin } from '../../agency/listen';
import type { AgencySessionHelp } from '../../agency/floor-assist';
import type { AgencyLiveCallNotListenableReason } from './live-calls';

/** The furthest back `from` may be, in hours before the server's now (a local midnight is never more than ~26 h ago). */
export const AGENCY_FLOOR_MAX_LOOKBACK_HOURS = 36;

/** How far after the server's now `from` may be (the viewer's clock running fast). */
export const AGENCY_FLOOR_FROM_SKEW_MS = 5 * 60_000;

/** The 400 `code` of a floor read whose query the server refuses (body `{ error, code, message }`). */
export const AGENCY_FLOOR_QUERY_ERROR_CODE = 'invalid_floor_query';

/** `GET /floor`. */
export interface AgencyFloorQuery {
  /** ISO-8601 instant with its offset: where "today" starts for the viewer (their local midnight). */
  from: string;
}

/** The call in progress on an agent's open session: connected to a customer, on any spine. */
export interface AgencyFloorCall {
  /** `agency_calls.id`: what `POST /live-calls/:callId/listen` takes. */
  call_id: string;
  origin: AgencyCallOrigin;
  /** The spine row: the attempt (`campaign`), the soft-phone call (`manual`) or the inbound call (`inbound`). */
  correlation_id: string;
  /** The roster contact's name, or null. Never the number: the floor shows no customer numbers. */
  customer_name: string | null;
  /** ISO-8601. When the agent was connected to the customer: the time-on-call clock counts from it. */
  connected_at: string;
  /** The call's campaign's average handle time in seconds, as the live calls list computes it (amber past twice it); null without one. */
  aht_seconds: number | null;
  /**
   * Whether the reader may open a listen on this call now. Always false while listening is off for
   * the account (or its flag could not be read) or the reader lacks `agency.calls.listen`.
   */
  listenable: boolean;
  /**
   * Why not, as the live calls list computes it; only when the reader holds `agency.calls.listen`
   * and listening is on for the account. Null when listenable, or when listening is not offered.
   */
  not_listenable_reason: AgencyLiveCallNotListenableReason | null;
}

/** One person on the account's floor. */
export interface AgencyFloorAgent {
  agent_user_id: string;
  /** Joined from `users`; null when the account has none to show. */
  agent_name: string | null;
  /** The open session (`agency_agent_sessions.id`); null on a row for a staffed agent with no open session. */
  session_id: string | null;
  /** The open session's campaign; null for a soft-phone session and for a row with no open session. */
  campaign_id: string | null;
  campaign_name: string | null;
  /** The session's state; `offline` for a row with no open session. */
  state: AgencyAgentLiveState;
  /** ISO-8601. The last state change of the open session; null for a row with no open session. */
  state_since: string | null;
  /**
   * Whether the agent's station socket is held (`AgencySupervisorAgent.connected`, the same
   * `StationRegistry` read): `null` when it could not be determined, and on a row with no open session.
   */
  connected: boolean | null;
  /** The app the session's station last attached from; null for a row with no open session. */
  client_kind: AgencyClientKind | null;
  /** The break reason code, present only while `state === 'break'`. */
  break_reason: string | null;
  /**
   * The break's label: a reserved code's own (`RESERVED_BREAK_REASON_LABELS`: soft phone, app in
   * background, …) or the campaign catalog's (its default catalog when it lists none). Null when not
   * on a break, or for a code neither knows.
   */
  break_label: string | null;
  /** The session holds a live inbound call (offered or connected), as `AgencySupervisorAgent.on_inbound_call`. */
  on_inbound_call: boolean;
  /** The session's inbound call ended and still owes its outcome, as `AgencySupervisorAgent.inbound_outcome_owed`. */
  inbound_outcome_owed: boolean;
  /**
   * The window the open session's wrap-up takes, in seconds (the console's `wrapup_overrun` risk):
   * on an inbound wrap-up (`inbound_outcome_owed`) the route's window captured on the inbound call
   * (IQ52; 30 s when the call captured none), otherwise the campaign's `wrapup_seconds`. **Null when
   * there is no countdown to be past:** a timerless campaign (`wrapup_seconds = 0`, "no timer", not
   * a 0 s window), a soft-phone session, a row with no open session. The console reads null as
   * "never past the window".
   */
  wrapup_window_seconds: number | null;
  /** The call in progress on the open session, if any. */
  call: AgencyFloorCall | null;
  /**
   * Conversations this agent handled since `from`, on every campaign of the account: a dialler
   * attempt counted as the grouped stats' `connected` ("conversations") counts it (a redialled
   * conversation once, at its last attempt), dialled in `[from, now)` on a session of this agent's.
   * So this agent's figure equals the grouped stats' `connected` for `group_by=agent` over the same
   * window. Soft-phone and inbound calls are not counted, as there.
   */
  calls_today: number;
  /**
   * A row with no open session: when their last session in this account ended, if that was at or
   * after `from` ("Left at 1:40 pm"); null when they have not been on the floor since `from` ("Not
   * signed in today"). Always null on a row with an open session.
   */
  left_at: string | null;
  /**
   * The open session's open Need help request (LF4, `agency/floor-assist.ts`): when the agent raised
   * it and the call it was raised on. Null once it is answered, cancelled or expired (expiry is read
   * on every floor read, not waited for), on a row with no open session, and on every row while
   * `agency_floor_assist_enabled` is off for the account. This read is how every `agency.supervise`
   * holder in the account is alerted: the console polls it every 5 s.
   *
   * Always sent by this server (null when there is none). Optional in the type only so a client
   * written before Phase 3 still compiles; read absent as null.
   */
  help?: AgencySessionHelp | null;
}

/** Distinct people. */
export interface AgencyFloorTotals {
  /** Rows whose state is not `offline`. */
  on_shift: number;
  /** Agents staffed on an active campaign of the account, together with everyone on shift: `on_shift <= assigned`. */
  assigned: number;
}

/** `GET /floor`. */
export interface AgencyFloorResponse {
  /** Open sessions first, then the staffed agents with none; each part by `agent_user_id`. The console ranks by risk. */
  agents: AgencyFloorAgent[];
  totals: AgencyFloorTotals;
  /** ISO-8601. Server time of the read. */
  as_of: string;
}
