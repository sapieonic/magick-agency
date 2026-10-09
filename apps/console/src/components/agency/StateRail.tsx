import type { CSSProperties } from 'react';
import { RailPresenceRegion } from './RailPresenceRegion';
import { WrapupTimer } from './WrapupTimer';
import { formatDuration } from '../../utils/agencyClock';
import { resolveReleaseCopy } from '../../utils/agencyReleaseCopy';
import { hasWrapup, type WrapupAnchor } from '../../utils/agencyWrapup';
import { VISUAL_CUE_SPECS } from '../../utils/agencyCues';
import type { ServerClock } from '../../hooks/useServerClock';
import type { CueFlash } from '../../hooks/useAgencyCues';
import type { StationConnection, LiveAttempt } from '../../hooks/useAgencyStation';
import type { AgencyAgentState, AgencyStationReleasedFrame } from '../../types/agency';
import styles from './StateRail.module.css';

/**
 * The State Rail — "the single most important component in the product".
 *
 * A full-width 64px band whose **tint, accent bar, label and sub-text together are
 * the agent's state**. Everything here is derived from authoritative frames; the
 * diagnostic `status`/`ended` vocabulary reaches the diagnostics sink and never a
 * pixel of this component.
 *
 * ── Composition, not merging ─────────────────────────────────────────────────
 * `RailPresenceRegion` and `WrapupTimer` are **composed in**, not inlined. That is
 * deliberate and it is about their tests, not their code: `RailPresenceRegion`'s
 * focus-survival property is asserted in isolation, paired with an assertion that
 * the elapsed timer is still advancing (because the inadmissible "fix" for the
 * focus bug is to stop the re-render). Merging it here dissolves both halves of
 * that pairing into a page test that would have to reconstruct them.
 *
 * ── The rail is the CALL's state ─────────────────────────────────────────────
 * A queued break does not touch it — no tint, no hatch, no sub-text — and neither
 * does a failed break-cancel. Both are the action bar's business. Stated here
 * because tinting the rail is the obvious "helpful" thing to do, and it would mean
 * the most important 64px on the screen is describing something that has not
 * happened yet.
 */

export type RailTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface RailDescription {
  tone: RailTone;
  label: string;
  detail: string | null;
}

export interface StateRailProps {
  agentState: AgencyAgentState;
  /** `agent_state.since` — the break elapsed anchor. */
  agentStateSince: string | null;
  breakReasonLabel: string | null;
  connection: StationConnection;
  live: LiveAttempt | null;
  release: AgencyStationReleasedFrame | null;
  /** Null means **no wrap-up frame** — not a held one. */
  wrapup: WrapupAnchor | null;
  dispositionSubmitted: boolean;
  dialing: boolean;
  clock: ServerClock;
  presenceBusy: boolean;
  onGoAvailable: () => void;
  onEndBreak: () => void;
  /**
   * The "no `agent_state` follows" copy, or null.
   *
   * It replaces the wrap-up **sub-text**, never the label: the state has not
   * changed — no authority has said it did — and overwriting the label would assert
   * a transition the frames never delivered.
   */
  waitingForDialer?: string | null;
  /**
   * The cue to show on the rail, for an agent who cannot hear the audible one
   * `null` — so nothing rendered — for a hearing agent with working
   * sound, which is the point: an unconditional flash 200 times a day is the visual
   * form of the haptics defect.
   */
  cueFlash?: CueFlash | null;
  /**
   * The way back from a station the console has stopped trying to hold — the
   * big **Reconnect** and the **Use this window instead**, which are one act
   * and so one handler.
   *
   * Optional so every existing caller and test is unaffected; absent means the
   * rail states the problem and offers nothing, which is what shipped and is the
   * defect: both of those states rendered copy alone, so an agent
   * whose station moved to another window had **no way back at all** and the only
   * recovery was a page reload.
   *
   * ── The second button is deliberately NOT here ────────────────────────
   * `window.close()` is refused by every browser for a tab the user opened
   * themselves, so a literal Close would be a dead control.
   *
   * An earlier version of this note also claimed a navigation was impossible
   * because it would send a level-5 `agent` into an `agency.supervise` shell.
   * **That was wrong**: `AgentConsolePage` already computes the role-correct
   * destination (`canExitToCampaign ? '/agency/campaigns/:id' :
   * agentLandingPath('station')`), so a "Leave this window" is implementable
   * today. It is left out only because the reclaim is what closes the dead end,
   * and it is recorded as outstanding rather than presented as impossible.
   *
   * A dimmed non-dismissible overlay is likewise outstanding — but the
   * half of it that mattered is now handled: the console behind a lost station no
   * longer accepts a disposition or a note (see `padUnlocked` in
   * `useAgencyConsole`), which was the hazard the overlay was meant to prevent.
   */
  onReconnect?: (() => void) | undefined;
  /**
   * `intervals.deferred_hangup_ms`
   * from the session bootstrap — how long the API holds a live call open while the
   * station reconnects. Null/absent when the bootstrap does not carry it.
   */
  deferredHangupMs?: number | null;
}

/**
 * Pure, so the whole tone/label/sub-text table is assertable without a DOM.
 *
 * Order matters: connection failures outrank agent state, because an agent whose
 * socket is gone must not be told they are "waiting for a call".
 */
export function describeRail(input: {
  agentState: AgencyAgentState;
  connection: StationConnection;
  live: LiveAttempt | null;
  release: AgencyStationReleasedFrame | null;
  wrapup: WrapupAnchor | null;
  dialing: boolean;
  breakReasonLabel: string | null;
  waitingForDialer?: string | null;
  deferredHangupMs?: number | null;
}): RailDescription {
  const { agentState, connection, live, release, wrapup, dialing, breakReasonLabel } = input;
  const waitingForDialer = input.waitingForDialer ?? null;

  if (connection === 'superseded') {
    return {
      tone: 'danger',
      label: 'Your station moved to another window',
      detail: 'You opened the dialer somewhere else. Only one can take calls.',
    };
  }
  if (connection === 'session_gone') {
    return { tone: 'danger', label: 'Session ended', detail: 'Rejoin the campaign to take calls.' };
  }
  /**
   * The third row of the connection states. It outranks agent state for the same reason
   * every other connection arm does — and more sharply here, because this is the
   * one connection state where the console has STOPPED trying: telling an agent
   * they are "waiting for a call" while nothing is listening is the exact
   * failure the ordering exists to prevent.
   *
   * Above `reconnecting` because they are mutually exclusive, and below the two
   * session-level terminals because those are the more specific diagnosis.
   */
  if (connection === 'disconnected') {
    /**
     * Mid-call is a different sentence, and getting this wrong was a real defect.
     * The copy is written for an idle agent — "you are not receiving calls"
     * — and this arm outranks the live-attempt arms below, so an agent four
     * minutes into a conversation was told nothing was reaching them while a talk
     * timer counted up beside it. The mid-call wording covers the connection
     * being lost *during* a call, and they answer the question the agent actually
     * has: can the customer hear me.
     *
     * No countdown is claimed. `deferred_hangup_ms` is served, but this side
     * cannot tell whether the window is still open, and a countdown that keeps
     * running past the hangup would be worse than none.
     */
    if (live) {
      return {
        tone: 'danger',
        label: 'Connection lost',
        detail: 'The customer can’t hear you right now. Reconnect to get back on the call.',
      };
    }
    return {
      tone: 'danger',
      label: 'Disconnected — you are not receiving calls',
      // Two steps, because it is two steps: the API released the agent when the
      // socket went, so reconnecting restores the station and `ready` reports
      // them `offline`. Promising one press left agents who pressed Reconnect and
      // walked away out of the pool for the rest of their break.
      detail: 'Reconnect, then go available to start taking calls.',
    };
  }
  if (connection === 'reconnecting') {
    // Never say "call ended" while a reconnect is still possible.
    /**
     * With a call live and the API's
     * `deferred_hangup_ms` known, the copy states the window as an UPPER BOUND —
     * "held for up to 30 seconds". Deliberately not a running countdown, for the
     * reason the `disconnected` arm above gives: this side cannot tell whether the
     * window is still open, and a countdown past the hangup would be worse than
     * none. A bound is true whenever it is shown. Without the value, or with no
     * call, the plain sentence is used.
     */
    const windowMs = input.deferredHangupMs ?? null;
    if (live && windowMs !== null && windowMs > 0) {
      const seconds = Math.round(windowMs / 1000);
      return {
        tone: 'warning',
        label: 'Reconnecting',
        detail: `Stay on the line — we’re reconnecting you. Your call is held for up to ${seconds} second${seconds === 1 ? '' : 's'}.`,
      };
    }
    return {
      tone: 'warning',
      label: 'Reconnecting',
      detail: 'Stay on the line — we’re reconnecting you.',
    };
  }

  if (live?.bridgedAt) {
    return { tone: 'success', label: 'On call', detail: live.attempt.phone_e164 };
  }
  if (live) {
    return { tone: 'warning', label: 'Ringing — get ready', detail: live.attempt.phone_e164 };
  }

  /**
   * Wrap-up. The shape came from `released.requires_disposition`, the words from the
   * reason mapping, and the clock — if there is one — from the wrap-up frame.
   *
   * `agentState === 'wrapup'` with **no anchor** is a legitimate state and renders
   * "Wrap-up" with no bar, no digits and **no waiting treatment**: it may simply
   * mean there is no wrap-up, and the console must not hang here.
   *
   * ── The third arm: `on_call` with the call already released ──────────────────
   * `released` clears `live` and the frame that says what comes next arrives
   * **separately** — the API sends `released` → `agent_state` → `wrapup` as three
   * frames, so between the first and the second `agentState` is still `on_call`
   * with nothing live behind it. Without this arm that window fell all the way
   * through to the `Offline` fallback: the most important 64px on the screen told
   * an agent who had just finished talking to a customer that they had not started
   * their shift, and on the truncated path from the API `#290` (where the
   * `agent_state{wrapup}` and `wrapup` frames are never sent at all) it was the
   * only thing the rail ever said about the call ending.
   *
   * It is deliberately keyed on `release` rather than on `agentState` alone: a
   * release is the authority that the call is over, and reading the release copy
   * here is the same table the wrap-up arm reads one line down. See the `on_call`
   * branch below for the no-release case.
   */
  if (agentState === 'wrapup' || hasWrapup(wrapup) || (agentState === 'on_call' && release !== null)) {
    const copy = release ? resolveReleaseCopy(release) : null;
    return {
      tone: 'warning',
      label: copy?.headline ?? 'Wrap-up',
      // The release reason described why the call ended. Once the disposition is
      // saved and the dialer has gone quiet, what the agent needs to know is that
      // they are waiting on us, not on themselves — so this takes the slot.
      detail: waitingForDialer ?? copy?.subtext ?? null,
    };
  }

  if (agentState === 'break') {
    return {
      tone: 'neutral',
      // "On break — Lunch". The reason is part of the state, not
      // a decoration, so a supervisor glancing at the floor reads it from here.
      label: breakReasonLabel ? `On break — ${breakReasonLabel}` : 'On break',
      detail: 'Press End break when you’re ready.',
    };
  }

  if (agentState === 'available') {
    return {
      tone: 'info',
      // Driven by `dialing`, never by `campaign_state.status` — deriving the
      // predicate from `status` forces every client to re-derive it and they will
      // disagree.
      label: dialing ? 'Waiting for a call' : 'Campaign paused — no calls will come through',
      detail: null,
    };
  }

  if (agentState === 'reserved') {
    return { tone: 'warning', label: 'Ringing — get ready', detail: null };
  }

  /**
   * `on_call` with neither a live attempt nor a release — the API's word for the state
   * and nothing to say about the call.
   *
   * Reachable from a `ready` that reports `on_call` with no `active_attempt`. The
   * point of the branch is not the copy, it is that **`on_call` may never render as
   * `Offline`**: criterion (a) is that every state has an unambiguous treatment, and
   * two states sharing one triple is precisely the ambiguity — an agent cannot tell
   * "your shift has not started" from "you are on a call we cannot show you", and
   * the two ask for opposite actions.
   */
  if (agentState === 'on_call') {
    return { tone: 'success', label: 'On call', detail: null };
  }

  return { tone: 'neutral', label: 'Offline', detail: null };
}

export function StateRail({
  agentState,
  agentStateSince,
  breakReasonLabel,
  connection,
  live,
  release,
  wrapup,
  dispositionSubmitted,
  dialing,
  clock,
  presenceBusy,
  onGoAvailable,
  onEndBreak,
  waitingForDialer = null,
  cueFlash = null,
  onReconnect,
  deferredHangupMs = null,
}: StateRailProps) {
  /**
   * The two states the agent can act their way out of, and the only two that get
   * controls here. Deliberately NOT `reconnecting` (the console is already doing
   * it, and a button that races its own retry is worse than no button) and not
   * `session_gone` (the session is genuinely over — reconnecting cannot help, and
   * the rail already says to rejoin).
   */
  const recoverable = connection === 'disconnected' || connection === 'superseded';
  const rail = describeRail({
    agentState,
    connection,
    live,
    release,
    wrapup,
    dialing,
    breakReasonLabel,
    waitingForDialer,
    deferredHangupMs,
  });

  /**
   * Anchored to `bridged_at`, the server instant, through the corrected clock —
   * never client receipt time and never a restart at 00:00.
   *
   * **Withheld on the terminal connection states**, which is not cosmetic: the
   * timer is independent of `connection`, so it kept counting beside "Disconnected
   * — you are not receiving calls" and beside "Your station moved to another
   * window". The rail then asserted two contradictory things in the same 64
   * pixels, and the timer was the more believable of the two.
   *
   * `reconnecting` deliberately keeps it: that is the case the uplink is built to
   * survive, the call may genuinely still be there, and stopping the clock would
   * tell the agent it had ended.
   */
  const callIsUnreachable =
    connection === 'disconnected' || connection === 'superseded' || connection === 'session_gone';
  const talkMs = !callIsUnreachable && live?.bridgedAt ? clock.since(live.bridgedAt) : null;

  return (
    <div
      className={`${styles.rail} ${styles[`tone_${rail.tone}`]}`}
      role="status"
      aria-live="polite"
      data-tone={rail.tone}
      // `break` and `offline` share a tint, so the hatch is what
      // separates "I have stepped away" from "I have not started". A second
      // channel, not a decoration.
      data-hatched={agentState === 'break' ? 'true' : undefined}
    >
      {/*
        ── The cue's visual channel ────────────────────────────
        Three things about this element are load-bearing:

        1. **The three cues must be told apart by sight**, and the differences are
           structural — pulse count, travel direction, duration — never colour,
           because an agent may be colour-blind and this is the channel that
           exists for the agent who has lost one already. The numbers come from
           `VISUAL_CUE_SPECS`, and the CSS reads the *numbers* (`--cue-pulses`,
           `--cue-duration`) plus `[data-cue-travel]`, never the cue's name, so
           the rendering cannot drift from the table.
        2. **`key` restarts the animation.** A CSS animation on an element that
           merely changes attributes does not replay, so a `disconnect` arriving
           inside the previous flash's window would silently show nothing. Keyed
           on cue *and* attempt, because both change independently.
        3. **`aria-hidden`, and the geometry never moves.** The rail is this
           screen's only polite live region and a screen-reader agent already has
           the assertive announcement region; a labelled element here would
           announce on every cue. It is absolutely positioned so a flash cannot
           shift a control by a pixel (frozen-geometry rule 1).
      */}
      {cueFlash ? (
        <span
          key={`${cueFlash.cue}:${cueFlash.attemptId}`}
          className={styles.cueFlash}
          data-testid="cue-flash"
          data-cue-flash={cueFlash.cue}
          data-cue-pulses={VISUAL_CUE_SPECS[cueFlash.cue].pulses}
          data-cue-travel={VISUAL_CUE_SPECS[cueFlash.cue].travel}
          style={
            {
              '--cue-pulses': VISUAL_CUE_SPECS[cueFlash.cue].pulses,
              '--cue-duration': `${VISUAL_CUE_SPECS[cueFlash.cue].durationMs}ms`,
              // One pulse's worth of the total, so N pulses fill the same window
              // the hook holds the attribute for.
              '--cue-pulse-duration': `${Math.round(VISUAL_CUE_SPECS[cueFlash.cue].durationMs / VISUAL_CUE_SPECS[cueFlash.cue].pulses)}ms`,
            } as CSSProperties
          }
          aria-hidden="true"
        />
      ) : null}

      <span className={styles.accent} aria-hidden="true" />
      <span className={styles.label} data-testid="rail-label">
        {rail.label}
      </span>
      {rail.detail ? (
        <span className={styles.detail} data-testid="rail-detail">
          {rail.detail}
        </span>
      ) : null}

      {/*
        The talk timer. `aria-hidden` for the same reason as the wrap-up digits: the
        rail is this screen's only polite live region, and a timer inside it would
        announce every 250ms for the length of every call.
      */}
      {talkMs !== null ? (
        <span className={styles.talkTimer} data-testid="talk-timer" aria-hidden="true">
          {formatDuration(talkMs)}
        </span>
      ) : null}

      {/* Only when a frame actually arrived. No frame ⇒ no clock, and no spinner. */}
      {hasWrapup(wrapup) ? (
        <WrapupTimer anchor={wrapup} now={clock.now} dispositionSubmitted={dispositionSubmitted} />
      ) : null}

      {/*
        Composed, never merged (see the note at the top). This is also the only
        control in the `break` state, and the region it lives in is rewritten four
        times a second — which is why it owns its own focus-survival tests.
      */}
      <RailPresenceRegion
        agentState={agentState}
        since={agentStateSince}
        clockOffsetMs={clock.offsetMs}
        breakReasonLabel={breakReasonLabel}
        busy={presenceBusy || connection !== 'open'}
        onGoAvailable={onGoAvailable}
        onEndBreak={onEndBreak}
      />

      {recoverable && onReconnect ? (
        <span className={styles.recovery}>
          {(
            <button type="button" className={styles.recoveryPrimary} onClick={onReconnect}>
              {/*
                Two labels for one act, because the agent's question is different.
                Superseded, they are choosing between windows and the spec words it
                as such; disconnected, there is no other window and "Reconnect" is
                simply what they want. Same handler either way — reclaiming IS
                attaching, since the API hands the station to whoever attaches last.
              */}
              {connection === 'superseded' ? 'Use this window instead' : 'Reconnect'}
            </button>
          )}
        </span>
      ) : null}

      {/*
        Suppressed in the recoverable states: "waiting" is false there — the
        console has stopped — and telling an agent to wait beside a button that
        says otherwise is how a screen gets ignored.
      */}
      {(agentState === 'offline' || agentState === 'break') &&
      connection !== 'open' &&
      !recoverable ? (
        <span className={styles.blockedReason}>Waiting for the station connection…</span>
      ) : null}
    </div>
  );
}
