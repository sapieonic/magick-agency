import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { AgencyAgentState, AgencyStationServerFrame } from '../types/agency';
import { AGENCY_STATION_CLOSE } from '../types/agency';
import { mintStationToken } from '../api/agency';
import {
  trackAgencyStationConnectionChanged,
  trackAgencyStationTokenMintFailed,
  trackAgencyAttemptReserved,
  trackAgencyAttemptBridged,
  trackAgencyAttemptReleased,
} from '../analytics/events';
import { ClockOffsetEstimator, elapsedSince } from '../utils/agencyClock';
import type { CueDispatcher } from '../utils/agencyCues';
import { encodeAgencyMediaFrame, readAgencyMediaPayload } from '../utils/agencyMedia';
import { openWrapup, type WrapupAnchor } from '../utils/agencyWrapup';
import { DiagnosticsLog } from '../utils/agencyDiagnostics';
import {
  FLAP_WINDOW_MS,
  TOKEN_MINT_TIMEOUT_MS,
  backoffFor,
  recordLiveThenDead,
  silentTooLong,
  withDeadline,
} from '../utils/agencyStationLiveness';
import { INITIAL_STATION_STATE, stationReducer } from '../utils/agencyStationReducer';
import { toAbsoluteWsUrl } from '../utils/agencyStationWsUrl';
import { useStationUnloadGuard } from './useStationUnloadGuard';
import type {
  AgencyStationAudioSink,
  LiveAttempt,
  StationSocketBootstrap,
  UseAgencyStationResult,
} from './agencyStation/types';
import { isCallLive } from '../utils/softphone/callState';
import { useLatestRef } from './useLatestRef';

/**
 * The agent's station socket: one long-lived connection per shift.
 *
 * ── Built for a shift, not a call ──────────────────────────────────────────
 * A socket whose lifetime is one call the user initiated can tear down on
 * `onclose` and let the user start again. This one must survive an eight-hour
 * shift across wifi blips, laptop sleeps and an API deploy, so reconnect,
 * backoff, heartbeat and token re-minting all live here.
 *
 * ── The frame rule that matters most ───────────────────────────
 * The socket carries TWO vocabularies and only one may move the UI. The bridge
 * borrows this socket per attempt and emits its own `status`/`ended` frames
 * onto it, relayed unchanged. Those describe the MEDIA LEG, not the attempt.
 *
 * `status: 'answered'` and `bridged` look interchangeable and are not:
 * `answered` means the carrier says the far end went off-hook; `bridged` means
 * audio is actually flowing to *this agent's socket*. Between them sit the
 * borrowed-socket attach, listener registration and the reserved-agent
 * ownership check, any of which can fail. **An agent whose connect cue fires
 * on `answered` is told a human is on the line while still on dead air** —
 * exactly the failure the design exists to prevent.
 *
 * So: `bridged` and nothing else opens the call. Everything unrecognised goes
 * to the diagnostic sink by default; an unknown frame is expected traffic
 * after an API deploy, never an error, and must never throw or drop the socket.
 *
 * ── The one bridge frame that is NOT diagnostic (`media`) ───────────────────
 * The socket also carries the customer's **voice**, in both directions. That
 * frame shares its origin with `status`/`ended` and must not share their fate:
 * it fell into the sink by default, which is why every agency call was dead air
 * on both ends — and it did so at ~50 frames a second (20 ms frames), so the
 * sink was also driving fifty React state commits per second for the length of
 * every call.
 * `media` is handled explicitly, routed to the audio sink, and **never logged**.
 */

export type {
  StationConnection,
  AgencyStationAudioSink,
  LiveAttempt,
  StationSocketBootstrap,
  UseAgencyStationResult,
} from './agencyStation/types';
export type { DiagnosticEntry } from '../utils/agencyDiagnostics';

/**
 * Retire a socket so nothing it does afterwards can be mistaken for the live
 * one's doing.
 *
 * The handlers are nulled **before** the close, so the `close` event this very
 * call provokes lands on nothing. That ordering is the whole point: the generation
 * guard already makes a stale callback inert, and this makes it never fire.
 * Belt and braces, because the failure it prevents — a stale socket's `onclose`
 * clearing the live socket's heartbeat — is silent and cost a production incident.
 */
function abandon(socket: WebSocket | null, reason = 'replaced'): void {
  if (!socket) return;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  // 1000 for the same reason the effect cleanup uses it: the API must be able to
  // tell a deliberate close from a dropped connection. There is deliberately no
  // "the same console is replacing this socket" code — the API does not define one,
  // and inventing an unshipped contract here would be worse than the cost, which
  // is that the API rehydrates the agent as `offline` and they re-arm. That cost is
  // unchanged from before this fix and is bounded by how rarely we now reconnect.
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(1000, reason);
  }
}

export function useAgencyStation(
  bootstrap: StationSocketBootstrap | null,
  options: {
    tenantId?: string;
    /**
     * Required in practice, `undefined`-tolerant in the type only because every
     * other option here is optional. The API rejects any authenticated route with
     * no `x-mgkvc-account`, so a token mint without it fails the reconnect.
     */
    accountId?: string;
    enabled?: boolean;
    /**
     * The connect cue's dispatcher. Optional so every existing caller
     * and test is unaffected; when absent the console is simply silent.
     *
     * Passed in rather than constructed here because the `AudioContext` behind it
     * can only be created inside the pre-flight's user gesture, and because the
     * dedupe state must outlive any single render.
     */
    cues?: CueDispatcher;
    /**
     * Where inbound `media` frames go. Absent ⇒ they are dropped on the floor,
     * which keeps every existing caller and test unaffected — and, critically,
     * still keeps them out of the diagnostic sink.
     */
    audio?: AgencyStationAudioSink;
    /**
     * The diagnostics buffer to write into. The console hands in the one its cue
     * dispatcher also writes to, so both land in one log; absent, the hook keeps
     * its own. Read once — a different log on a later render is ignored, because
     * the frame handler that writes it must keep one identity for the shift.
     */
    diagnostics?: DiagnosticsLog;
  } = {},
): UseAgencyStationResult {
  const enabled = options.enabled ?? true;
  const cues = options.cues;

  /**
   * Every field the console renders, moved by one pure transition per frame —
   * see `utils/agencyStationReducer` for the groups that used to be sixteen
   * `useState`s written together by hand.
   */
  const [state, dispatch] = useReducer(stationReducer, INITIAL_STATION_STATE);
  const {
    connection,
    agentState,
    agentStateSince,
    breakReasonCode,
    pendingBreakCode,
    pendingBreakStatements,
    missedRelease,
    live,
    retainedAttempt,
    wrapup,
    clockOffsetMs,
    release,
    releasedAt,
    lastError,
    dialing,
    missedPings,
    manualCall,
  } = state;
  const diagnosticsRef = useRef<DiagnosticsLog | null>(null);
  if (diagnosticsRef.current === null) {
    diagnosticsRef.current = options.diagnostics ?? new DiagnosticsLog();
  }
  const diagnostics = diagnosticsRef.current;

  const socketRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const pendingPingsRef = useRef(0);
  /**
   * Which connect attempt owns the hook.
   *
   * ── Why a generation and not a flag ────────────────────────────────────────
   * Every socket this hook opens shares one set of refs — the heartbeat timer,
   * the current-socket pointer, the retry counter — and until this existed
   * **nothing checked which socket a callback belonged to**. A stale socket's
   * `onclose` cleared the LIVE socket's heartbeat, nulled its pointer (so
   * `sendMedia` started returning false: dead air, mid-call) and scheduled
   * another connect. That second socket made the API supersede the first, whose
   * close did the same again — a ~1/s reconnect loop that never backed off,
   * because `onopen` reset the ladder every lap. Measured in production at ~28
   * cycles in 31 minutes across three agents.
   *
   * `connect()` claims the hook by incrementing this; every callback compares
   * before touching shared state. This is the pattern already used for exactly
   * this class of bug everywhere else in the platform — `useAgentAttempts.ts`'s
   * `generation.current += 1` with `decideListResponse`, the API's
   * `LocalCache.epochFor`/`setIfEpoch`, the API's `claim_generation` — and the
   * station socket was the only place lacking it.
   *
   * It replaces the old `closingRef`, which could not work: a deliberate close
   * and the retry it was meant to suppress are two different sockets, and one
   * boolean cannot describe both. (`reconnect()` never even set it, so that path
   * retried unconditionally.)
   */
  const generationRef = useRef(0);
  /**
   * Whether bootstrap's own single-use upgrade token has been used.
   *
   * The old test was `retryCountRef.current > 0`, and `onopen` had just zeroed
   * that — so a socket that opened and died replayed the consumed token and was
   * refused `4401`, which is the lone 4401 at the head of the production burst.
   * Tracking the token itself instead of inferring it from a counter that means
   * something else cannot drift.
   */
  const tokenSpentRef = useRef(false);
  /** The bootstrap `tokenSpentRef` is about, so a new one re-arms it. */
  const tokenBootstrapRef = useRef<StationSocketBootstrap | null>(null);
  /**
   * Timestamps of proven-live-then-died cycles inside the flap window. Bounded by
   * pruning, not by a cap on writes, so the count is honest.
   */
  const connectStampsRef = useRef<number[]>([]);
  /**
   * Whether the CURRENT socket has ever had a ping answered. Reset per connect,
   * set by the `pong` case, and read by `scheduleRetry` to decide whether this
   * death counts toward the flap cap. Safe as a single shared ref because the
   * only writer is the generation-guarded `onmessage`.
   */
  const provedLiveRef = useRef(false);
  /**
   * When the OLDEST currently-unanswered ping went out; `0` when nothing is
   * outstanding. This — not a tick count, and not the last `pong` — is the clock
   * the give-up decision reads.
   *
   * Two wrong versions came before it and the difference is worth keeping:
   *
   *  * **Tick count.** A tick is not a second. A backgrounded tab is throttled to
   *    about one timer a minute and a suspended machine delivers several coalesced
   *    ticks at once, so "three misses" could mean three seconds of real silence
   *    or three minutes — while the contract states the threshold in seconds.
   *  * **Time since the last pong.** The right units and the wrong quantity: it
   *    measures a gap in which we may never have ASKED. Whether that is reachable
   *    depends on something else stopping the pings for long enough that the tick
   *    count also reaches the limit — which is exactly what the live-call hold
   *    below did while its `return` sat above the ping send — or on a browser
   *    replaying a suspended tab's timer backlog rather than firing once and
   *    resuming. Neither was observed in production, so this is stated as the
   *    hazard it is and not as an incident; the reason to prefer the outstanding
   *    ping is that it is the quantity the threshold is *about*, and it also
   *    reports a dead throttled tab in one grace period instead of three ticks.
   *
   * Silence is only evidence when we have actually asked. Anchoring on the
   * outstanding ping makes the rule "a ping we sent has gone unanswered for
   * `MISSED_PING_LIMIT` intervals" — true on a normal cadence and on a throttled
   * one, and unreachable by a tab that simply was not running.
   */
  const unansweredSinceRef = useRef(0);
  const liveRef = useLatestRef<LiveAttempt | null>(live);
  /**
   * The agent state as of the **last frame**, not as of the last render.
   *
   * Written at the moment a state frame is handled (`ready`, `agent_state`),
   * which is what makes it usable from a listener that registered once: `liveRef`
   * above is assigned during render and therefore still holds the pre-batch value
   * while several frames are being dispatched in one task (the API sends
   * `released` → `agent_state` → `wrapup` back to back).
   *
   * Its consumer is the unload guard, which asks whether a customer is on the
   * line. The frame handlers' own question — "did a wrap-up actually happen?" —
   * used to be asked of this ref too; the reducer now answers it from the state
   * as of the last action, which is the same value (see
   * `utils/agencyStationReducer`).
   */
  const agentStateRef = useRef<AgencyAgentState>('offline');
  /**
   * Whether a soft-phone call is on the line, as of the last `manual_call` frame —
   * for the unload guard, which must not let a tab close silently over a customer
   * the agent is talking to from the soft phone (their agent state is `break`, so
   * `agentStateRef` alone would wave the close through).
   */
  const manualLiveRef = useRef(false);
  /**
   * The estimator and its current offset live in refs, not in the frame handler's
   * dependency list.
   *
   * That is load-bearing rather than tidy: `connect` depends on `handleFrame` and
   * the connect effect depends on `connect`, so a `handleFrame` that changed
   * whenever the offset did would **tear down and re-open the station socket on
   * every heartbeat** — an eight-hour shift of reconnects, each one re-minting a
   * token, caused entirely by the clock correction that exists to keep a countdown
   * accurate.
   */
  const estimatorRef = useRef(ClockOffsetEstimator.empty());
  const offsetRef = useRef(0);
  /**
   * The audio sink, kept out of `handleFrame`'s dependency list for exactly the
   * reason spelled out above the estimator: `handleFrame` → `connect` → the
   * connect effect, so a dependency that moves re-opens the socket. A sink that
   * arrived through the deps would re-open it whenever the console re-rendered.
   */
  const audioRef = useLatestRef(options.audio);

  /**
   * Analytics-only mirrors, following the same "ref beside the state" shape as
   * `liveRef` above and for the identical reason: `handleFrame`/`connect` do not
   * list `bootstrap`/`wrapup` in their dependency arrays (see the notes on those
   * `useCallback`s), so a direct read of either state value from inside a frame
   * handler or a socket callback would close over whatever was current the last
   * time that callback was rebuilt — not the value at the moment the frame or
   * socket event actually landed.
   */
  const bootstrapRef = useLatestRef(bootstrap);
  const wrapupRef = useLatestRef<WrapupAnchor | null>(wrapup);
  /** Running tally of reservations this hook instance has seen this shift — analytics only. */
  const attemptCounterRef = useRef(0);
  /** `reserved_at`, kept locally since the wire carries no such field — analytics only. */
  const reservedAtRef = useRef<{ id: string; at: number } | null>(null);
  /**
   * The attempt id the last `ready.active_attempt` reconnect-recovery already
   * reported — analytics only. `ready` restates the whole session state on
   * every reconnect, so a flaky connection recovering mid-call fires this arm
   * once per reconnect for the SAME still-live attempt; without this dedupe
   * `trackAgencyAttemptReserved({from_reconnect:true})` fired every time,
   * inflating the shift's reservation count for one real attempt.
   */
  const recoveredAttemptIdRef = useRef<string | null>(null);


  /**
   * Appends without a render. It used to be a state update copying the whole
   * buffer, so every bridge `status` frame re-rendered the console to change a
   * value nothing on screen reads.
   */
  const logDiagnostic = useCallback(
    (event: string, detail: string) => {
      diagnostics.push({
        at: Date.now(),
        attemptId: liveRef.current?.attempt.attempt_id ?? null,
        event,
        detail,
      });
    },
    [diagnostics],
  );

  /**
   * `agency_station_connection_changed`, with the three fields every report reads
   * off the same refs at the moment it is sent — five call sites spelled them out
   * by hand. Refs, never state: these run inside socket callbacks.
   */
  const reportConnection = useCallback(
    (
      state: Parameters<typeof trackAgencyStationConnectionChanged>[0]['state'],
      closeCode: number | null,
      cause?: 'heartbeat' | 'flapping',
    ) => {
      trackAgencyStationConnectionChanged({
        state,
        close_code: closeCode,
        retry_count: retryCountRef.current,
        had_live_attempt: liveRef.current !== null,
        had_wrapup: wrapupRef.current !== null,
        ...(cause ? { cause } : {}),
      });
    },
    [liveRef, wrapupRef],
  );

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current !== null) clearInterval(heartbeatRef.current);
    if (retryRef.current !== null) clearTimeout(retryRef.current);
    heartbeatRef.current = null;
    retryRef.current = null;
  }, []);

  /**
   * Route one frame. Switches on the AUTHORITATIVE set only; everything else
   * — bridge frames, and anything the API adds later — falls through to the
   * diagnostic sink rather than throwing.
   */
  const handleFrame = useCallback(
    (raw: string) => {
      /**
       * Captured before parsing, so the logged lag measures everything the console
       * does between the frame landing and the cue being scheduled — including the
       * `JSON.parse`. Measuring from after the parse would flatter us by exactly the
       * work most likely to grow.
       */
      const receivedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      let frame: AgencyStationServerFrame;
      try {
        frame = JSON.parse(raw) as AgencyStationServerFrame;
      } catch {
        // Non-JSON is ignored by contract, not an error.
        logDiagnostic('unparseable', raw.slice(0, 200));
        return;
      }
      if (!frame || typeof frame.event !== 'string') {
        logDiagnostic('malformed', raw.slice(0, 200));
        return;
      }

      switch (frame.event) {
        case 'media': {
          /**
           * **The customer's voice. Handled first and logged nowhere.**
           *
           * First in the switch because it is by far the most frequent frame —
           * ~50/s for the whole conversation against a handful per call for
           * everything else.
           *
           * Logged nowhere because this is where the old default arm's cost
           * was: `logDiagnostic` was then a state update, so routing media
           * through it committed React state fifty times a second, re-rendering
           * the entire console — while the audio it was describing went
           * nowhere. The log no longer renders, but fifty entries a second would
           * still flush a 200-entry buffer every four seconds and bury every
           * frame worth reading. There is deliberately no "media frames
           * received" counter either; a counter is the same defect with a
           * smaller payload.
           *
           * A missing sink is silence, not an error: the sink is optional so
           * that a caller which does not want audio (a supervisor's read-only
           * view, every existing test) is unaffected.
           *
           * Read through `readAgencyMediaPayload` rather than off the narrowed
           * type: the union says `media.payload` is there, and the socket is
           * not bound by the union. A `{event:'media'}` with no body would
           * throw out of this handler and take the station socket's `onmessage`
           * with it — a malformed audio frame must cost one frame, not the
           * agent's session.
           */
          const payload = readAgencyMediaPayload(frame);
          if (payload !== null) audioRef.current?.onMedia(payload);
          return;
        }

        case 'ready': {
          /**
           * **`ready` is a full-state SNAPSHOT, not a set of additions.**
           *
           * This is the frame's whole job and the handler used to miss it: every
           * field was applied only when present, so a reconnect could *add* state
           * and never *remove* it. Everything this console believed from frames the
           * previous socket delivered survived a reconnect that contradicted it —
           * and the API cannot contradict it any other way, because the frames that
           * would have (`released`, `agent_state`) were sent into the socket that
           * had already gone.
           *
           * Two live defects came out of that one omission, and they are the same
           * defect:
           *
           *  - **`live` was never cleared.** The API sends `missed_release` *exactly*
           *    when it holds no attempt (`agency.routes.ts:880`,
           *    `activeAttempt ? null : takeMissedRelease(...)`) and only when the
           *    `released` frame could not be delivered (`agency-dialer.ts:646`,
           *    `if (!delivered)`) — which is precisely the case where this console
           *    still has `live` set from before the drop. So the console kept a
           *    bridged attempt that had ended: microphone armed, recording
           *    indicator lit, talk timer running, pad unlocked, and `panelAttempt`
           *    truthy — which suppresses the one component that renders the
           *    "While you were disconnected" notice. The API had already consumed the
           *    record on read, so it was gone for good.
           *  - **`retainedAttempt` / `release` / `wrapup` were never cleared**, so
           *    a wrap-up that lapsed while the socket was away left the pad
           *    unlocked over a window the API had closed. The agent wrote a
           *    disposition into it and the submit 409'd.
           *
           * So: replace or clear, field by field, and never merely add.
           */
          // The state transition for the whole snapshot is ONE dispatch at the end
          // of this case (`stationReducer`'s `ready`); what sits here is the
          // reasoning for each field, beside the side effects that share the frame.
          agentStateRef.current = frame.state;
          // A socket that reconnected onto a still-live attempt rehydrates it,
          // rather than leaving the agent staring at an empty panel while a
          // customer is on the line.
          if (frame.active_attempt) {
            /**
             * **`bridged_at` is the authority, and it is read here rather than
             * guessed.** This previously hard-coded `bridgedAt: null`, which meant a
             * reconnect onto a live call rendered as "Ringing — get ready" for the
             * rest of the conversation: no talk timer, and an agent told to wait
             * while a customer was already speaking. Nothing errored, which is why
             * it survived — the contract names it exactly.
             *
             * There is no second `bridged` frame coming. The API deliberately does not
             * re-emit one, because the connect cue lives in that handler.
             */
            const bridgedAt = frame.active_attempt.bridged_at;
            // Pre-answer ⇒ the rail says "Ringing — get ready". Post-answer ⇒ the
            // talk timer anchors to `bridged_at`. One field, both readings — the
            // reducer sets `live` from it.
            /**
             * **A rehydrated socket is not a connect event**, so this fires nothing
             * — it only tells the dispatcher what it missed, so that a later
             * `released` for a call that WAS live can still fall.
             */
            cues?.onRehydrated(frame.active_attempt.attempt_id, bridgedAt !== null);
            /**
             * Analytics: a reservation recovered after reconnect, not a fresh one —
             * `from_reconnect: true`. Never paired with `trackAgencyAttemptBridged`
             * here even when `bridgedAt` is already set: the API does not re-emit
             * `bridged` on reconnect (see the note above), so the true `bridged`
             * frame handler below is the only source of that event, and an
             * already-bridged recovery is out of scope for it — this event alone
             * covers reconnect visibility.
             *
             * The shift counter is bumped only if this hook instance never saw a
             * `reserved` for this attempt (a reload landing mid-attempt); at most
             * one attempt is ever live, so a counter that is already positive means
             * this one was already counted then.
             *
             * And reported at most once per attempt: `ready` restates full state on
             * EVERY reconnect, so a flaky socket recovering mid-call would otherwise
             * re-fire this for the same still-live attempt on each reconnect.
             */
            if (recoveredAttemptIdRef.current !== frame.active_attempt.attempt_id) {
              recoveredAttemptIdRef.current = frame.active_attempt.attempt_id;
              const priorAttemptCount =
                attemptCounterRef.current > 0 ? attemptCounterRef.current - 1 : 0;
              if (attemptCounterRef.current === 0) attemptCounterRef.current = 1;
              trackAgencyAttemptReserved({
                campaign_id: bootstrapRef.current?.campaign_id ?? '',
                attempt_number: attemptCounterRef.current,
                prior_attempt_count: priorAttemptCount,
                context_field_count: Object.keys(frame.active_attempt.context ?? {}).length,
                from_reconnect: true,
              });
            }
          } else {
            /**
             * **No `active_attempt` ⇒ the API holds no attempt for this session, so
             * neither may we.**
             *
             * The one line that closes the worst of the two defects. `live` is
             * otherwise cleared only by `released` — and on this path that frame was
             * delivered into a socket that no longer existed, which is the very
             * condition the API uses to decide to hand us a `missed_release` instead.
             * Leaving it set held a dead call open in every visible respect: the
             * `audio.sync` effect keys on `live?.attempt.attempt_id`, so the
             * microphone stayed armed with the browser's recording indicator lit and
             * `sending: true`; the rail ran a talk timer; the pad stayed unlocked;
             * and `panelAttempt` stayed truthy, which is what stopped `IdlePanel` —
             * the only renderer of the missed-release notice — from ever mounting.
             *
             * Clearing it here needs no companion change in the console: the audio
             * effect and the panel both already derive from `live`, so they disarm
             * and re-render on their own. (The reducer's `ready` clears it.)
             */
          }
          /**
           * ── The wrap-up window: `state` decides whether, `active_wrapup` decides
           * how long ────────────────────────────────────────────────────────────
           *
           * The split matters because the two fields have **different reach**.
           * `frame.state` comes from `rehydrateAgent`, which reads Redis
           * (`runtime.ts:124-126`) and is therefore authoritative across replicas.
           * `active_wrapup` comes from `WrapupManager.stateFor`, an in-process `Map`
           * (`wrapup-manager.ts:65-68`) — so a reconnect that lands on a different
           * replica reports `state: 'wrapup'` with **no** `active_wrapup`, even
           * though the agent genuinely is in wrap-up.
           *
           * Hence: absent `active_wrapup` is NOT evidence the window closed, and is
           * not treated as such. `state !== 'wrapup'` is.
           */
          if (frame.state === 'wrapup') {
            // A deadline only when this replica still owns the timer. Absent, the
            // anchor we already hold is kept (a reconnect without a page reload
            // keeps its countdown) and none is invented — no anchor renders the
            // `held` treatment, "ends when you act", which is the honest reading of
            // "the API says you are in wrap-up and cannot tell us until when".
            if (frame.active_wrapup) {
              /**
               * A consistency check with a real, if rare, subject: if the API names a
               * different attempt's wrap-up than the one whose panel we are holding,
               * ours is from a call that finished while the socket was away and the
               * contact details beside the pad belong to the wrong customer.
               */
            }
          } else {
            /**
             * **Wrap-up is over — the same clause `agent_state` applies, applied
             * here too.**
             *
             * `ready` is a state frame, and it was the one state frame that skipped
             * this. `agent_state{state !== 'wrapup'}` clears the anchor and the
             * retained attempt; the `agent_state` that would have said so was sent
             * into the dead socket, so without this the console reconnects still
             * believing in a wrap-up the API closed minutes ago — pad unlocked over a
             * window that will 409, `currentAttemptId` still pointing at the finished
             * attempt.
             *
             * **`release` does NOT unconditionally go with them**, and that is the
             * correction: it used to, and the rule was written when the wrap-up rail
             * was its only consumer. It has a second one now with a longer lifetime
             * — `IdlePanel` renders `releaseAccount(release)` for a
             * `requires_disposition` release that no wrap-up ever explained (the agent dispositioned mid-call, so `agent_state{wrapup}` and
             * `wrapup` are never sent and the state goes `on_call → available`). On
             * that path this console **witnessed** the release while connected, so
             * the API holds no `missed_release` to hand back, and clearing here left a
             * brief reconnect in the idle window silently deleting the only account
             * of the call the agent will ever get.
             *
             * So it is cleared on exactly the three conditions that mean something
             * newer or better accounts for the call, and kept otherwise:
             *
             *  - `previousState === 'wrapup'` — a wrap-up genuinely happened, so the
             *    release copy has already been the rail's label and sub-text for the
             *    whole window. Keeping it would re-state a finished call in the idle
             *    panel beside "Waiting for a call". This is the same clause, read off
             *    the same ref, as the `agent_state` handler's.
             *  - `frame.missed_release` — the API's own account of a release this
             *    session did not see is newer, and it is the authority. It also
             *    renders in the same slot, so two notices would compete.
             *  - `frame.active_attempt` — the API has handed us a *call*, so anything we
             *    still hold about a previous one is stale.
             *
             * The lifetime does not grow past "until the next call": `reserved`
             * clears it, exactly as it clears `missedRelease`, and for the same
             * reason. Pad route (b) is unaffected — it is gated on `retainedAttempt`,
             * which is cleared unconditionally above.
             */
          }
          /**
           * **Consumed-on-read on the API's side, so this is the only offer.** Stored,
           * never routed through the `released` handler: that one fires the
           * disconnect cue, clears `live` and opens wrap-up, all of which are
           * statements about a call ending *now*.
           *
           * Assigned unconditionally, like every other field here: a reconnect that
           * carries no missed release is the API saying there is none, and a stale
           * notice about an older call is the defect `reserved` already clears.
           */
          if (frame.missed_release) {
            trackAgencyAttemptReleased({
              campaign_id: bootstrapRef.current?.campaign_id ?? '',
              reason: frame.missed_release.reason,
              requires_disposition: frame.missed_release.requires_disposition,
              // `AgencyMissedRelease` carries no `bridged_at` — the API does not tell
              // us here whether the call connected before the socket dropped.
              was_bridged: false,
              talk_seconds: 0,
              missed: true,
            });
          }
          /**
           * ── The queued break, and the gap this used to record ────────────────
           *
           * This was a comment explaining that `ready` carried no `pending_state`, so
           * a break queued before the drop could not be restored from this frame and
           * `pendingBreakCode` was left alone rather than cleared. The API closed the
           * gap: `ready` now carries the same two fields as
           * `agent_state`, unconditionally — not only beside `active_wrapup`, because
           * a break can equally be queued from `reserved` or `on_call` and those
           * reconnects arrive with `active_attempt` instead.
           *
           * **The API `peek`s the queue to report it, so the break still lands.**
           * `releaseAgent` `take`s it when wrap-up ends and the agent leaves the
           * pool regardless of whether this console ever rendered the badge — which
           * is why restoring it is not cosmetic: the agent is being told, in advance,
           * that they are about to be pulled out of the pool by a request they may
           * not remember making.
           *
           * Assigned unconditionally like every other field on this snapshot:
           * absence is the API saying the queue is empty (cancelled while the socket was
           * away, or already applied), so keeping what we hold would leave a badge up
           * for a break that will never happen.
           */
          dispatch({
            type: 'ready',
            frame,
            // Opened HERE, from the present and the offset, never in the reducer.
            wrapup: frame.active_wrapup
              ? openWrapup(frame.active_wrapup, offsetRef.current, Date.now())
              : null,
          });
          return;
        }

        case 'agent_state': {
          // Authoritative. Any optimistic render is reconciled here and never
          // left standing.
          agentStateRef.current = frame.state;
          dispatch({ type: 'agent_state', frame });
          /**
           * **The queue, read off every transition — including the ones that say it
           * is empty.**
           *
           * `pending_state` absent is the API telling us nothing is queued, not it
           * declining to say: `/break/cancel` emits an `agent_state` with these
           * fields omitted for precisely that purpose. So this assigns
           * unconditionally rather than only when the fields are present — an
           * `if (frame.pending_state)` here would leave a cancelled break's pill on
           * screen forever, which is worse than never showing it.
           */
          if (frame.state !== 'wrapup') {
            // **`agent_state` is the one authority for wrap-up ENDING**.
            // Not the countdown reaching zero, not the wrap-up frame, and not the
            // disposition response — so there is no second frame to race and no
            // case where the console has to decide which of two frames won.
            /**
             * **`release` outlives wrap-up only when there was no wrap-up** (see above).
             *
             * A wrap-up that actually happened has already put the release copy in
             * front of the agent — it is the wrap-up rail's label and sub-text for
             * the whole window — so keeping the frame afterwards would re-state a
             * finished call in the idle panel beside "Waiting for a call".
             *
             * A release the agent never saw explained is the opposite case, and it
             * is the one the API's wrap-up early return produces: the
             * `agent_state{wrapup}` and `wrapup` frames are never sent, so the state
             * goes `on_call → available` and the panel empties with no account of the
             * call at all. Keeping the frame there is what lets `IdlePanel` say the
             * call ended. It is cleared by the next `reserved`, the same lifetime the
             * missed-release notice has, and for the same reason.
             *
             * The previous state is the reducer's, as of the last action — not the
             * rendered `agentState`, which is still pre-batch while these frames
             * arrive in one task.
             */
          }
          return;
        }

        case 'wrapup': {
          // **Captured ONCE, here, on the frame — never per render.** `openWrapup`
          // reads the present to compute the span the bar is scaled against, so
          // calling it on each repaint recaptures `totalMs` from a shrinking
          // remainder: the bar sits pinned at 100% and then snaps to zero while
          // the digits beside it count down correctly. That reads as a frozen UI,
          // and it survives review precisely because the digits look right.
          dispatch({ type: 'wrapup', anchor: openWrapup(frame.wrapup, offsetRef.current, Date.now()) });
          return;
        }

        case 'reserved': {
          // Three even pips, in-task. The agent has ~4s to read the panel.
          cues?.onReserved(frame.attempt.attempt_id);
          // The context push. Panel renders fully populated, in a connecting
          // state, with zero HTTP — there is no request that could lose the
          // race against the carrier answering.
          //
          // A new reservation always wins and replaces the panel, so any wrap-up
          // or release still on screen belongs to a call that is over — and so
          // does the account of a call the agent missed: it was about the previous
          // customer, and leaving it beside this one's details is the stale-notice
          // defect refused everywhere else on this screen.
          dispatch({ type: 'reserved', attempt: frame.attempt });
          /**
           * Analytics: the shift's running reservation tally. A local counter —
           * `frame.attempt.attempt_number` is the API's per-CONTACT retry count, not
           * a per-shift tally, so it is not reused here.
           */
          {
            const priorAttemptCount = attemptCounterRef.current;
            attemptCounterRef.current += 1;
            trackAgencyAttemptReserved({
              campaign_id: bootstrapRef.current?.campaign_id ?? '',
              attempt_number: attemptCounterRef.current,
              prior_attempt_count: priorAttemptCount,
              context_field_count: Object.keys(frame.attempt.context ?? {}).length,
              from_reconnect: false,
            });
          }
          // For `bridged`'s `ring_seconds` below — the wire carries no `reserved_at`.
          reservedAtRef.current = { id: frame.attempt.attempt_id, at: Date.now() };
          return;
        }

        // ── `countdown` REMOVED ────────────────────────
        //
        // This handled `{event:'countdown', attempt_id, seconds_remaining}` into
        // `live.secondsRemaining` / `live.ringing`. **The API emits that frame from
        // nowhere** — its `contracts.ts` declares the type and no call site sends
        // one — and nothing in this repo read either field: `StateRail` derives
        // "Ringing — get ready" from `bridgedAt === null`, which is the only
        // discriminator the API actually provides.
        //
        // So this was a handler that could not run, writing fields nobody read.
        // Deleted rather than left in place, because a live-looking handler is
        // how the next reader concludes the auto-connect countdown exists. It
        // does not exist on either side; building the client half alone would put
        // a counter on screen that never ticks. The frame's type is still
        // mirrored (see `AgencyStationCountdownFrame`), so a `countdown` on the
        // wire is typed traffic and falls to the diagnostic sink below like any
        // other frame the console does not act on.

        case 'bridged': {
          /**
           * THE connect moment. Nothing else may produce it.
           *
           * **The cue is scheduled here, in this task, BEFORE any React state is
           * committed** — not from a `useEffect` watching `bridgedAt`. An effect is
           * deferred and batched: under load it lands tens to hundreds of
           * milliseconds late, and the lateness is invisible in development with one
           * call in flight on an idle machine. the budget is 150ms from frame
           * receipt and the lag is the lag written to diagnostics on every connect, so a
           * regression to the effect shape shows up as data rather than as an
           * argument.
           */
          cues?.onBridged(frame.attempt_id, receivedAt);
          dispatch({ type: 'bridged', attemptId: frame.attempt_id, bridgedAt: frame.bridged_at });
          /**
           * Analytics. `0` when this hook instance never saw the `reserved` frame
           * for this attempt (a reconnect landing after the ring began) — there is
           * no `reserved_at` on the wire to fall back to, and fabricating one would
           * misstate how long the customer actually rang.
           */
          {
            const reservedAt =
              reservedAtRef.current?.id === frame.attempt_id ? reservedAtRef.current.at : null;
            const ringSeconds =
              reservedAt !== null ? Math.max(0, Math.round((Date.now() - reservedAt) / 1000)) : 0;
            trackAgencyAttemptBridged({
              campaign_id: bootstrapRef.current?.campaign_id ?? '',
              ring_seconds: ringSeconds,
              from_reconnect: false,
            });
          }
          return;
        }

        case 'released': {
          // Falling pair, and only if this attempt actually bridged — a cue for the
          // end of a call that never connected is a report of something that did not
          // happen.
          cues?.onReleased(frame.attempt_id);
          /**
           * Analytics, read off `liveRef` before the `released` dispatch below clears `live` —
           * `bridgedAt` is the only authority this hook has for "did the customer
           * actually answer", the same discriminator `LiveAttempt` documents.
           */
          {
            const current = liveRef.current;
            const wasBridged =
              current !== null &&
              current.attempt.attempt_id === frame.attempt_id &&
              current.bridgedAt !== null;
            // Through the corrected clock, like the rail's talk timer: `bridged_at`
            // is a server instant, and the raw client clock can be minutes out.
            const talkSeconds =
              wasBridged && current?.bridgedAt
                ? Math.round((elapsedSince(current.bridgedAt, offsetRef.current, Date.now()) ?? 0) / 1000)
                : 0;
            trackAgencyAttemptReleased({
              campaign_id: bootstrapRef.current?.campaign_id ?? '',
              reason: frame.reason,
              requires_disposition: frame.requires_disposition,
              was_bridged: wasBridged,
              talk_seconds: talkSeconds,
              missed: false,
            });
          }
          // The panel and pad stay up when there is still work to do. The call is
          // over — `live` goes — but the contact the agent is about to disposition
          // must not vanish from under them. The attempt is read off `liveRef`,
          // as it always was, and handed to the reducer.
          dispatch({
            type: 'released',
            frame,
            at: Date.now(),
            retain: liveRef.current?.attempt ?? null,
          });
          return;
        }

        case 'campaign_state': {
          // `dialing` and not `status`: deriving the predicate from `status`
          // forces every client to re-derive it, and they will disagree.
          dispatch({ type: 'campaign_state', dialing: frame.dialing });
          logDiagnostic('campaign_state', `${frame.status} (${frame.reason})`);
          return;
        }

        case 'pong': {
          pendingPingsRef.current = 0;
          /**
           * **This — not `onopen` — is what resets the backoff ladder.**
           *
           * `onopen` used to do it, which defeated `BACKOFF_MS` entirely: a
           * socket that opened and was immediately superseded had "succeeded" by
           * that measure, so every lap of the production loop started again at
           * 500 ms and the cadence held at ~1/s for half an hour. A `pong` is a
           * round trip — the one thing an open-then-superseded socket never
           * achieves — so it is the honest test of "this connection works".
           *
           * Safe because `onmessage` is generation-guarded: a STALE socket's
           * pong cannot reach here and reset the live socket's ladder. Without
           * that guard this line would be a new bug rather than a fix.
           *
           * No starvation risk on a healthy socket: the API answers `ping` with
           * `pong` unconditionally once attached, and `onopen` sends one
           * immediately rather than waiting out the first heartbeat interval.
           */
          retryCountRef.current = 0;
          // The two things `scheduleRetry` and the miss detector read instead of
          // inferring liveness from a tick count or a socket's open event.
          provedLiveRef.current = true;
          // Nothing is outstanding any more, so the silence clock stops.
          unansweredSinceRef.current = 0;
          // The heartbeat already carries what the clock correction needs, so it
          // costs nothing: `ping` sent `ts`, `pong` echoes it and adds `server_ts`.
          // A machine minutes out of NTP would otherwise render a countdown
          // minutes out — looking exactly like a product bug and reproducing on
          // nobody's development machine.
          let offsetMs: number | null = null;
          if (typeof frame.ts === 'number' && typeof frame.server_ts === 'number') {
            estimatorRef.current = estimatorRef.current.push({
              ts: frame.ts,
              server_ts: frame.server_ts,
              receivedAt: Date.now(),
            });
            offsetRef.current = estimatorRef.current.offsetMs;
            offsetMs = offsetRef.current;
          }
          // Misses cleared, and the offset moved when there was a sample.
          dispatch({ type: 'pong', offsetMs });
          return;
        }

        case 'manual_call': {
          /**
           * **A soft-phone call's every state change** (`docs/softphone.md` §4.1
           * step 5), and its restatement after a reconnect (step 9). The whole
           * row; the reducer keeps it unless it is older than the copy held.
           *
           * Guarded like `media`: the union says `call` is there, the socket is
           * not bound by the union, and a malformed frame must cost one frame.
           */
          const call = (frame as { call?: unknown }).call;
          if (!call || typeof call !== 'object' || typeof (call as { id?: unknown }).id !== 'string') {
            logDiagnostic('manual_call_malformed', JSON.stringify(frame).slice(0, 200));
            return;
          }
          const typed = frame.call;
          manualLiveRef.current = isCallLive(typed);
          dispatch({ type: 'manual_call', call: typed });
          logDiagnostic('manual_call', `${typed.id} ${typed.state}`);
          return;
        }

        case 'error': {
          // Non-fatal by contract; the socket stays open.
          dispatch({ type: 'error', frame });
          logDiagnostic('error', `${frame.code}: ${frame.message}`);
          return;
        }

        default: {
          // Bridge-originated `status`/`ended`, and anything the API adds later.
          // Diagnostic ONLY — never agent state, never a panel clear, never
          // any part of the connect cue.
          const unknown = frame as { event: string; status?: string; reason?: string };
          logDiagnostic(
            unknown.event,
            unknown.status ?? unknown.reason ?? JSON.stringify(frame).slice(0, 200),
          );
        }
      }
    },
    [logDiagnostic, cues, audioRef, bootstrapRef, liveRef],
  );

  const connect = useCallback(async () => {
    if (!bootstrap || !enabled) return;

    // A fresh bootstrap carries a fresh single-use token, and the first connect
    // of that bootstrap must use it. Keyed on bootstrap IDENTITY rather than done
    // in the connect effect, so it cannot be defeated by effect ordering or by
    // the effect re-running for some other reason.
    if (tokenBootstrapRef.current !== bootstrap) {
      tokenBootstrapRef.current = bootstrap;
      tokenSpentRef.current = false;
    }

    /**
     * This attempt now owns the hook. Everything below compares against it before
     * touching shared state, so a socket from an earlier attempt — still open,
     * still closing, or closing much later — cannot act on the hook's behalf.
     */
    const gen = ++generationRef.current;
    // Per-socket, so the next socket starts owing its own proof of liveness.
    provedLiveRef.current = false;
    // The incumbent goes first, deliberately. `connect()` can run concurrently
    // with itself (a scheduled retry landing on top of an effect re-run), and
    // without this the second call overwrote `socketRef` and left the first
    // socket open, attached, and holding a heartbeat interval nothing would ever
    // clear.
    const incumbent = socketRef.current;
    socketRef.current = null;
    abandon(incumbent);
    clearTimers();

    dispatch({ type: 'connection', connection: retryCountRef.current === 0 ? 'connecting' : 'reconnecting' });

    let url: string;
    if (!tokenSpentRef.current) {
      tokenSpentRef.current = true;
      url = bootstrap.station_ws_url;
    } else {
      // The token authenticates the UPGRADE and is single-use and short, so a
      // reconnect always needs a fresh one. Re-minting is cheap and deliberately
      // separate from bootstrap: a reconnect needs a token, not the whole
      // campaign config again.
      try {
        // Bounded — see `TOKEN_MINT_TIMEOUT_MS`. A rejection lands in the catch
        // below and walks the ordinary retry ladder; without the bound a hung
        // request left the hook with no socket, no timer and no way back.
        const minted = await withDeadline(
          mintStationToken(bootstrap.session_id, options.tenantId, options.accountId),
          TOKEN_MINT_TIMEOUT_MS,
          `token mint exceeded ${TOKEN_MINT_TIMEOUT_MS}ms`,
        );
        // The mint is an await, and neither `clearTimers()` nor the effect
        // cleanup can cancel one. Without this check a connect abandoned while
        // its token was in flight came back and opened a socket anyway — the
        // second socket that made the API supersede the first.
        if (gen !== generationRef.current) return;
        url = minted.station_ws_url;
      } catch (err) {
        if (gen !== generationRef.current) return;
        logDiagnostic('token_mint_failed', err instanceof Error ? err.message : 'unknown');
        trackAgencyStationTokenMintFailed({ retry_count: retryCountRef.current });
        scheduleRetry();
        return;
      }
    }

    const socket = new WebSocket(toAbsoluteWsUrl(url));
    socketRef.current = socket;

    socket.onopen = () => {
      // Guarded like every other handler: two overlapping connects would
      // otherwise both reach here, and the loser would overwrite `heartbeatRef`
      // — leaking the winner's interval to fire for the life of the page — and
      // report `open` over a newer socket's state.
      if (gen !== generationRef.current) return;
      // There is no longer a reset here — the ladder resets on `pong`, not on
      // open (see the `pong` case) — so this reports retries-since-the-last-proven
      // -live-socket rather than retries-to-reach-open. That is the more useful
      // number for the flap it now measures, and it is a deliberate change of
      // meaning rather than a leftover.
      pendingPingsRef.current = 0;
      dispatch({ type: 'missed_pings', count: 0 });
      dispatch({ type: 'connection', connection: 'open' });
      reportConnection('open', null);

      // Cleared, not stamped: the immediate ping below is what starts the clock.
      // Explicit because the ref outlives any one socket.
      unansweredSinceRef.current = 0;

      /**
       * One ping straight away, deliberately UNCOUNTED.
       *
       * Its answer is what resets the backoff ladder (see the `pong` case), and
       * without it that proof is a whole `heartbeat_ms` away — so a session that
       * blipped inside its first 10 s carried backoff it had not earned.
       *
       * Uncounted because counting it would move the give-up deadline from 30 s
       * after open to 20 s, breaking the symmetry with the API's own grace. (An
       * earlier version of this comment claimed it was to keep the connection pill on
       * "Connected" — that was wrong: the pill switches at two misses, so one
       * would not have moved it.)
       */
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
        // Uncounted, but it IS a ping and its silence counts — otherwise a socket
        // that opens and never answers looks infinitely fresh until the first
        // tick, and the give-up deadline slips by a whole interval.
        unansweredSinceRef.current = Date.now();
      }

      // Heartbeat cadence comes from the server. No client constant may
      // duplicate it, or the console and the server's lease drift the first
      // time either is retuned.
      heartbeatRef.current = setInterval(() => {
        if (gen !== generationRef.current) return;
        /**
         * Counted whether or not the frame can be sent. The old code returned
         * early when the socket was not OPEN, so a socket the browser had moved
         * to CLOSING stopped accumulating misses entirely and the third row
         * was unreachable — the detector disarmed itself in exactly the state it
         * exists to detect. A socket that is not OPEN will not answer either, so
         * it is a miss.
         */
        pendingPingsRef.current += 1;
        dispatch({ type: 'missed_pings', count: pendingPingsRef.current });

        /**
         * ── NEVER TEAR DOWN A LIVE CALL ON THIS TIMER ──────────────────────
         *
         * This socket IS the media leg. Media frames produce no `pong`, and
         * the API answers a ping only after a database read — so a slow (not
         * failed) read, or any stall in that path, stops the pongs on a socket
         * whose audio is still flowing perfectly. Giving up there closes the
         * socket, drops the microphone and arms the API's deferred hangup: an API
         * database slowdown would become a floor-wide simultaneous call drop.
         *
         * The API's own silent-station sweep refuses exactly this, in exactly these
         * words — "that would put a live customer on silence and arm the
         * deferred hangup, on the strength of a timer the *client* stopped"
         * (`runtime.ts`, `sweepSilentStations`). Its guard is `hasLiveAttempt`;
         * `liveRef` is this side's copy of the same fact, so the two ends now
         * hold the same policy instead of contradictory ones.
         *
         * The counting continues, so the pill still escalates and the give-up
         * lands as soon as the call is over — `released` clears `liveRef`, and
         * the next tick is at most one `heartbeat_ms` away.
         */
        /**
         * ── THE PING GOES OUT BEFORE ANY DECISION IS TAKEN ─────────────────
         *
         * It used to go out last, after two branches that could `return` — and
         * the live-call hold below is exactly such a branch. So the first tick
         * that held a stalled call stopped pinging altogether, which made the
         * hold self-defeating in the worst possible way: with no ping there is no
         * `pong`, with no pong the counter never clears, and the moment `released`
         * cleared `liveRef` the very next tick gave up. A guard written to protect
         * a live call instead guaranteed the station died the instant the call
         * ended, whether or not the line had recovered in the meantime.
         *
         * Sending first is also the honest order for the counter: it is counting
         * pings we have actually sent and not had answered.
         */
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ event: 'ping', ts: Date.now() }));
        }
        if (unansweredSinceRef.current === 0) unansweredSinceRef.current = Date.now();

        /**
         * ONE predicate for both decisions below, so the hold and the give-up
         * cannot drift apart — holding a condition different from the one being
         * held is how a hold quietly stops covering the case it was added for.
         *
         * `MISSED_PING_LIMIT` reads as a count and is applied here as a number of
         * intervals, which is what the 30 s is: three of them. The count in
         * `pendingPings` is now display only (the pill's escalation), exactly as
         * review asked — nothing decides on it.
         */
        const unansweredForMs = Date.now() - unansweredSinceRef.current;
        const silent = silentTooLong(
          unansweredSinceRef.current,
          Date.now(),
          bootstrap.intervals.heartbeat_ms,
        );

        if (silent && liveRef.current !== null) {
          // Held, not resolved: the counting and the pinging both continue, so a
          // line that recovers mid-call clears itself, and one that does not is
          // given up on as soon as `released` clears `liveRef`.
          logDiagnostic(
            'heartbeat_stalled_on_call',
            `${Math.round(unansweredForMs / 1000)}s without a pong held: a call is live`,
          );
          return;
        }
        if (silent) {
          giveUp('heartbeat', `${Math.round(unansweredForMs / 1000)}s without a pong`);
        }
      }, bootstrap.intervals.heartbeat_ms);
    };

    socket.onmessage = (event) => {
      /**
       * The guard is on the WHOLE message path, not just the liveness bookkeeping.
       * A stale socket's frames are not merely uninteresting — `handleFrame`
       * writes agent state, the break queue, the live attempt and the connect
       * cues, so a superseded socket replaying its view of the session could
       * overwrite the live one's. Dropping them is always correct: `ready`
       * restates the entire session state on every reconnect, so the live socket
       * has already said, or will say, everything the stale one had to.
       */
      if (gen !== generationRef.current) return;
      if (typeof event.data === 'string') handleFrame(event.data);
    };

    socket.onclose = (event) => {
      /**
       * The guard that closes the loop. This handler used to open with
       * `clearTimers()` and `socketRef.current = null` unconditionally, so a
       * socket closing LATE — after a newer one had opened — stopped the live
       * socket's heartbeat, broke `sendMedia` (dead air, mid-call) and scheduled
       * yet another connect.
       *
       * A stale close needs no handling at all: whoever superseded this socket
       * already retired it, and `abandon()` nulled these handlers in the common
       * case. This is the belt to that braces.
       */
      if (gen !== generationRef.current) return;
      clearTimers();
      socketRef.current = null;

      // The distinction the agent can act on: re-mint and retry, versus
      // re-bootstrap, versus stop. Retrying a dead session forever is
      // indistinguishable from a network problem and gives them nothing to do.
      if (event.code === AGENCY_STATION_CLOSE.SESSION_GONE) {
        logDiagnostic('close', '4404 session gone — re-bootstrap required');
        dispatch({ type: 'connection', connection: 'session_gone' });
        reportConnection('session_gone', event.code);
        return;
      }
      if (event.code === AGENCY_STATION_CLOSE.SUPERSEDED) {
        logDiagnostic('close', '4409 superseded by another window');
        dispatch({ type: 'connection', connection: 'superseded' });
        reportConnection('superseded', event.code);
        return;
      }

      logDiagnostic('close', `${event.code} ${event.reason || ''}`.trim());
      scheduleRetry(event.code);
    };

    socket.onerror = () => {
      if (gen !== generationRef.current) return;
      // `onclose` always follows, and it carries the code. Recording here and
      // reconnecting there avoids racing two handlers into two reconnects.
      logDiagnostic('socket_error', 'transport error');
    };

    /**
     * Stop trying, and say so, leaving `reconnect()` as the way back (the
     * big Reconnect, the reclaim). Bumping the generation first is what
     * makes the retired socket's later close inert.
     */
    function giveUp(cause: 'heartbeat' | 'flapping', detail: string): void {
      generationRef.current += 1;
      clearTimers();
      const dying = socketRef.current;
      socketRef.current = null;
      // Closed rather than left open: at three missed pings the API's 30 s
      // ownership key has already lapsed, but its in-process registry still
      // holds this socket — so `/available` would keep succeeding against a
      // station the agent cannot actually use. Closing makes the API's refusal
      // honest.
      abandon(dying, cause);
      connectStampsRef.current = [];
      logDiagnostic('disconnected', `${cause}: ${detail}`);
      dispatch({ type: 'connection', connection: 'disconnected' });
      // `cause`: the two causes have opposite runbooks — the line is bouncing
      // versus the API's pong path has stalled — and without it they emitted
      // identical payloads, so the incident was detectable and not triageable.
      // The in-tab diagnostics buffer never leaves the browser.
      reportConnection('disconnected', null, cause);
    }

    // `closeCode` is `null` for the one caller with no WebSocket close event to
    // report — the token-mint failure above, which schedules a retry off a
    // rejected HTTP call rather than a socket close.
    function scheduleRetry(closeCode: number | null = null): void {
      dispatch({ type: 'connection', connection: 'reconnecting' });
      reportConnection('reconnecting', closeCode);
      /**
       * The flap counter, written here rather than at connect: only a socket that
       * PROVED liveness and then died is evidence of flapping. See `FLAP_LIMIT`.
       * Pruned to the window on every pass, so the array cannot exceed the limit.
       */
      if (provedLiveRef.current) {
        const { stamps, flapping } = recordLiveThenDead(connectStampsRef.current, Date.now());
        connectStampsRef.current = stamps;
        if (flapping) {
          giveUp(
            'flapping',
            `${stamps.length} live-then-dead sockets in ${FLAP_WINDOW_MS / 1000}s`,
          );
          return;
        }
      }

      const delay = backoffFor(retryCountRef.current);
      retryCountRef.current += 1;
      retryRef.current = setTimeout(() => {
        void connect();
      }, delay);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bootstrap,
    enabled,
    handleFrame,
    clearTimers,
    logDiagnostic,
    reportConnection,
    options.tenantId,
    options.accountId,
  ]);

  useEffect(() => {
    if (!bootstrap || !enabled) return undefined;
    void connect();

    return () => {
      // Retiring the generation is what the old `closingRef` was reaching for and
      // could not express: the socket being closed here and the retry that must
      // not happen belong to the same attempt, so identifying the attempt is the
      // only thing that suppresses one without suppressing a legitimate later
      // reconnect. `connect()` setting `closingRef = false` synchronously — before
      // this close had even been delivered — is why the old flag failed.
      generationRef.current += 1;
      clearTimers();
      const socket = socketRef.current;
      socketRef.current = null;
      // 1000 so the server can tell a deliberate leave from a dropped
      // connection — they mean different things for the agent's session.
      abandon(socket, 'leaving');
    };
  }, [bootstrap, enabled, connect, clearTimers]);

  // ── `hangup` REMOVED ──────────────────────────────────────────
  //
  // This sent `{event:'hangup', attempt_id}` on the station socket, with the
  // comment "authenticated by the socket itself — an `agent` at level 5 cannot
  // reach the generic `/proxy/webrtc-call/:id/end` route, by design." The premise
  // was right and the conclusion never shipped: the API's station socket carries two
  // `message` listeners, one acting only on `ping` and one only on `media`, so
  // the frame fell off the end of both and was discarded silently.
  //
  // The agent-native HTTP route it was a "fallback" for did not exist either, so
  // the console's hang-up button did nothing by either path. The API now registers
  // `POST /agency/attempts/:id/hangup`, the API proxies it at
  // `agency.attempts.handle`, and `AgentConsolePage` calls that and surfaces the
  // rejection. Deleted rather than left as a no-op: a caller of this hook has no
  // way to tell a frame nobody reads from one that works.

  /**
   * The agent's voice, up the same socket.
   *
   * Stable identity (`[]`), because the capture graph is handed this once when a
   * call connects and the worklet's message port keeps it for the conversation.
   * A `sendMedia` that changed identity would either be stale in that closure or
   * force the capture graph to be rebuilt mid-call.
   *
   * `readyState` is checked rather than assumed: `WebSocket.send` on a CLOSING
   * or CLOSED socket throws, and this runs ~50 times a second inside an
   * `AudioWorkletNode` port handler where a throw is unattributable.
   */
  const sendMedia = useCallback((payload: string): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const frame = encodeAgencyMediaFrame(payload);
    // `null` ⇒ the API would have dropped it for length. Dropping it here instead
    // means the ceiling is one number in one place rather than a silent discard
    // downstream.
    if (frame === null) return false;
    socket.send(frame);
    return true;
  }, []);

  /**
   * The agent's own way back — the big **Reconnect** and the **Use this
   * window instead**, which are the same act: mint a token for this session and
   * attach. Reclaiming needs nothing more, because the session outlives the
   * socket and the API's registry hands the station to whoever attaches last.
   *
   * Deliberate intent, so the flap cap and the missed-ping count are cleared:
   * being refused because of what the previous minute did would make the button
   * a no-op in exactly the state that renders it.
   *
   * No close here — `connect()` retires the incumbent itself, and doing it twice
   * is how the old version raced.
   */
  const reconnect = useCallback(() => {
    retryCountRef.current = 0;
    connectStampsRef.current = [];
    pendingPingsRef.current = 0;
    dispatch({ type: 'missed_pings', count: 0 });
    void connect();
  }, [connect]);

  /**
   * Leaving the page: `beforeunload` only prompts, `pagehide` closes, and a
   * back/forward-cache `pageshow` reconnects — the reasoning for each lives in
   * `useStationUnloadGuard`. This hook supplies the two acts.
   */
  const retireForUnload = useCallback((): void => {
    // Bumping the generation is load-bearing on this path, not tidiness: the
    // socket closed here fires `onclose` asynchronously, and on a bfcache
    // restore that close can land AFTER `pageshow` has already reconnected.
    // Without the bump it would tear down the socket the restore just opened.
    generationRef.current += 1;
    clearTimers();
    const socket = socketRef.current;
    socketRef.current = null;
    abandon(socket, 'unload');
  }, [clearTimers]);
  useStationUnloadGuard({
    agentStateRef,
    busyRef: manualLiveRef,
    onPageHide: retireForUnload,
    onRestore: reconnect,
  });

  return {
    connection,
    agentState,
    agentStateSince,
    breakReasonCode,
    pendingBreakCode,
    pendingBreakStatements,
    live,
    retainedAttempt,
    /**
     * Derived rather than stored, so it cannot disagree with the three states it is
     * computed from. `live` wins: a new `reserved` always replaces the panel.
     *
     * **The wrap-up anchor is the third source and it is not decoration.** A socket
     * that reconnects mid-wrap-up gets `ready.active_wrapup` and nothing else —
     * the API has no attempt payload to hand back for a call that already ended, so
     * `live` and `retainedAttempt` are both null while the agent still owes a
     * disposition. Without this arm the console holds no attempt id, so notes
     * cannot hydrate and `submit()` returns early on `attemptId === null`: the
     * agent is left owing a disposition they have no way to send, and `/available`
     * refuses them until the `no_disposition` sweep closes the attempt.
     */
    currentAttemptId:
      live?.attempt.attempt_id ?? retainedAttempt?.attempt_id ?? wrapup?.attemptId ?? null,
    wrapup,
    clockOffsetMs,
    release,
    releasedAt,
    missedRelease,
    lastError,
    dialing,
    missedPings,
    diagnostics: diagnostics.entries,
    manualCall,
    reconnect,
    sendMedia,
  };
}

/** Moved to `utils/agencyStationWsUrl`; re-exported so existing imports keep working. */
export { toAbsoluteWsUrl } from '../utils/agencyStationWsUrl';
