import { useCallback, useRef, useState } from 'react';
import { redialFromWrapup } from '../api/agency';
import { useLatestRef } from './useLatestRef';
import { errorCode, errorStatus } from '../utils/agencyErrors';
import {
  PERMANENT_REDIAL_REFUSALS,
  REDIAL_DISABLED_COPY,
  REDIAL_IN_FLIGHT_COPY,
  redialRefusalCopy,
  redialRemainingCopy,
} from '../utils/agencyRedialCopy';
import { trackAgencyRedialRefused, trackAgencyRedialRequested } from '../analytics/events';
import type { RedialCarryRecorder } from './useRedialCarry';
import type { LiveAttempt, StationConnection } from './agencyStation/types';
import type { WrapupAnchor } from '../utils/agencyWrapup';
import type { AgencyActionErrorCode, AgencySessionBootstrap } from '../types/agency';

/**
 * Wrap-up redial (`POST /sessions/:id/redial`): the Redial button beside the
 * outcome pad, while a connected call's outcome is still owed.
 *
 * ── Whether it is offered ───────────────────────────────────────────────────
 * The wrap-up frame's `redial_remaining` is the one answer, per wrap-up: absent or
 * `null` hides the button, `0` shows it disabled ("No redials left"), more shows it
 * enabled with the count. The bootstrap's `allow_wrapup_redial` is the campaign's
 * setting at join and is not read here — the server folds it into the frame, along
 * with whether an outcome is owed at all.
 *
 * ── In flight ───────────────────────────────────────────────────────────────
 * From the press until the redial's `reserved` arrives the button and the pad's
 * submit are both refused, so the agent cannot save an outcome on the call they
 * just redialed, or redial twice. A success does NOT end the wait: the call's
 * progress is the socket's, and `reserved` (which replaces the wrap-up) is what
 * ends it. A refusal ends it at once and states why; the pad is usable again.
 *
 * Once the 200 lands the server has stopped the wrap-up timer (`countdownStopped`),
 * so the console stops showing a countdown that no longer ends anything.
 *
 * ── Disabled, and saying why ────────────────────────────────────────────────
 * The line beside the button is the count only while the button can be pressed.
 * Disabled, it states the reason instead (`REDIAL_DISABLED_COPY`): in flight, none
 * left, refused for good, the outcome saving or saved, the socket not open, the
 * campaign not dialing. A refusal that holds for the rest of the wrap-up
 * (`PERMANENT_REDIAL_REFUSALS`) keeps the button disabled until the next one.
 *
 * The result is tagged with the wrap-up's attempt and read only while that wrap-up
 * is the one on screen with no call live, the same lifetime rule `useDncAction`
 * applies: a new wrap-up (a redial that failed before connecting opens one on the
 * NEW attempt) or a live call retires it without an effect to reset it.
 */
export interface WrapupRedialState {
  /** The wrap-up offers redial: render the button (possibly disabled). */
  offered: boolean;
  /** Redials left for this wrap-up, or null when not offered. */
  remaining: number | null;
  /** The button may be pressed now. */
  enabled: boolean;
  /** A redial request is out, or placed and waiting for its `reserved`. */
  inFlight: boolean;
  /** The refusal of the last press, stated. Null when there is none. */
  refusal: string | null;
  /**
   * The line beside the button: the remaining count while it can be pressed,
   * otherwise why it cannot ("Redialling…", "No redials left", ...).
   */
  statusLine: string | null;
  /** The redial is placed (200): the server stopped this wrap-up's timer. */
  countdownStopped: boolean;
  redial: () => void;
  /**
   * Synchronous: a redial is in flight for the wrap-up on screen. For the
   * disposition submit's guard, which can be reached twice in one task (the notes
   * field's `Ctrl+Enter`, then the window's) before React state could say so.
   */
  isInFlight: () => boolean;
}

interface RedialResult {
  attemptId: string | null;
  inFlight: boolean;
  refusal: string | null;
  /** `redial_limit_reached` came back: the frame's count is stale, treat it as 0. */
  exhausted: boolean;
  /** A refusal that holds for the rest of this wrap-up (`PERMANENT_REDIAL_REFUSALS`). */
  blocked: boolean;
  /** The 200 came back: the dial is placed and the wrap-up timer stopped. */
  placed: boolean;
}

const NO_RESULT: RedialResult = {
  attemptId: null,
  inFlight: false,
  refusal: null,
  exhausted: false,
  blocked: false,
  placed: false,
};

/**
 * Why the outcome pad cannot be acted on, as far as redial cares: the outcome is
 * being saved, it is saved (or the console waits on the dialer after the save), or
 * the pad is locked outright.
 */
export type RedialPadBlock = 'saving' | 'saved' | 'locked';

export function useWrapupRedial(options: {
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | undefined;
  accountId: string | undefined;
  wrapup: WrapupAnchor | null;
  live: LiveAttempt | null;
  connection: StationConnection;
  /** `campaign_state.dialing`: the server refuses a redial on a campaign that is not running. */
  dialing: boolean;
  /**
   * Why the outcome pad cannot be acted on now, or null when it can. A redial is
   * refused whenever the save is, and once the save has landed there is no call
   * left to redial.
   */
  padBlock: RedialPadBlock | null;
  /** The page's assertive announcement: "Redialling…" is the press's direct result. */
  announce: (text: string) => void;
  /** Lets the notes draft and the panel follow the press (`useRedialCarry`). */
  carry: RedialCarryRecorder;
}): WrapupRedialState {
  const { bootstrap, tenantId, accountId, wrapup, live, connection, dialing, padBlock, announce, carry } = options;

  const [result, setResult] = useState<RedialResult>(NO_RESULT);
  const wrapupAttemptId = live === null && wrapup !== null ? wrapup.attemptId : null;
  const current = result.attemptId !== null && result.attemptId === wrapupAttemptId ? result : NO_RESULT;

  const offered = wrapupAttemptId !== null && wrapup !== null && wrapup.redialRemaining !== null;
  const remaining = offered ? (current.exhausted ? 0 : (wrapup?.redialRemaining ?? 0)) : null;
  /**
   * `connection === 'open'` as well: the redial is carried on this station's socket,
   * so placing one while it is reconnecting dials a customer the agent cannot hear.
   * The server refuses that case too (`redial_blocked`); this keeps the press away.
   */
  const disabledReason: string | null = !offered
    ? null
    : current.inFlight
      ? REDIAL_IN_FLIGHT_COPY
      : (remaining ?? 0) <= 0
        ? redialRemainingCopy(0)
        : current.blocked
          ? REDIAL_DISABLED_COPY.blocked
          : padBlock !== null
            ? REDIAL_DISABLED_COPY[padBlock]
            : connection !== 'open'
              ? REDIAL_DISABLED_COPY.connection
              : !dialing
                ? REDIAL_DISABLED_COPY.notDialing
                : null;
  const enabled = offered && disabledReason === null;

  /** The wrap-up attempt a request is out for — the synchronous double-press guard. */
  const pendingRef = useRef<string | null>(null);
  const latest = useLatestRef({ wrapupAttemptId, enabled, remaining, bootstrap, announce, carry });

  const isInFlight = useCallback(() => {
    const { wrapupAttemptId: onScreen } = latest.current;
    return onScreen !== null && pendingRef.current === onScreen;
  }, [latest]);

  const redial = useCallback(() => {
    const {
      wrapupAttemptId: attemptId,
      enabled: mayPress,
      remaining: left,
      bootstrap: boot,
      announce: say,
      carry: recorder,
    } = latest.current;
    if (!boot || attemptId === null || !mayPress) return;
    // The synchronous guard: two presses in one task both see this render's `enabled`.
    if (pendingRef.current === attemptId) return;
    pendingRef.current = attemptId;
    setResult({ ...NO_RESULT, attemptId, inFlight: true });
    recorder.pressed(attemptId);
    say(REDIAL_IN_FLIGHT_COPY);
    trackAgencyRedialRequested({ campaign_id: boot.campaign_id, redial_remaining: left ?? 0 });

    redialFromWrapup(boot.session_id, attemptId, tenantId, accountId).then(
      (response) => {
        // Placed means waiting for `reserved`, which ends the wait; the timer is stopped.
        recorder.placed(response);
        setResult((prev) => (prev.attemptId === attemptId ? { ...prev, placed: true } : prev));
      },
      (err: unknown) => {
        // A refusal frees the controls. So does no answer at all, though the redial
        // may have been placed: the copy says so rather than claiming it failed.
        if (pendingRef.current === attemptId) pendingRef.current = null;
        const code = errorCode(err);
        const status = errorStatus(err);
        recorder.settled(attemptId, status !== null && status < 500);
        setResult((prev) =>
          prev.attemptId === attemptId
            ? {
                ...prev,
                inFlight: false,
                refusal: redialRefusalCopy(err),
                exhausted: prev.exhausted || code === 'redial_limit_reached',
                blocked: prev.blocked || (code !== null && PERMANENT_REDIAL_REFUSALS.has(code)),
              }
            : prev,
        );
        trackAgencyRedialRefused({
          campaign_id: boot.campaign_id,
          code: code as AgencyActionErrorCode | null,
        });
      },
    );
  }, [latest, tenantId, accountId]);

  return {
    offered,
    remaining,
    enabled,
    inFlight: current.inFlight,
    refusal: current.refusal,
    statusLine: !offered ? null : (disabledReason ?? redialRemainingCopy(remaining ?? 0)),
    countdownStopped: current.placed,
    redial,
    isInFlight,
  };
}
