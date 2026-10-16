import type {
  AgencyAgentState,
  AgencyReservedAttempt,
  AgencyStationReleasedFrame,
} from '../types/agency';
import type { LiveAttempt, StationConnection } from '../hooks/agencyStation/types';
import type { WrapupAnchor } from './agencyWrapup';

/**
 * Which of the console's three write surfaces are open: the microphone, the
 * disposition pad, and the notes field.
 *
 * Pure, so the rules — and the reasons the three differ — are assertable from
 * station state alone. `useAgencyConsole` reads it once per render.
 */

export const NOTES_DISABLED_COPY = 'Notes open when a call connects.';
export const PAD_DISABLED_COPY = 'available when connected';

export interface PadGateInput {
  connection: StationConnection;
  agentState: AgencyAgentState;
  live: LiveAttempt | null;
  retainedAttempt: AgencyReservedAttempt | null;
  release: AgencyStationReleasedFrame | null;
  wrapup: WrapupAnchor | null;
}

export interface PadGate {
  /** No audio may flow: the station is never coming back without the agent. */
  stationIsGone: boolean;
  /** Another authority for this session exists, or the session does not. */
  padHasRival: boolean;
  /**
   * The pad's window is open. `padEnabled` is this AND not waiting on the
   * dialer — that lock is the submit's, see `useDispositionSubmit`.
   */
  padUnlocked: boolean;
  /** Notes track the window, not the lock. */
  notesEnabled: boolean;
}

export function padGate(input: PadGateInput): PadGate {
  const { connection, agentState, live, retainedAttempt, release, wrapup } = input;

  /**
   * The audio gates' third input: a station that is never coming back.
   *
   * `live` is cleared by `released` and by nothing else. A **terminal** close
   * never touches it — `useAgencyStation`'s `onclose` sets `session_gone` (4404)
   * or `superseded` (4409) and returns — and the page renders a message rather
   * than unmounting. So on the ordinary "agent opens the console in a second
   * tab" path, tab 1 sat there with `live` still set, still capturing, for as
   * long as the tab existed: microphone held, recording indicator lit, and the
   * only control offered was Mute, which does not release the device.
   *
   * Terminal and **not** `reconnecting`: a reconnect is the case the uplink is
   * built to survive (`sendMedia` reads the socket ref at send time), and
   * dropping the microphone on a wifi blip would turn a recoverable gap into a
   * re-prompt mid-conversation.
   *
   * `disconnected` is included, and it is the one arm worth arguing. The comment
   * above turns on "terminal and not `reconnecting`", and `disconnected` is
   * terminal in exactly that sense: the console has stopped retrying and is
   * waiting for the agent — so holding the microphone open on it is precisely the
   * defect this predicate was written to fix.
   *
   * It is **not** the wifi blip the exclusion protects, but not for the reason an
   * earlier version of this comment gave. It claimed "30 s of silence or a minute
   * of flapping"; the flap arm has no minimum duration — six proven-live sockets
   * can die inside a few seconds — and the heartbeat arm now refuses to fire at
   * all while a call is live (`useAgencyStation`'s give-up guard). So what makes
   * this safe is that neither arm can be reached by a recoverable gap on a live
   * call, not that either takes a long time.
   */
  const stationIsGone =
    connection === 'session_gone' || connection === 'superseded' || connection === 'disconnected';
  /**
   * The narrower question the disposition pad asks: is there another authority for
   * this session that our write could collide with?
   *
   * `stationIsGone` is the right test for MEDIA — no audio may flow on a socket
   * that is not there — and the wrong one for the pad, which is HTTP and does not
   * need the socket at all. The three states differ in the way that decides it:
   *
   *  * `superseded` — another window holds the session, has its own pad, and ours
   *    may still *land*, racing theirs. That is's hazard. Lock.
   *  * `session_gone` — the API says the session does not exist, so the write would
   *    404 and a disabled control is the honest rendering of that. Lock.
   *  * `disconnected` — our socket died and NOTHING replaced it. There is no rival
   *    pad, the routes still work, and the agent may be mid-wrap-up with a
   *    countdown running. Locking here puts the only artefact of the call behind a
   *    control disabled for a reason that does not apply, and makes submitting a
   *    required disposition conditional on reconnecting inside a time-limited
   *    window. Leave it usable.
   *
   * This is the ordinary case rather than a corner, which is what makes it worth
   * the split: the heartbeat hold defers its give-up until `released` clears
   * `live`, so `disconnected` arrives at the START of wrap-up more often than at
   * any other moment in a shift.
   */
  const padHasRival = connection === 'session_gone' || connection === 'superseded';

  /**
   * Frame-bound: `bridged` opens the pad, and it stays open through a
   * `released` that requires a disposition. Nothing here reads `status`/`ended`.
   *
   * ── Three routes in, one latch out ──────────────────────────────────────────
   * The wrap-up unlock used to rest solely on `agent_state{state:'wrapup'}`, a
   * frame the API did not emit at all until this week. When it was missing the pad
   * greyed out the instant the call ended and stayed grey — `/available` then 409s
   * `attempt_not_dispositionable` and the agent is stuck until the sweep closes
   * the attempt, so **every disposition on a `requires_disposition` campaign was
   * lost that way**. One frame should not be able to do that again, so wrap-up is
   * derived from three independent sources and any one of them suffices:
   *
   *  (a) `agent_state` says `wrapup` — the frame path, now that the API sends it;
   *  (b) the `released` frame said `requires_disposition` — available *before*
   *      `agent_state` on the API's own ordering (`released` → `agent_state` →
   *      `wrapup`), so it opens the pad a tick earlier and survives that frame
   *      going missing entirely;
   *  (c) a wrap-up anchor exists and requires a disposition — the only route a
   *      socket that reconnected mid-wrap-up has, because `ready.active_wrapup`
   *      arrives with no attempt payload and no `released` behind it.
   *
   * ── Why they cannot disagree into a stuck pad ───────────────────────────────
   * A pad that never locks is a different bug, not a fix, so the three routes
   * share their OFF switches rather than each owning one. (a) and (b) are both
   * gated on `retainedAttempt`, and (c) on `wrapup`, and **all three fields are
   * cleared by every frame that can end a wrap-up**:
   *
   *   - `agent_state` with `state !== 'wrapup'` ('s single authority),
   *   - `reserved` (a new reservation always wins),
   *   - **`ready` with `state !== 'wrapup'`** — and this third one was missing.
   *
   * That omission was a real unlock over a closed window, not a theoretical one.
   * `released{requires_disposition:true}` → socket drops → the wrap-up lapses
   * server-side → the API emits `agent_state{available}` into the dead socket →
   * reconnect. `ready` restored `agentState` and touched nothing else, so (a) went
   * off while (b) stayed **on** — pad enabled, `currentAttemptId` still the
   * finished attempt. The agent wrote up a call into a window the API had closed and
   * the submit 409'd. Since `ready` is a full-state snapshot the fix belongs
   * there, not in a fourth condition here; see `stationReducer`'s `ready`.
   *
   * `missedRelease` is deliberately NOT a fourth route, and the reasoning is the
   * same one that makes the `ready` reconciliation necessary: it reports a call
   * that ended while the socket was away. When that call's wrap-up is still open
   * the API sends `active_wrapup` alongside it and (c) fires on its own; when it is
   * not, the API will refuse the disposition — so a pad unlocked from a
   * `missedRelease` would invite the agent to write into a window that has already
   * closed, which is exactly what the stale (b) was doing.
   */
  const inWrapupByState = retainedAttempt !== null && agentState === 'wrapup';
  const inWrapupByRelease =
    retainedAttempt !== null && release !== null && release.requires_disposition;
  const inWrapupByAnchor = wrapup !== null && wrapup.requiresDisposition;
  /**
   * ── A LOST STATION LOCKS THE PAD ───────────────────────────────────────────
   *
   * asks for the console behind the supersede screen to be inert, and says
   * why in one line: *"so there is no chance of the agent typing a note into a
   * dead tab."* Until this guard, `live` was cleared only by `released` — which a
   * terminal close never delivers — so a superseded window kept a fully enabled
   * disposition pad and a live notes autosave for a call it could no longer hear.
   *
   * That is worse than losing the note, because both routes are **HTTP**: the
   * session is still alive in the winning window, so the write may well *land*,
   * from a tab the product has declared dead, racing the other window's own pad.
   * Neither "lost" nor "saved" is an answer anyone would sign off.
   *
   * Newly reachable rather than theoretical: the API only started sending `4409` in
   * this same change, so `superseded` was previously almost unreachable.
   */
  const padUnlocked =
    !padHasRival
    && (Boolean(live?.bridgedAt) || inWrapupByState || inWrapupByRelease || inWrapupByAnchor);
  /**
   * **Notes track the window, not the lock.** The lock exists to stop a
   * second submit; the notes route is still accepted through wrap-up, and closing
   * the field would strand the agent's only artefact of the call behind a control
   * that was disabled for an unrelated reason.
   */
  const notesEnabled = padUnlocked;

  return { stationIsGone, padHasRival, padUnlocked, notesEnabled };
}
