import { useCallback, useState } from 'react';
import { hangupAttempt } from '../../../api/agency';
import { useLatestRef } from '../../../hooks/useLatestRef';
import { hangupFailureCopy } from '../../../utils/agencyDncCopy';
import { errorCode } from '../../../utils/agencyErrors';
import { trackAgencyHangupRequested, trackAgencyHangupFailed } from '../../../analytics/events';
import type { LiveAttempt } from '../../../hooks/useAgencyStation';
import type { ServerClock } from '../../../hooks/useServerClock';
import type { AgencyActionErrorCode, AgencySessionBootstrap } from '../../../types/agency';

/**
 * Hanging up the live call, and saying so when it did not work.
 *
 * Split out of `AgentConsolePage`. The gesture itself (hold, or `E`,`E`) is
 * `HoldToConfirmButton`'s; this is what the gesture fires.
 */
export interface Hangup {
  hangup: () => void;
  /** The failure for the call on screen now, or null. */
  hangupFailure: string | null;
}

export function useHangup({
  live,
  bootstrap,
  tenantId,
  accountId,
  clock,
}: {
  live: LiveAttempt | null;
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | null;
  accountId: string | null;
  clock: ServerClock;
}): Hangup {
  const liveAttemptId = live?.attempt.attempt_id ?? null;
  /**
   * Why a hang-up can be reported as failed at all.
   *
   * There was nowhere to put this before, because the rejection was swallowed —
   * and it was swallowed on the reasoning that the socket frame had already done
   * the job. Neither path worked, so the button's only feedback was the
   * `released` frame that was never coming, and the agent was left holding a
   * live call with a button that looked like it had fired.
   *
   * **Tagged with the attempt it is about**, and shown only while that attempt is
   * the live one. A failure notice must not outlive the call it describes, and
   * `live` is deliberately the right scope *here*, where the DNC result needs the
   * panel's: every sentence `hangupFailureCopy` can produce ends in "you are
   * still connected", which stops being true the instant `released` lands. A
   * notice that outlived the call would be telling the agent they are on a call
   * that is over. (This replaces an effect that cleared it on every change of
   * the live attempt.)
   */
  const [failure, setFailure] = useState<{ attemptId: string; message: string } | null>(null);
  const hangupFailure = failure !== null && failure.attemptId === liveAttemptId ? failure.message : null;

  /**
   * The **live** attempt as of *now*, for the hang-up rejection to check itself
   * against.
   *
   * A ref rather than the closed-over value: the rejection resolves after the
   * render that created the handler, and a new `reserved` may have landed in
   * between. Reporting the previous call's failure over the new one is the same
   * stale-response hazard refuses for dispositions.
   */
  const liveAttemptRef = useLatestRef(liveAttemptId);

  const hangup = useCallback(() => {
    const attemptId = live?.attempt.attempt_id;
    if (!attemptId) return;
    setFailure(null);
    trackAgencyHangupRequested({
      campaign_id: bootstrap?.campaign_id ?? '',
      was_bridged: Boolean(live?.bridgedAt),
      // Through the corrected clock, as the rail's talk timer is — `bridged_at`
      // is a SERVER instant, and against the raw client clock a machine 10s fast
      // reported ten seconds the agent never talked.
      talk_seconds: live?.bridgedAt ? Math.floor((clock.since(live.bridgedAt) ?? 0) / 1000) : 0,
    });
    /**
     * **The HTTP route is the only hangup path**.
     *
     * This used to send the station socket's `hangup` control frame as the
     * primary and treat the HTTP call as belt-and-braces, swallowing its
     * rejection so "a failed fallback must not surface as an error for a hang-up
     * that worked". Exactly backwards: the frame was read by neither listener on
     * that socket and the API registered no route, so the HTTP call was the only
     * one that could work — and it 404'd, silently, into that same catch. The
     * agent's hang-up button did nothing and said nothing.
     *
     * So the rejection is surfaced now. That is a fix only because the call is
     * real; making this catch visible on its own would have converted a silent
     * no-op into a loud one.
     *
     * **No automatic retry** — a retry landing after a new `reserved` hangs up a
     * different customer, the same shape as the stale disposition
     * response forbids. The agent retries by holding the button again.
     */
    void hangupAttempt(attemptId, tenantId ?? undefined, accountId ?? undefined).catch((err: unknown) => {
      // Guarded against a stale response: by the time this rejects the agent may
      // already be on a different call, and an error about the previous one is
      // worse than none.
      if (liveAttemptRef.current !== attemptId) return;
      setFailure({ attemptId, message: hangupFailureCopy(err) });
      // Same structured-code read `hangupFailureCopy`/`dncFailureCopy` use —
      // `details.code`, never `err.message`.
      const code = errorCode(err);
      trackAgencyHangupFailed({
        campaign_id: bootstrap?.campaign_id ?? '',
        code: code !== null ? (code as AgencyActionErrorCode) : 'unknown',
      });
    });
  }, [live?.attempt.attempt_id, live?.bridgedAt, tenantId, accountId, bootstrap, clock, liveAttemptRef]);

  return { hangup, hangupFailure };
}
