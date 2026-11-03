import { useCallback, useRef, useState } from 'react';
import { redialFromWrapup } from '../api/agency';
import { useLatestRef } from './useLatestRef';
import { errorCode } from '../utils/agencyErrors';
import {
  REDIAL_IN_FLIGHT_COPY,
  redialRefusalCopy,
  redialRemainingCopy,
} from '../utils/agencyRedialCopy';
import { trackAgencyRedialRefused, trackAgencyRedialRequested } from '../analytics/events';
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
  /** The line beside the button: the remaining count, or "Redialing…". */
  statusLine: string | null;
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
}

const NO_RESULT: RedialResult = { attemptId: null, inFlight: false, refusal: null, exhausted: false };

export function useWrapupRedial(options: {
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | undefined;
  accountId: string | undefined;
  wrapup: WrapupAnchor | null;
  live: LiveAttempt | null;
  connection: StationConnection;
  /**
   * The outcome pad could be acted on now (unlocked, not waiting on the dialer,
   * not submitting, nothing saved yet). A redial is refused whenever the save is,
   * and once the save has landed there is no call left to redial.
   */
  padAvailable: boolean;
}): WrapupRedialState {
  const { bootstrap, tenantId, accountId, wrapup, live, connection, padAvailable } = options;

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
  const enabled =
    offered && (remaining ?? 0) > 0 && !current.inFlight && padAvailable && connection === 'open';

  /** The wrap-up attempt a request is out for — the synchronous double-press guard. */
  const pendingRef = useRef<string | null>(null);
  const latest = useLatestRef({ wrapupAttemptId, enabled, remaining, bootstrap });

  const isInFlight = useCallback(() => {
    const { wrapupAttemptId: onScreen } = latest.current;
    return onScreen !== null && pendingRef.current === onScreen;
  }, [latest]);

  const redial = useCallback(() => {
    const { wrapupAttemptId: attemptId, enabled: mayPress, remaining: left, bootstrap: boot } = latest.current;
    if (!boot || attemptId === null || !mayPress) return;
    if (pendingRef.current === attemptId) return;
    pendingRef.current = attemptId;
    setResult({ attemptId, inFlight: true, refusal: null, exhausted: false });
    trackAgencyRedialRequested({ campaign_id: boot.campaign_id, redial_remaining: left ?? 0 });

    redialFromWrapup(boot.session_id, attemptId, tenantId, accountId).catch((err: unknown) => {
      // Placed means waiting for `reserved`; only a refusal frees the controls.
      if (pendingRef.current === attemptId) pendingRef.current = null;
      const code = errorCode(err);
      setResult((prev) =>
        prev.attemptId === attemptId
          ? {
              ...prev,
              inFlight: false,
              refusal: redialRefusalCopy(err),
              exhausted: prev.exhausted || code === 'redial_limit_reached',
            }
          : prev,
      );
      trackAgencyRedialRefused({
        campaign_id: boot.campaign_id,
        code: code as AgencyActionErrorCode | null,
      });
    });
  }, [latest, tenantId, accountId]);

  return {
    offered,
    remaining,
    enabled,
    inFlight: current.inFlight,
    refusal: current.refusal,
    statusLine: !offered ? null : current.inFlight ? REDIAL_IN_FLIGHT_COPY : redialRemainingCopy(remaining ?? 0),
    redial,
    isInFlight,
  };
}
