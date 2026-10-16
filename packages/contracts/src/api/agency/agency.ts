/**
 * The console's view of the agency dialer wire contract.
 *
 * The frozen contract in `../../agency` is the wire truth. Every declaration it
 * shares with the console unchanged is RE-EXPORTED below rather than copied, so
 * the two cannot drift; this file declares only the shapes the console reads
 * differently (see `CONTRACT-DIFF.md` §1) and the console's names for the
 * rename-only pairs (§2). The unions are whole even where a member is not yet
 * reachable (`wrapup`, `break`), because a union that widens later is a breaking
 * change for every exhaustive switch.
 */

import type {
  AgencyActionErrorResponse,
  AgencyActiveAttempt,
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyBreakReason,
  AgencyCampaignChangeReason,
  AgencyCampaignStatus,
  AgencyContextDisplay,
  AgencyDisposition,
  AgencyMissedRelease,
  AgencyNotesResponse,
  AgencyPriorAttempt,
  AgencyReleaseReason,
  AgencyReservedAttempt,
  AgencyRetryContext,
  AgencyStationAgentStateFrame,
  AgencyStationBridgeEndedFrame,
  AgencyStationBridgedFrame,
  AgencyStationCampaignStateFrame,
  AgencyStationCountdownFrame,
  AgencyStationErrorFrame,
  AgencyStationMediaFrame,
  AgencyStationPongFrame,
  AgencyStationReleasedFrame,
  AgencyStationReservedFrame,
  AgencyStationTokenResponse,
  AgencyWrapupHoldReason,
} from '../../agency';
import type { AgencyActionErrorCode, AgencyStationErrorCode } from '../../errors';

export type {
  AgencyActionErrorResponse,
  AgencyActiveAttempt,
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyAttemptState,
  AgencyBreakReason,
  AgencyCampaignChangeReason,
  AgencyCampaignStatus,
  AgencyContextDisplay,
  AgencyDisposition,
  AgencyMissedRelease,
  AgencyNotesResponse,
  AgencyPriorAttempt,
  AgencyReleaseReason,
  AgencyReservedAttempt,
  AgencyRetryContext,
  AgencyStationAgentStateFrame,
  AgencyStationBridgeEndedFrame,
  AgencyStationBridgedFrame,
  AgencyStationCampaignStateFrame,
  AgencyStationCountdownFrame,
  AgencyStationErrorFrame,
  AgencyStationMediaFrame,
  AgencyStationPongFrame,
  AgencyStationReleasedFrame,
  AgencyStationReservedFrame,
  AgencyStationTokenResponse,
  AgencyActionErrorCode,
  AgencyStationErrorCode,
};
/** The runtime list of {@link AgencyActionErrorCode}; the console keys its copy off it. */
export { AGENCY_ACTION_ERROR_CODES } from '../../errors';


/**
 * Liveness parameters, in milliseconds. **No client constant may duplicate one
 * of these**: the console's countdown and the server's lease would drift the
 * first time either is retuned, and the drift is silent.
 */
export interface AgencyStationIntervals {
  heartbeat_ms: number;
  heartbeat_grace_ms: number;
  reservation_lease_ms: number;
  countdown_ms: number;
  /**
   * How long a live call is held open after the station socket drops, waiting
   * for this session to reconnect. Optional here so a payload that lacks it
   * degrades to the console's default rather than to a wrong number.
   */
  deferred_hangup_ms?: number;
}

export interface AgencySessionBootstrap {
  session_id: string;
  campaign_id: string;
  campaign_name: string;
  agent_user_id: string;
  state: AgencyAgentState;
  campaign_status: AgencyCampaignStatus;
  station_ws_url: string;
  /** ISO-8601. Single-use and short — re-mint before each connect attempt. */
  station_token_expires_at?: string;
  disposition_catalog: AgencyDisposition[];
  wrapup_seconds: number;
  wrapup_auto_return: boolean;
  record_calls: boolean;
  break_reasons: AgencyBreakReason[];
  context_display: AgencyContextDisplay;
  intervals: AgencyStationIntervals;
  /**
   * Set only when this campaign is a retry of another one.
   *
   * **Absent for every non-retry campaign**, which is 100% of them today — so an
   * `undefined` here is the ordinary case and must render as *nothing at all*,
   * not as an empty banner reserving space.
   *
   * ── Why it is on the bootstrap and not on the `reserved` frame ─────────────
   * It is campaign-constant: it is the same three values for the whole shift.
   * `AgencyStationReservedFrame` is the one payload whose latency the dialer
   * design guards hardest — it is written synchronously, before the dial, with
   * no interleaved `await` — and repeating a fixed sentence on it once per call
   * would spend that budget on copy.
   *
   * ── `selection_summary` is BUILT SERVER-SIDE and rendered unchanged ─────────────
   * The dialer runtime composes it from the frozen `retry_selector` on the child campaign row,
   * so the sentence the agent reads and the query that produced their roster
   * cannot disagree. Re-deriving it here from anything this client holds would
   * be a second answer to the same question, and this client does not even have
   * the input — the selector is not on the bootstrap, deliberately.
   */
  retry_context?: AgencyRetryContext;
}

/**
 * `409` from `POST /proxy/agency/sessions` — the agent already holds a live
 * session on a **different** campaign in this tenant.
 *
 * Mirrors `AgencySessionCampaignConflict` in `../../agency`, which is the
 * authority. The public API layer forwards status and body **unchanged**, so what the dialer runtime writes
 * is what lands here.
 *
 * ── Why this error exists at all ──────────────────────────────────────────────
 * Live-uniqueness moved from `(campaign_id, agent_user_id)` to
 * `(tenant_id, agent_user_id)`: one human has one pair of ears, and two pacing
 * engines reserving the same person independently bridged two customers onto
 * them.
 *
 * The console renders this as an **answer**, not a failure: it names the station
 * the agent is still joined to, and Leave station *there* is the way out. A
 * generic "Could not join the campaign." would hand them a refusal with nothing
 * to do about it — and this is the one error the new rule makes reachable for an
 * ordinary agent, so it is the one that must not be generic.
 */
export interface AgencySessionConflict {
  error: string;
  code: 'session_on_other_campaign';
  campaign_id: string;
  campaign_name: string;
  /** Their state on that other campaign, so the copy can say whether they are mid-call. */
  state: AgencyAgentState;
  /**
   * The dialer runtime's own sentence.
   *
   * The console does **not** render it on the ordinary path: it composes better
   * copy from the structured fields — a remedy that branches on `state`, and a
   * link to the station they are still joined to — neither of which a server
   * sentence can carry. This is the *degraded* fallback, for a body whose
   * structured fields do not read. The dialer runtime's sentence beats "something went wrong",
   * and when there is no campaign id to point at it is the only thing left to
   * say.
   */
  message?: string;
}

/**
 * Answer to every session-state transition (`/available`, `/break`,
 * `/break/cancel`, `/leave`).
 *
 * `pending_state` is the queued-break signal, and this body is the **fastest** of
 * its three sources rather than the only one: the field also rides on
 * `agent_state` and on `ready`, and those are what a console that did not issue
 * the request has. This one exists — it lands before any frame does, and a pill
 * that waited for the next transition would look like the agent's click did
 * nothing. Everything else here is reconciliation only: `agent_state` frames remain
 * the sole authority for the rail.
 */
export interface AgencySessionStateResponse {
  session_id: string;
  state: AgencyAgentState;
  /** ISO-8601. */
  since: string;
  /** Set when a break was requested mid-call and is queued until wrap-up ends. */
  pending_state?: AgencyAgentState | null;
  /**
   * The break's reason code — **`break_reason`, not `pending_break_reason`.**
   *
   * The HTTP body never carries `pending_break_reason` (`agency.routes.ts`
   * builds `AgencySessionStateResponse` with `break_reason`, and the public API
   * layer proxies it byte-for-byte). Reading the wrong name yields `undefined`,
   * and a silent `?? fallback` is the only thing standing between that and a
   * queued break with no label.
   *
   * Note the deliberate asymmetry with the socket: the FRAME
   * (`AgencyStationAgentStateFrame`) does carry `pending_break_reason`, because
   * there it sits beside `break_reason` and the two mean different things. On the
   * response there is one field, and the dialer runtime sets it for both "on break" and "break
   * queued" — `pending_state` is what tells them apart.
   */
  break_reason?: string | null;
}

export interface AgencyDispositionResponse {
  attempt_id: string;
  contact_id: string;
  disposition_code: string;
  contact_state: string;
  /** ISO-8601; set when the disposition scheduled a retry or a callback. */
  next_attempt_at: string | null;
  /**
   * What the agent ASKED for, echoed unchanged. `next_attempt_at` is the window-adjusted
   * instant the dialer will actually call; when the two differ the console says what will
   * happen (`confirmationCopy`).
   */
  callback_requested_at?: string | null;
  /**
   * The agent's state after release. **ADVISORY, NOT AUTHORITATIVE.**
   *
   * ⚠️ **This field races the socket by design, and assigning from it
   * unconditionally drops a live call.** Submitting releases the agent; the pacing
   * tick runs every 250ms; so a new call can be reserved and its `reserved` frame
   * delivered **before this HTTP response lands**. A console that writes this
   * value into its agent state then overwrites a fresh `reserved` with a stale
   * `available` — and the panel for a customer who is already on the line
   * disappears.
   *
   * The socket is the authority. This is a hint, usable **only** to reconcile when
   * no `agent_state` frame has arrived within 3s, and only through
   * `advisoryAgentState()` in `utils/agencyStaleResponse.ts`, which will not hand
   * it over once the attempt has moved on. Do not read this property directly.
   *
   * It also must not be hard-coded around: after a submit with a queued break the
   * correct state is `break`, not `available`.
   */
  agent_state: AgencyAgentState;
}

/**
 * Answer to `POST /agency/attempts/:id/dnc`.
 *
 * `dnc_recorded` is the field that decides what the console may claim.
 * `contact_state: 'suppressed'` means **this campaign** will not dial the
 * contact again; `dnc_recorded: true` additionally means the tenant-wide
 * `dnc_entries` row landed, which is what makes "no campaign in this workspace"
 * true. The dialer runtime populates it from the public API layer's answer and can only know it by asking —
 * so `false` is a real, reachable state, not a defensive default.
 */
export interface AgencyDncResponse {
  attempt_id: string;
  contact_id: string;
  phone_e164: string;
  /** Always `suppressed` on success. */
  contact_state: string;
  /** False when the suppression landed locally but the list write is in flight. */
  dnc_recorded: boolean;
}

// ─── Station socket frames ──────────────────────────────────────────────────

export interface AgencyStationReadyFrame {
  event: 'ready';
  session_id: string;
  state: AgencyAgentState;
  /**
   * Set when the socket reconnected onto an attempt that is still live.
   *
   * **`AgencyActiveAttempt`, not `AgencyReservedAttempt`** — the difference is
   * `bridged_at`, and it is the whole reconnect story. Typing it as
   * the base type would drop `bridged_at`, and a reconnect onto a live call would
   * render as ringing for the rest of the conversation.
   */
  active_attempt?: AgencyActiveAttempt;
  /**
   * Set when the reconnecting socket is in `wrapup`.
   *
   * The wrap-up countdown is an in-process timer on the dialer runtime's replica, so it survived
   * the socket drop — but the `wrapup` frame that opened it did not, and the dialer runtime does
   * **not** re-emit one. Without reading this, a reconnect mid-wrap-up leaves the
   * console with no anchor: no deadline, no held-reason, and — because the pad's
   * other unlock path keys off a retained attempt this socket never saw — no way
   * to submit the disposition the dialer runtime is about to refuse `/available` over.
   */
  active_wrapup?: AgencyWrapupState;
  /**
   * The `released` this session missed while it was disconnected.
   *
   * **Consumed-on-read in the dialer runtime.** `takeMissedRelease` clears as it reads
   * (`agency.routes.ts`, "read it here, not inline in the frame, because … a
   * second call would return null"), so this frame is the *only* time it is ever
   * offered. A console that drops it does not merely delay the information — it
   * destroys it, and the agent who dropped mid-call comes back to an empty
   * station with no account of the call they were on, which reads as data loss.
   */
  missed_release?: AgencyMissedRelease;
  /**
   * A break the agent asked for that dialer runtime has accepted and not yet applied — the
   * same name, type and meaning as on `AgencyStationAgentStateFrame`, chosen that
   * way deliberately so one badge renders from either frame with no new
   * vocabulary.
   *
   * A
   * queued break is announced exactly twice — on the HTTP response that queued it,
   * and on the `agent_state` beside it — and both die with the socket. The next
   * `agent_state` the agent gets is the one `releaseAgent` sends at the *end* of
   * wrap-up, by which time the break has been applied. So a console that
   * reconnected mid-wrap-up was told its state and its countdown and nothing about
   * the break waiting behind them.
   *
   * **The dialer runtime reads the queue with `peek`, not `take`** (`agency.routes.ts`,
   * `runtime.breaks.peek(sessionId)`), so reporting it here does not consume it:
   * `releaseAgent` still `take`s it when wrap-up ends and the agent still leaves
   * the pool. This is notice of something about to happen, not a receipt for a
   * request.
   *
   * **Not gated on `active_wrapup`.** A break can also be queued from `reserved`
   * or `on_call`, and those reconnects arrive carrying `active_attempt` instead.
   *
   * `undefined` means nothing is queued — the same load-bearing absence as on
   * `agent_state`, so it must CLEAR a badge rather than leave one standing.
   */
  pending_state?: AgencyAgentState;
  /** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

/**
 * Bridge-originated. **Diagnostic only.**
 *
 * `WebRtcBridgeManager` emits these onto the borrowed station socket and the dialer runtime
 * relays them unchanged. They describe the MEDIA LEG, not the attempt — a
 * console that drives UI from them is subtly wrong. In particular
 * `status: 'answered'` means the far end went off-hook, which is NOT the same
 * as audio reaching this agent.
 */
export interface AgencyStationBridgeStatusFrame {
  event: 'status';
  status: string;
}

/**
 * Why wrap-up is being held open rather than counting down. `null` when it is
 * simply running against a deadline. The console's name for the dialer
 * contract's `AgencyWrapupHoldReason`.
 *
 * `supervisor_hold` means "a supervisor is holding this agent out of the pool
 * deliberately"; the console's `WrapupTimer` names it. Nothing produces it yet: no
 * code path sets `held_reason: 'supervisor_hold'`.
 */
export type AgencyWrapupHold = AgencyWrapupHoldReason;

/**
 * The wrap-up window.
 *
 * **`ends_at` is an ABSOLUTE instant, and the console reads it rather than
 * reconstructing it.** Reconstructing (`since + wrapup_seconds × 1000`) means
 * agreeing with the server about two values *and* the client's own arithmetic;
 * any disagreement between the three shows up as drift. Reading one absolute
 * instant means agreeing about one number, which is what makes "within a second
 * and no drift over a shift" achievable rather than merely likely.
 *
 * **`ends_at: null` is legitimate and means "no deadline — ends when the agent
 * acts". It never means expired.** It occurs when auto-return is off, and when
 * the timer has lapsed into a hold. Rendering it as an elapsed or zero countdown
 * tells the agent they are out of time when they are not.
 */
export interface AgencyWrapupState {
  attempt_id: string;
  /** ISO-8601, absolute. Null ⇒ no deadline; see above. */
  ends_at: string | null;
  requires_disposition: boolean;
  disposition_submitted: boolean;
  /**
   * Why the window is held rather than counting down. Set **at entry** for a
   * timerless wrap-up, not only on a later expiry — there is no countdown that
   * could lapse, so without it the agent would face a panel with no deadline and
   * no reason and nothing to act on.
   */
  held_reason?: AgencyWrapupHold | null;
  /**
   * Whether the window will return the agent to the pool on its own.
   *
   * **Trust this, not the campaign config.** For a timerless wrap-up the dialer runtime reports
   * `false` even when the campaign sets `wrapup_auto_return: true`, because with
   * no window it cannot mean what it says. Echoing the config would pair
   * `auto_return: true` with `ends_at: null`, which is indistinguishable from
   * "the countdown frame failed to arrive" — and the console would render a
   * spinner on a wrap-up that is actually waiting for the agent.
   */
  auto_return: boolean;
}

/**
 * Emitted once, idempotently, when wrap-up opens.
 *
 * **`wrapup_seconds = 0` means "no timer", NOT "no wrap-up"**, and the two cases
 * split on whether a disposition is required:
 *
 * - **Disposition required ⇒ a timerless frame IS emitted**, held from the very
 *   first frame with `ends_at: null` and `held_reason` set, ended only by the
 *   agent submitting or a supervisor forcing return. Panel, no countdown.
 * - **No disposition required ⇒ no frame at all.** This is the case the console
 *   must not hang on: never render a pending wrap-up state off a `released` that
 *   will never be followed by a wrap-up frame.
 *
 * (An earlier reading had zero emitting nothing in both cases. That left a
 * campaign with a required disposition handing the agent straight back to the
 * pool while `released` still said `requires_disposition: true` — no window, no
 * protection, and every attempt sweeping to `no_disposition`.)
 *
 * **Wrap-up *ending* is delivered on `agent_state`, never here.** This frame
 * opens the window and carries its deadline; `agent_state` closes it. One
 * authority for agent state means there is no second frame to race.
 */
export interface AgencyStationWrapupFrame {
  event: 'wrapup';
  wrapup: AgencyWrapupState;
}

export type AgencyStationServerFrame =
  | AgencyStationReadyFrame
  | AgencyStationReservedFrame
  | AgencyStationCountdownFrame
  | AgencyStationBridgedFrame
  | AgencyStationReleasedFrame
  | AgencyStationWrapupFrame
  | AgencyStationAgentStateFrame
  | AgencyStationCampaignStateFrame
  | AgencyStationPongFrame
  | AgencyStationErrorFrame
  | AgencyStationBridgeStatusFrame
  | AgencyStationBridgeEndedFrame
  | AgencyStationMediaFrame;

/**
 * Close codes the dialer runtime uses. The distinction that matters is **re-mint and retry**
 * versus **re-bootstrap**: retrying a dead session forever is indistinguishable
 * from a network problem to the agent, and gives them nothing to act on.
 */
export const AGENCY_STATION_CLOSE = {
  /** Token missing, expired, already used or wrong. Re-mint and retry. */
  TOKEN_REJECTED: 4401,
  /** Session unknown or already left. Re-bootstrap; do not retry this session. */
  SESSION_GONE: 4404,
  /** Superseded by a newer socket for this session. Do not retry. */
  SUPERSEDED: 4409,
} as const;
