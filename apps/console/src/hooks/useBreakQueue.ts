import { useCallback, useEffect, useState } from 'react';
import { setAgentBreak, cancelQueuedBreak } from '../api/agency';
import {
  trackAgencyBreakRequested,
  trackAgencyBreakRejected,
  trackAgencyQueuedBreakResolved,
} from '../analytics/events';
import { errorBody } from '../utils/agencyErrors';
import { resyncCatalog, numberKeysRemapped } from '../utils/agencyCatalogSync';
import { BREAK_REJECTED_COPY } from '../components/agency/BreakMenu';
import { useLatestRef } from './useLatestRef';
import type { AgencyAgentState, AgencyBreakReason, AgencySessionBootstrap } from '../types/agency';

/**
 * Requesting a break, the queued-break pill, and cancelling it.
 *
 * ── ONE source of truth for the queue ────────────────────────────────────────
 * The queue used to live twice: the station's `pendingBreakCode`, read off
 * frames, and a console copy in its own `useState`, written by the HTTP responses
 * and overwritten from the station by an effect watching the statement counter
 * (behind an `exhaustive-deps` suppression). Two cells for one fact, reconciled
 * after the render that disagreed.
 *
 * Now the station's value IS the queue, and a response the agent's own click
 * produced is an **override stamped with the statement count it was written
 * at**. It wins until the next frame that states the queue moves the counter, and
 * then the frame wins — the same ordering the effect produced ("the HTTP response
 * wins the instant after a click, then the frames confirm or correct it"), with
 * nothing to keep in step.
 */
export interface BreakQueueState {
  breakReasons: AgencyBreakReason[];
  /** The queued break's code, or null. */
  pendingBreakCode: string | null;
  requestBreak: (code: string) => void;
  breakRejection: string | null;
  breakBusy: boolean;
  cancelBreak: () => void;
  cancelling: boolean;
  cancelFailed: boolean;
  breakAlreadyStarted: boolean;
  /** A presence change retires the "already started" line. */
  clearBreakAlreadyStarted: () => void;
  /**
   * The disposition response's advisory said the queued break was promoted: the
   * pill has no subject left. Never touches the rail.
   */
  clearQueuedBreak: () => void;
}

export function useBreakQueue(options: {
  bootstrap: AgencySessionBootstrap | null;
  tenantId: string | undefined;
  accountId: string | undefined;
  agentState: AgencyAgentState;
  /** `UseAgencyStationResult.pendingBreakCode` / `.pendingBreakStatements`. */
  stationPendingBreakCode: string | null;
  stationPendingBreakStatements: number;
  /** An `unknown_break_reason` resync may move a bound key — the pad's warning. */
  onKeysRemapped: (remapped: boolean) => void;
  announce: (text: string) => void;
}): BreakQueueState {
  const {
    bootstrap,
    tenantId,
    accountId,
    agentState,
    stationPendingBreakCode,
    stationPendingBreakStatements,
    onKeysRemapped,
    announce,
  } = options;

  const [breakReasons, setBreakReasons] = useState<AgencyBreakReason[]>([]);
  const [breakBusy, setBreakBusy] = useState(false);
  const [breakRejection, setBreakRejection] = useState<string | null>(null);
  /** The click's own answer, valid only while no newer frame has stated the queue. */
  const [override, setOverride] = useState<{ code: string | null; atStatement: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [breakAlreadyStarted, setBreakAlreadyStarted] = useState(false);

  /**
   * The statement count at the moment a response lands — read at that moment,
   * not closed over by the request that was sent renders ago.
   */
  const statementsRef = useLatestRef(stationPendingBreakStatements);
  const writeQueue = useCallback(
    (code: string | null) => setOverride({ code, atStatement: statementsRef.current }),
    [statementsRef],
  );

  useEffect(() => {
    if (!bootstrap) return;
    // What bootstrap advertises IS the accepted set: the API serves its six built-ins
    // when the campaign configures none, so this is never empty in practice.
    setBreakReasons(bootstrap.break_reasons);
  }, [bootstrap]);

  /**
   * **Every authoritative frame restates the queue, and this trusts it.**
   *
   * The pill used to be fed only by the HTTP responses below, which made a queued
   * break invisible — and therefore uncancellable — to any console that did not
   * itself issue the request: a supervisor-queued break, a second window, or the
   * agent's own break followed by a socket blip. The API carries `pending_state` on
   * the frames for exactly that reason — on `agent_state`, and on `ready` too.
   *
   * Keyed on the statement counter and not on the code, because **absence is the
   * signal**: `/break/cancel` emits an `agent_state` with the pending fields
   * omitted precisely to say the queue is now empty, and only a marker that moves
   * on every statement can tell "the API says nothing is queued" from "no frame
   * has spoken yet". `agentStateSince` was that marker once and could not stay —
   * `ready` carries no `since`, so a reconnect restating the queue never moved it.
   *
   * The HTTP response still wins the instant after a click (it lands first and the
   * agent needs immediate feedback); the frames then confirm or correct it, which
   * is the same "socket is the authority" ordering the rail follows.
   */
  const pendingBreakCode =
    override !== null && override.atStatement === stationPendingBreakStatements
      ? override.code
      : stationPendingBreakCode;

  /** The queued break resolved itself the moment `agent_state` moved to `break`. */
  useEffect(() => {
    if (agentState === 'break') {
      writeQueue(null);
      setCancelFailed(false);
    }
  }, [agentState, writeQueue]);

  const requestBreak = useCallback(
    async (code: string) => {
      if (!bootstrap) return;
      setBreakBusy(true);
      setBreakRejection(null);
      setBreakAlreadyStarted(false);
      try {
        const response = await setAgentBreak(bootstrap.session_id, code, tenantId, accountId);
        /**
         * **`break_reason`, not `pending_break_reason`** — the mirror carried the
         * wrong name and the API has never sent it on this body, so this read
         * `undefined` every time and the `?? code` fallback quietly carried the
         * pill. It worked only because the code was already in hand here; nothing
         * else on this path would have been so lucky.
         *
         * No longer the ONE place a queued break is rendered from, either: the
         * socket carries `pending_state` on `agent_state`, and a frame corrects or
         * contradicts whatever this response said (see the override above). The
         * response stays because it is the fastest answer to the agent's own click
         * — a pill that waits for the next transition frame would look like the
         * click did nothing.
         */
        writeQueue(response.pending_state ? (response.break_reason ?? code) : null);
        trackAgencyBreakRequested({
          campaign_id: bootstrap.campaign_id,
          reason_index: breakReasons.findIndex((r) => r.code === code),
          is_paid: breakReasons.find((r) => r.code === code)?.is_paid ?? null,
          queued: Boolean(response.pending_state),
          agent_state: agentState,
          // `requestBreak` is only ever invoked from a `BreakMenu` reason click —
          // the `B` shortcut only opens the menu, it does not select a reason.
          method: 'click',
        });
      } catch (err) {
        const body = errorBody(err);
        if (body?.code === 'unknown_break_reason' && body.allowed_codes) {
          const next = resyncCatalog(breakReasons, body.allowed_codes);
          // `boundCount: 0` — the break menu binds no number keys, so it can never
          // warn about a remap.
          onKeysRemapped(numberKeysRemapped(breakReasons, next, 0));
          setBreakReasons(next);
          setBreakRejection(BREAK_REJECTED_COPY);
          trackAgencyBreakRejected({
            campaign_id: bootstrap.campaign_id,
            code: 'unknown_break_reason',
            catalog_resynced: true,
          });
        } else {
          setBreakRejection(body?.message ?? 'That break could not be started.');
          trackAgencyBreakRejected({ campaign_id: bootstrap.campaign_id, code: 'other', catalog_resynced: false });
        }
      } finally {
        setBreakBusy(false);
      }
    },
    [bootstrap, tenantId, accountId, breakReasons, agentState, writeQueue, onKeysRemapped],
  );

  const cancelBreak = useCallback(async () => {
    if (!bootstrap || cancelling) return;
    setCancelling(true);
    setCancelFailed(false);
    try {
      const response = await cancelQueuedBreak(bootstrap.session_id, tenantId, accountId);
      // No optimism: the pill stays until the response says the queue is empty. A
      // pill that vanishes on click and reappears on a 500 teaches the agent to
      // distrust it.
      writeQueue(response.pending_state ? (response.break_reason ?? null) : null);
      if (!response.pending_state) {
        // The break was actually cancelled here, not merely restated by an
        // already-empty queue — this call is the one that emptied it.
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'cancelled' });
      }
    } catch (err) {
      const body = errorBody(err);
      if (body?.code === 'break_already_applied') {
        /**
         * **Not an error path at all.** The queued break was promoted to a real one
         * — the ordinary outcome, because a break applies at the end of wrap-up and
         * that is exactly when the agent is finishing their disposition and reaching
         * for the ✕.
         *
         * "Try again" is the one thing we must not say: retrying can never succeed,
         * because its subject no longer exists. The pill goes, the rail moves to
         * `break` on `agent_state` as always, and the recovery offered is
         * `End break` — which we do NOT call on their behalf. They asked to cancel
         * a queued break; turning that into "end the break you are now on" is a
         * different decision that may not be what they want.
         */
        writeQueue(null);
        setBreakAlreadyStarted(true);
        announce('Your break already started.');
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'already_applied' });
      } else {
        // The break is still queued, which is the truth, and pressing ✕ again is
        // the right next action.
        setCancelFailed(true);
        announce("Couldn't cancel. Try again.");
        trackAgencyQueuedBreakResolved({ campaign_id: bootstrap.campaign_id, outcome: 'cancel_failed' });
      }
    } finally {
      setCancelling(false);
    }
  }, [bootstrap, tenantId, accountId, cancelling, writeQueue, announce]);

  const clearBreakAlreadyStarted = useCallback(() => setBreakAlreadyStarted(false), []);
  const clearQueuedBreak = useCallback(() => writeQueue(null), [writeQueue]);

  return {
    breakReasons,
    pendingBreakCode,
    requestBreak: (code: string) => void requestBreak(code),
    breakRejection,
    breakBusy,
    cancelBreak: () => void cancelBreak(),
    cancelling,
    cancelFailed,
    breakAlreadyStarted,
    clearBreakAlreadyStarted,
    clearQueuedBreak,
  };
}
