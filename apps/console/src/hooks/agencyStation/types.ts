import type {
  AgencyAgentState,
  AgencyMissedRelease,
  AgencyReservedAttempt,
  AgencyStationErrorFrame,
  AgencyStationReleasedFrame,
} from '../../types/agency';
import type { WrapupAnchor } from '../../utils/agencyWrapup';
import type { DiagnosticEntry } from '../../utils/agencyDiagnostics';

/**
 * The station socket's public types — what `useAgencyStation` hands the console.
 *
 * Kept apart from the hook so that the pure pieces it is built from (the reducer,
 * the liveness rules) can name them without importing the hook, and re-exported
 * from `hooks/useAgencyStation` so every existing import keeps working.
 */

export type StationConnection =
  | 'idle'
  | 'connecting'
  | 'open'
  /** Socket lost, retry scheduled. Do NOT say "call ended" here. */
  | 'reconnecting'
  /** Terminal: this session cannot be reconnected. Re-bootstrap required. */
  | 'session_gone'
  /** Terminal: another window took this session. */
  | 'superseded'
  /**
   * Terminal *by choice*: the console has stopped retrying and is waiting for the
   * agent to say so. Reached two ways, both meaning "you are not receiving calls
   * and we are no longer pretending otherwise":
   *
   * - three missed pings — 30 s of silence on an open socket. The API's
   *   `OWNERSHIP_TTL_MS` is 30 s, so by this point the server really has dropped
   *   the agent; the socket is closed here so the API's registry stops claiming a
   *   station this console cannot use.
   * - the flap cap — more than `FLAP_LIMIT` connects inside `FLAP_WINDOW_MS`,
   *   which is not a network to wait out.
   *
   * Distinct from `session_gone`: the session is still joinable, so `reconnect()`
   * is a real way back and the rail offers it.
   */
  | 'disconnected';


/**
 * Where inbound audio goes.
 *
 * An interface rather than a callback prop so the console can hand over one
 * object with a **stable identity** for the life of the shift. That is
 * load-bearing here for the same reason the clock estimator lives in a ref: a
 * sink whose identity changed per render would change `handleFrame`, which
 * changes `connect`, which tears down and re-opens the station socket. An
 * inline arrow function in the caller's options object would do exactly that.
 */
export interface AgencyStationAudioSink {
  /** Base64 PCM16 mono 16 kHz — see `utils/agencyMedia.ts` for the provenance. */
  onMedia(payload: string): void;
}

export interface LiveAttempt {
  attempt: AgencyReservedAttempt;
  /**
   * Set only by `bridged` (or read off `ready.active_attempt.bridged_at` on a
   * reconnect). Its presence IS "the call is up", and **its absence IS "still
   * ringing"** — that is the whole pre-answer/post-answer discriminator, and the
   * only one the API supplies.
   *
   * `secondsRemaining` and `ringing` used to sit beside this, fed exclusively by
   * the `countdown` frame. The API emits no such frame and nothing read either field;
   * both went with the handler. `StateRail` has always derived "Ringing — get
   * ready" from `bridgedAt === null`, so nothing on screen changed.
   */
  bridgedAt: string | null;
}

export interface UseAgencyStationResult {
  connection: StationConnection;
  agentState: AgencyAgentState;
  /** `agent_state.since` — the ONLY anchor for break elapsed time. */
  agentStateSince: string | null;
  /** `agent_state.break_reason`, the code in effect while on break. */
  breakReasonCode: string | null;
  /**
   * `agent_state.pending_break_reason` — a break ACCEPTED BUT NOT YET APPLIED.
   *
   * Distinct from `breakReasonCode` above, which is the break in effect. This one
   * is the queue, and it is read off the socket because **the queue outlives the
   * request that created it**: the HTTP response was the console's only source
   * until now, so a break queued mid-call went invisible — and therefore
   * uncancellable — the moment the socket blipped or another window queued it.
   *
   * **`null` means the last transition said nothing is queued, not "unknown".**
   * The API's `/break/cancel` sends an `agent_state` with the pending fields omitted
   * for exactly this purpose, so absence is a statement. Read it together with
   * `agentStateSince`, which moves on every transition and is what tells a
   * consumer a frame has actually spoken.
   *
   * The API pairs `pending_state: 'break'` with `pending_break_reason` at all three of
   * its emitters (the `/break` route, wrap-up entry, and `ready`), so a queued
   * break with no code is not a state the API can produce and is not defended against
   * here.
   */
  pendingBreakCode: string | null;
  /**
   * How many authoritative frames have **stated** the queue. Monotonic; the value
   * means nothing and the *change* is the whole signal.
   *
   * A consumer that keeps its own copy of the queue — the console does, because the
   * HTTP response that queues a break is the fastest answer to the agent's own
   * click — cannot reconcile off `pendingBreakCode` alone. Absence is a statement
   * (`/break/cancel` omits the fields to say the queue is empty), so the second
   * statement of the same value has to be visible, and a value that is already
   * `null` moves nothing. `agentStateSince` used to serve as that marker and no
   * longer can: `ready` restates the queue and carries no `since`, deliberately —
   * a reconnect is not a transition, and the API refuses to invent the instant a break
   * was queued (`contracts.ts`, `AgencyStationReadyFrame.pending_state`).
   *
   * `0` therefore means "no frame has spoken yet", which is a different thing from
   * "the API says nothing is queued".
   */
  pendingBreakStatements: number;
  live: LiveAttempt | null;
  /**
   * The released attempt whose panel and pad **stay up** through wrap-up.
   *
   * on a `released` with `requires_disposition: true` the console takes
   * wrap-up shape *immediately* — "panel stays up and readable, pad enabled". The
   * Phase 1 hook cleared `live` on every `released`, which is correct for the
   * agent's *call* and wrong for the agent's *screen*: it left them dispositioning
   * a contact whose details had just vanished.
   *
   * Cleared by a new `reserved` (a new reservation always wins) and by
   * `agent_state` leaving `wrapup`.
   */
  retainedAttempt: AgencyReservedAttempt | null;
  /**
   * The attempt the station holds **now**, for the stale-response guard: the live
   * or reserved one, else the one being dispositioned. `null` only when there is
   * genuinely none — which is deliberately not a discard.
   */
  currentAttemptId: string | null;
  /**
   * Wrap-up, captured **once, on the frame**.
   *
   * `null` means **no wrap-up frame**, which is a different state from a frame
   * carrying `ends_at: null` — that one is a real held window and produces an
   * anchor with a null `deadlineMs`. There is deliberately no companion "waiting
   * for the frame" flag here: a flag beside a nullable anchor is how the two get
   * merged back together.
   */
  wrapup: WrapupAnchor | null;
  /**
   * Rolling median offset from `pong`, in ms, to subtract from a server instant
   *. Zero until the first sample, which is the honest position.
   */
  clockOffsetMs: number;
  release: AgencyStationReleasedFrame | null;
  /**
   * `Date.now()` when `release` was last set to a non-null frame — analytics only.
   * The wire's `released` frame carries no timestamp of its own (confirmed on
   * `AgencyStationReleasedFrame`), so this is the client's own stamp, cleared at
   * every site that clears `release` so the two never drift apart.
   */
  releasedAt: number | null;
  /**
   * The `released` that landed while this session had no socket (`ready`).
   *
   * Held **separately from `release`** rather than folded into it, and the reason
   * is the one the API states in the contract: this is history, not a transition. It
   * must not fire the disconnect cue, must not clear a panel, and must not open a
   * wrap-up — everything the `released` handler does is right for a call ending
   * now and wrong for one that ended nine minutes ago. Keeping it in its own field
   * means the distinction is structural instead of a comment asking for care.
   *
   * **The API consumes it on read**, so this frame is the only offer. Dropped, the
   * record is gone for good and the agent comes back to an empty station.
   */
  missedRelease: AgencyMissedRelease | null;
  lastError: AgencyStationErrorFrame | null;
  /** Whether the engine will produce further calls (from `campaign_state`). */
  dialing: boolean;
  /** Consecutive missed heartbeats, for the connection health pill. */
  missedPings: number;
  /**
   * The diagnostics buffer's entries — oldest first, one array for the life of
   * the hook, appended in place without a render (see `utils/agencyDiagnostics`).
   */
  diagnostics: readonly DiagnosticEntry[];
  // `hangup` removed — see the note where its implementation was.
  // Hanging up is `hangupAttempt()` in `src/api/agency.ts`, not a socket frame.
  /** Force a reconnect (the "Reconnect" button on a dropped station). */
  reconnect: () => void;
  /**
   * Push one captured audio frame to the API. Returns whether it went on the wire.
   *
   * **Reads the socket ref at call time, never a closed-over socket**, so a
   * reconnect mid-call resumes the agent's uplink onto the new socket with no
   * re-wiring by the caller — and a `false` during the gap is a dropped 20 ms
   * frame, which is the correct outcome and is inaudible.
   *
   * Unlike the removed `hangup` frame, this one is read: the API's borrowed-leg
   * listener acts on `media` and nothing else
   * (`webrtc-bridge-manager.ts:1083`).
   */
  sendMedia: (payload: string) => boolean;
}
