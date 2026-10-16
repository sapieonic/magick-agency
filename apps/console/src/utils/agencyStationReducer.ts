import type {
  AgencyAgentState,
  AgencyMissedRelease,
  AgencyReservedAttempt,
  AgencyStationAgentStateFrame,
  AgencyStationErrorFrame,
  AgencyStationReadyFrame,
  AgencyStationReleasedFrame,
} from '../types/agency';
import type { WrapupAnchor } from './agencyWrapup';
import type { LiveAttempt, StationConnection } from '../hooks/agencyStation/types';

/**
 * The station's state, and the one pure function that moves it.
 *
 * `useAgencyStation` used to hold this as sixteen `useState` cells written in
 * groups — a `reserved` cleared five of them, a `released` set three — so the
 * rule "these fields move together" lived only in the order of the setter calls,
 * repeated at every frame that touches them. Here each frame is ONE transition and
 * the groups are written once, which also makes them testable without a socket.
 *
 * ── What stays out ───────────────────────────────────────────────────────────
 * The reducer is pure. The cues, the analytics, the diagnostics buffer and the
 * refs the socket callbacks read all stay in the hook's frame handler, which
 * runs before it dispatches. Where a transition depends on something only the
 * handler can know, the handler computes it and puts it in the action:
 *
 *  - **the present and the clock offset** — a wrap-up anchor is opened in the
 *    handler (`openWrapup` reads both), so the reducer receives an anchor;
 *  - **`liveRef`** — the attempt a `released` retains is read off the ref the
 *    handler has always read it from (the attempt as of the last render), and
 *    passed in as `retain`, so the reducer cannot quietly change which attempt
 *    that is.
 *
 * ── Where "the state before this frame" comes from ───────────────────────────
 * Two clauses ask whether a wrap-up actually happened (the `agent_state` and
 * `ready` release-clearing rules below). The hook used to answer that from
 * `agentStateRef`, written at the moment each frame was handled because the
 * rendered `agentState` was still pre-batch. A reducer receives the state as of
 * every action already dispatched, in order — the same "as of the last frame"
 * value — so it reads `state.agentState` and needs no ref.
 */

export interface StationState {
  connection: StationConnection;
  agentState: AgencyAgentState;
  /** `agent_state.since` — the ONLY anchor for break elapsed time. */
  agentStateSince: string | null;
  breakReasonCode: string | null;
  pendingBreakCode: string | null;
  /** Monotonic; moves on every frame that states the break queue. */
  pendingBreakStatements: number;
  missedRelease: AgencyMissedRelease | null;
  live: LiveAttempt | null;
  retainedAttempt: AgencyReservedAttempt | null;
  wrapup: WrapupAnchor | null;
  clockOffsetMs: number;
  release: AgencyStationReleasedFrame | null;
  releasedAt: number | null;
  lastError: AgencyStationErrorFrame | null;
  dialing: boolean;
  missedPings: number;
}

export const INITIAL_STATION_STATE: StationState = {
  connection: 'idle',
  agentState: 'offline',
  agentStateSince: null,
  breakReasonCode: null,
  pendingBreakCode: null,
  pendingBreakStatements: 0,
  missedRelease: null,
  live: null,
  retainedAttempt: null,
  wrapup: null,
  clockOffsetMs: 0,
  release: null,
  releasedAt: null,
  lastError: null,
  dialing: true,
  missedPings: 0,
};

export type StationAction =
  | { type: 'connection'; connection: StationConnection }
  | { type: 'missed_pings'; count: number }
  /** `wrapup`: the anchor opened from `frame.active_wrapup`, when it carried one. */
  | { type: 'ready'; frame: AgencyStationReadyFrame; wrapup: WrapupAnchor | null }
  | { type: 'agent_state'; frame: AgencyStationAgentStateFrame }
  | { type: 'wrapup'; anchor: WrapupAnchor }
  | { type: 'reserved'; attempt: AgencyReservedAttempt }
  | { type: 'bridged'; attemptId: string; bridgedAt: string }
  /**
   * `at`: the client's own stamp (the frame carries none). `retain`: the attempt
   * whose panel stays up through wrap-up, or null — see the module note.
   */
  | { type: 'released'; frame: AgencyStationReleasedFrame; at: number; retain: AgencyReservedAttempt | null }
  | { type: 'campaign_state'; dialing: boolean }
  /** `offsetMs`: the estimator's new offset, or null when the pong carried no sample. */
  | { type: 'pong'; offsetMs: number | null }
  | { type: 'error'; frame: AgencyStationErrorFrame };

/**
 * `state` itself when nothing in `changes` differs — so a frame that restates
 * what the console already shows (a pong with nothing missed, a duplicate state)
 * costs no render, exactly as an unchanged `useState` setter did not.
 */
function patch(state: StationState, changes: Partial<StationState>): StationState {
  for (const key of Object.keys(changes) as (keyof StationState)[]) {
    if (!Object.is(state[key], changes[key])) return { ...state, ...changes };
  }
  return state;
}

/**
 * One authoritative statement of the break queue, from either frame that makes
 * one (`agent_state` and `ready`). The code and the statement counter are written
 * **here and nowhere else** so they cannot come apart: a consumer reconciling its
 * own copy needs the counter to move even when the code does not, and absence is
 * how the API says the queue is empty.
 */
function breakQueue(
  state: StationState,
  pending: AgencyAgentState | undefined,
  reason: string | undefined,
): Pick<StationState, 'pendingBreakCode' | 'pendingBreakStatements'> {
  return {
    pendingBreakCode: pending === 'break' ? (reason ?? null) : null,
    pendingBreakStatements: state.pendingBreakStatements + 1,
  };
}

export function stationReducer(state: StationState, action: StationAction): StationState {
  switch (action.type) {
    case 'connection':
      return patch(state, { connection: action.connection });

    case 'missed_pings':
      return patch(state, { missedPings: action.count });

    case 'ready': {
      /**
       * **`ready` is a full-state SNAPSHOT, not a set of additions** — replace or
       * clear, field by field, and never merely add. The reasoning for each
       * field is in `useAgencyStation`'s `ready` handler, beside the side effects
       * it shares a frame with.
       */
      const { frame } = action;
      const previousState = state.agentState;
      const next: Partial<StationState> = {
        agentState: frame.state,
        live: frame.active_attempt
          ? { attempt: frame.active_attempt, bridgedAt: frame.active_attempt.bridged_at }
          : null,
        missedRelease: frame.missed_release ?? null,
        ...breakQueue(state, frame.pending_state, frame.pending_break_reason),
      };
      if (frame.state === 'wrapup') {
        // A deadline only when this replica still owns the timer; absent, the
        // anchor already held is kept and none is invented.
        if (frame.active_wrapup && action.wrapup) {
          const anchored = frame.active_wrapup.attempt_id;
          next.wrapup = action.wrapup;
          // A panel held for a different attempt than the API's wrap-up is from a
          // call that finished while the socket was away.
          const prev = state.retainedAttempt;
          next.retainedAttempt = prev && prev.attempt_id !== anchored ? null : prev;
        }
      } else {
        next.wrapup = null;
        next.retainedAttempt = null;
        // `release` goes only when something newer or better accounts for the
        // call: a wrap-up that genuinely happened, the API's own missed release,
        // or a new call.
        if (previousState === 'wrapup' || frame.missed_release || frame.active_attempt) {
          next.release = null;
          next.releasedAt = null;
        }
      }
      return { ...state, ...next };
    }

    case 'agent_state': {
      const { frame } = action;
      const previousState = state.agentState;
      const next: Partial<StationState> = {
        agentState: frame.state,
        agentStateSince: frame.since,
        breakReasonCode: frame.break_reason ?? null,
        ...breakQueue(state, frame.pending_state, frame.pending_break_reason),
      };
      if (frame.state !== 'wrapup') {
        // `agent_state` is the one authority for wrap-up ENDING.
        next.wrapup = null;
        next.retainedAttempt = null;
        // `release` outlives wrap-up only when there was no wrap-up: one that
        // happened already showed the release copy for the whole window.
        if (previousState === 'wrapup') {
          next.release = null;
          next.releasedAt = null;
        }
      }
      return { ...state, ...next };
    }

    case 'wrapup':
      return patch(state, { wrapup: action.anchor });

    case 'reserved':
      // A new reservation always wins: whatever was on screen — a wrap-up, a
      // release, the account of a missed call — belongs to a call that is over.
      return {
        ...state,
        release: null,
        releasedAt: null,
        retainedAttempt: null,
        wrapup: null,
        missedRelease: null,
        live: { attempt: action.attempt, bridgedAt: null },
      };

    case 'bridged': {
      const prev = state.live;
      if (!prev || prev.attempt.attempt_id !== action.attemptId) return state;
      return { ...state, live: { ...prev, bridgedAt: action.bridgedAt } };
    }

    case 'released': {
      const { frame } = action;
      const next: Partial<StationState> = { release: frame, releasedAt: action.at, live: null };
      // The panel and pad stay up when there is still work to do.
      if (frame.requires_disposition && action.retain && action.retain.attempt_id === frame.attempt_id) {
        next.retainedAttempt = action.retain;
      }
      return { ...state, ...next };
    }

    case 'campaign_state':
      return patch(state, { dialing: action.dialing });

    case 'pong':
      return patch(
        state,
        action.offsetMs === null
          ? { missedPings: 0 }
          : { missedPings: 0, clockOffsetMs: action.offsetMs },
      );

    case 'error':
      return patch(state, { lastError: action.frame });
  }
}
