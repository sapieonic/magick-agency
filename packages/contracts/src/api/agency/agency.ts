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
import type * as Core from '../../agency';
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
export interface AgencyStationIntervals extends Omit<Core.AgencyStationIntervals, 'deferred_hangup_ms'> {
  /**
   * How long a live call is held open after the station socket drops, waiting
   * for this session to reconnect. Optional here so a payload that lacks it
   * degrades to the console's default rather than to a wrong number.
   */
  deferred_hangup_ms?: number;
}

/**
 * The dialer's bootstrap, read with the console's {@link AgencyStationIntervals}.
 *
 * `retry_context` is absent for every non-retry campaign, so `undefined` is the
 * ordinary case and renders as nothing at all, not as an empty banner.
 */
export interface AgencySessionBootstrap
  extends Omit<Core.AgencySessionBootstrap, 'station_token_expires_at' | 'intervals'> {
  /** ISO-8601. Single-use and short — re-mint before each connect attempt. */
  station_token_expires_at?: string;
  intervals: AgencyStationIntervals;
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
export interface AgencySessionStateResponse
  extends Omit<Core.AgencySessionStateResponse, 'campaign_id' | 'pending_state' | 'break_reason'> {
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

/**
 * The dialer's disposition answer without `campaign_id`, and with
 * `contact_state` read as a string.
 *
 * `agent_state` is ADVISORY: it races the socket by design, so the console reads
 * it only through `advisoryAgentState()` in `utils/agencyStaleResponse.ts`,
 * never directly. `callback_requested_at` is what the agent asked for, echoed
 * unchanged; `next_attempt_at` is the window-adjusted instant the dialer will
 * actually call, and when the two differ the console says what will happen
 * (`confirmationCopy`).
 */
export interface AgencyDispositionResponse
  extends Omit<Core.AgencyDispositionResponse, 'campaign_id' | 'contact_state'> {
  contact_state: string;
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
export interface AgencyDncResponse
  extends Omit<Core.AgencyDncResponse, 'campaign_id' | 'contact_state'> {
  /** Always `suppressed` on success. */
  contact_state: string;
}

// ─── Station socket frames ──────────────────────────────────────────────────

/**
 * The dialer's `ready` frame, carrying the console's {@link AgencyWrapupState}.
 *
 * `missed_release` is consumed-on-read in the dialer runtime, so this frame is
 * the only time it is offered: a console that drops it destroys it. `pending_state`
 * `undefined` means nothing is queued, and must CLEAR a badge rather than leave
 * one standing.
 */
export interface AgencyStationReadyFrame extends Omit<Core.AgencyStationReadyFrame, 'active_wrapup'> {
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
export interface AgencyStationBridgeStatusFrame
  extends Omit<Core.AgencyStationBridgeStatusFrame, 'status'> {
  /** Deliberately wide: the dialer's ten-member union, read as a string. */
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
export interface AgencyWrapupState
  extends Omit<Core.AgencyWrapupState, 'seconds_total' | 'held_reason'> {
  /**
   * Why the window is held rather than counting down. Set **at entry** for a
   * timerless wrap-up, not only on a later expiry — there is no countdown that
   * could lapse, so without it the agent would face a panel with no deadline and
   * no reason and nothing to act on.
   */
  held_reason?: AgencyWrapupHold | null;
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
 * The station socket's close codes (re-mint and retry versus re-bootstrap), declared
 * once in the dialer contract.
 */
export { AGENCY_STATION_CLOSE } from '../../agency';
