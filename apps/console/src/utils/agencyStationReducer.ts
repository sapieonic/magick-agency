import type {
  AgencyAgentState,
  AgencyMissedRelease,
  AgencyQueueState,
  AgencyReservedAttempt,
  AgencyStationAgentStateFrame,
  AgencyStationErrorFrame,
  AgencyStationReadyFrame,
  AgencyStationReleasedFrame,
} from '../types/agency';
import type { AgencyManualCall } from '../types/softphone';
import type { AgencyInboundCall, AgencyStationCustomerWaitingFrame } from '../types/inbound';
import type { WrapupAnchor } from './agencyWrapup';
import { newerCall } from './softphone/callState';
import { newerInboundCall } from './inbound/inboundCall';
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
  /** The session's soft-phone call, as the newest `manual_call` frame stated it. */
  manualCall: AgencyManualCall | null;
  /**
   * This agent's own queue on a `strict` / `preferred` campaign (contact
   * assignment), as the socket last stated it: `undefined` until the socket has
   * said anything (the bootstrap's `queue` stands until then), `null` when a
   * `ready` carried none (a `pool` campaign has no per-agent queue).
   */
  queue: AgencyQueueState | null | undefined;
  /**
   * The inbound call offered to or connected with this session, as the newest `inbound_call`
   * frame stated it (P2, `docs/inbound.md` §6): the WHOLE row, never patched. Kept through a
   * `ready`, like `manualCall`: the server re-sends it right after `ready` while it still holds
   * the station, and a call that settled or was requeued while the socket was away is the
   * panel's to reconcile (`useInboundCall`).
   */
  inboundCall: AgencyInboundCall | null;
  /**
   * "Your customer is waiting": a caller sticky to this agent is queued while the agent is busy
   * (`customer_waiting`). Cleared by the server's `customer_waiting` with `cleared: true` for that
   * caller (taken by anyone, overflowed, hung up), and, as a backstop, by what makes it untrue: an
   * offer (`inbound_call`), a `ready` (a snapshot: the server re-sends it
   * after `ready` while the caller still waits), and the agent leaving the busy states
   * (`available`: the release hook would have offered them the caller first; `break` and
   * `offline`: they are not eligible, so the caller goes to the team).
   */
  customerWaiting: AgencyStationCustomerWaitingFrame | null;
}

/** The agent states in which a sticky caller waits for this agent rather than going to them. */
const BUSY_FOR_WAITING: ReadonlySet<AgencyAgentState> = new Set<AgencyAgentState>(['reserved', 'on_call', 'wrapup']);

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
  manualCall: null,
  queue: undefined,
  inboundCall: null,
  customerWaiting: null,
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
  | { type: 'error'; frame: AgencyStationErrorFrame }
  /** A `manual_call` frame: the whole row, kept only when it is not older than the copy held. */
  | { type: 'manual_call'; call: AgencyManualCall }
  /** A `queue` frame: this agent's queue changed (sent only on a change). */
  | { type: 'queue'; queue: AgencyQueueState }
  /** An `inbound_call` frame: the whole row, kept only when it is not older than the copy held. */
  | { type: 'inbound_call'; call: AgencyInboundCall }
  /** A `customer_waiting` frame. */
  | { type: 'customer_waiting'; frame: AgencyStationCustomerWaitingFrame };

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
        // A snapshot like every other field: absent means this campaign states no
        // per-agent queue, not "keep what we had".
        queue: frame.queue ?? null,
        // Re-sent by the server right after `ready` while the caller still waits.
        customerWaiting: null,
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
      if (!BUSY_FOR_WAITING.has(frame.state)) next.customerWaiting = null;
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

    case 'wrapup': {
      // The same consistency rule `ready` applies: a panel retained for a different
      // attempt than the one this wrap-up is for belongs to a finished call. It is
      // reachable with wrap-up redial — a redial that fails before connecting opens
      // a wrap-up on the NEW attempt, and without this the pad would submit the
      // outcome against the redialed (already closed) one, which `currentAttemptId`
      // prefers over the anchor.
      const prev = state.retainedAttempt;
      return patch(state, {
        wrapup: action.anchor,
        retainedAttempt: prev && prev.attempt_id !== action.anchor.attemptId ? null : prev,
      });
    }

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

    case 'manual_call':
      // The frame's copy goes first so it wins a tie: the frame is the authority.
      return patch(state, { manualCall: newerCall(action.call, state.manualCall) });

    case 'queue': {
      // Compared by value: the frame is a fresh object each time, and a restated
      // queue must cost no render.
      const held = state.queue;
      const next = action.queue;
      if (held && held.due === next.due && held.reason === next.reason && held.next_due_at === next.next_due_at) {
        return state;
      }
      return { ...state, queue: { due: next.due, reason: next.reason, next_due_at: next.next_due_at } };
    }

    case 'inbound_call': {
      // The frame's copy goes first so it wins a tie: the frame is the authority. An offer
      // retires the waiting pill: the caller is the one being put through (the release hook
      // offers a sticky caller first), or no longer waits for this agent.
      const inboundCall = newerInboundCall(action.call, state.inboundCall);
      return patch(state, {
        inboundCall,
        customerWaiting: action.call.state === 'offered' ? null : state.customerWaiting,
      });
    }

    case 'customer_waiting':
      // `cleared`: that caller no longer waits for this agent (taken, overflowed, gone). Only the
      // pill for THAT caller goes; a clear for another caller changes nothing.
      if (action.frame.cleared) {
        return state.customerWaiting?.inbound_call_id === action.frame.inbound_call_id
          ? patch(state, { customerWaiting: null })
          : state;
      }
      return patch(state, { customerWaiting: action.frame });
  }
}
