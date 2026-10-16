import { describe, it, expect } from 'vitest';
import {
  INITIAL_STATION_STATE,
  stationReducer,
  type StationAction,
  type StationState,
} from '../../utils/agencyStationReducer';
import type { WrapupAnchor } from '../../utils/agencyWrapup';
import type {
  AgencyReservedAttempt,
  AgencyStationReadyFrame,
  AgencyStationReleasedFrame,
} from '../../types/agency';

/**
 * The station's transitions, without a socket. Each frame is one transition, and
 * the groups of fields it moves together are what these pin — the hook-level
 * tests (`useAgencyStation.test.ts`) still drive the same rules through real
 * frames on a fake socket.
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
};
const NEXT: AgencyReservedAttempt = { ...ATTEMPT, attempt_id: 'att-2', contact_id: 'c-2' };

const RELEASED: AgencyStationReleasedFrame = {
  event: 'released',
  attempt_id: 'att-1',
  reason: 'completed',
  requires_disposition: true,
  message: 'Call ended.',
};

const ANCHOR: WrapupAnchor = {
  attemptId: 'att-1',
  deadlineMs: 1_000_000,
  totalMs: 30_000,
  requiresDisposition: true,
  heldReason: null,
  autoReturn: true,
};

const run = (actions: StationAction[], from: StationState = INITIAL_STATION_STATE) =>
  actions.reduce(stationReducer, from);

/** On a bridged call. */
const onCall = () =>
  run([
    { type: 'reserved', attempt: ATTEMPT },
    { type: 'bridged', attemptId: 'att-1', bridgedAt: '2026-08-11T10:00:04.000Z' },
    { type: 'agent_state', frame: { event: 'agent_state', state: 'on_call', since: 'S1' } },
  ]);

/** In a wrap-up that requires a disposition, panel retained. */
const inWrapup = () =>
  run(
    [
      { type: 'released', frame: RELEASED, at: 500, retain: ATTEMPT },
      { type: 'agent_state', frame: { event: 'agent_state', state: 'wrapup', since: 'S2' } },
      { type: 'wrapup', anchor: ANCHOR },
    ],
    onCall(),
  );

function ready(overrides: Partial<AgencyStationReadyFrame> = {}): AgencyStationReadyFrame {
  return { event: 'ready', session_id: 'sess-1', state: 'available', ...overrides };
}

describe('stationReducer — the groups move together', () => {
  it('reserved replaces the panel and clears everything about the last call', () => {
    const s = run([{ type: 'reserved', attempt: NEXT }], {
      ...inWrapup(),
      missedRelease: { attempt_id: 'old', reason: 'completed', requires_disposition: false, message: 'x', ended_at: '2026-08-11T10:00:00.000Z' },
    });
    expect(s.live).toEqual({ attempt: NEXT, bridgedAt: null });
    expect(s.retainedAttempt).toBeNull();
    expect(s.wrapup).toBeNull();
    expect(s.release).toBeNull();
    expect(s.releasedAt).toBeNull();
    expect(s.missedRelease).toBeNull();
  });

  it('bridged opens the call only for the attempt that is live', () => {
    const ringing = run([{ type: 'reserved', attempt: ATTEMPT }]);
    const other = stationReducer(ringing, { type: 'bridged', attemptId: 'att-9', bridgedAt: 'B' });
    // Not merely equal: the same object, so a stray frame costs no render.
    expect(other).toBe(ringing);
    expect(stationReducer(ringing, { type: 'bridged', attemptId: 'att-1', bridgedAt: 'B' }).live?.bridgedAt).toBe('B');
  });

  it('released clears live, stamps the release, and retains the panel when owed a disposition', () => {
    const s = run([{ type: 'released', frame: RELEASED, at: 500, retain: ATTEMPT }], onCall());
    expect(s.live).toBeNull();
    expect(s.release).toBe(RELEASED);
    expect(s.releasedAt).toBe(500);
    expect(s.retainedAttempt).toBe(ATTEMPT);
  });

  it('released retains nothing when no disposition is owed, or the retained attempt is another', () => {
    const none = run(
      [{ type: 'released', frame: { ...RELEASED, requires_disposition: false }, at: 1, retain: ATTEMPT }],
      onCall(),
    );
    expect(none.retainedAttempt).toBeNull();
    const mismatched = run([{ type: 'released', frame: RELEASED, at: 1, retain: NEXT }], onCall());
    expect(mismatched.retainedAttempt).toBeNull();
  });
});

describe('stationReducer — agent_state is the authority for wrap-up ending', () => {
  it('leaving wrap-up clears the anchor, the retained panel and the release', () => {
    const s = run(
      [{ type: 'agent_state', frame: { event: 'agent_state', state: 'available', since: 'S3' } }],
      inWrapup(),
    );
    expect(s.agentState).toBe('available');
    expect(s.agentStateSince).toBe('S3');
    expect(s.wrapup).toBeNull();
    expect(s.retainedAttempt).toBeNull();
    // A wrap-up happened, so its release copy has already been shown.
    expect(s.release).toBeNull();
    expect(s.releasedAt).toBeNull();
  });

  it('keeps a release no wrap-up ever explained (on_call → available)', () => {
    const released = run([{ type: 'released', frame: RELEASED, at: 7, retain: ATTEMPT }], onCall());
    const s = run(
      [{ type: 'agent_state', frame: { event: 'agent_state', state: 'available', since: 'S3' } }],
      released,
    );
    expect(s.release).toBe(RELEASED);
    expect(s.releasedAt).toBe(7);
    expect(s.retainedAttempt).toBeNull();
  });

  it('reads "the state before this frame" from the state as of the last action, mid-batch', () => {
    // released → agent_state{wrapup} → agent_state{available}, all before any
    // render: the second agent_state must see `wrapup` as the previous state.
    const s = run(
      [
        { type: 'released', frame: RELEASED, at: 1, retain: ATTEMPT },
        { type: 'agent_state', frame: { event: 'agent_state', state: 'wrapup', since: 'S2' } },
        { type: 'agent_state', frame: { event: 'agent_state', state: 'available', since: 'S3' } },
      ],
      onCall(),
    );
    expect(s.release).toBeNull();
  });
});

describe('stationReducer — ready is a snapshot, not a set of additions', () => {
  it('clears a live attempt the API no longer holds', () => {
    const s = stationReducer(onCall(), { type: 'ready', frame: ready(), wrapup: null });
    expect(s.live).toBeNull();
    expect(s.agentState).toBe('available');
  });

  it('rehydrates a live attempt with its bridged_at', () => {
    const s = stationReducer(INITIAL_STATION_STATE, {
      type: 'ready',
      frame: ready({ state: 'on_call', active_attempt: { ...ATTEMPT, bridged_at: 'B', state: 'bridged' } }),
      wrapup: null,
    });
    expect(s.live?.bridgedAt).toBe('B');
    expect(s.live?.attempt.attempt_id).toBe('att-1');
  });

  it('a wrap-up that lapsed while away closes the pad’s routes, and its release goes', () => {
    const s = stationReducer(inWrapup(), { type: 'ready', frame: ready(), wrapup: null });
    expect(s.wrapup).toBeNull();
    expect(s.retainedAttempt).toBeNull();
    expect(s.release).toBeNull();
  });

  it('keeps an unexplained release across a reconnect in the idle window', () => {
    const released = run(
      [
        { type: 'released', frame: RELEASED, at: 7, retain: ATTEMPT },
        { type: 'agent_state', frame: { event: 'agent_state', state: 'available', since: 'S3' } },
      ],
      onCall(),
    );
    const s = stationReducer(released, { type: 'ready', frame: ready(), wrapup: null });
    expect(s.release).toBe(RELEASED);
  });

  it('in wrap-up: takes the API’s anchor, and drops a panel for a different attempt', () => {
    const otherAnchor: WrapupAnchor = { ...ANCHOR, attemptId: 'att-2' };
    const s = stationReducer(inWrapup(), {
      type: 'ready',
      frame: ready({
        state: 'wrapup',
        active_wrapup: {
          attempt_id: 'att-2',
          ends_at: null,
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: true,
        },
      }),
      wrapup: otherAnchor,
    });
    expect(s.wrapup).toBe(otherAnchor);
    expect(s.retainedAttempt).toBeNull();
  });

  it('in wrap-up with no active_wrapup (another replica): keeps the anchor it holds', () => {
    const before = inWrapup();
    const s = stationReducer(before, { type: 'ready', frame: ready({ state: 'wrapup' }), wrapup: null });
    expect(s.wrapup).toBe(before.wrapup);
    expect(s.retainedAttempt).toBe(before.retainedAttempt);
  });

  it('assigns the missed release unconditionally — absence says there is none', () => {
    const withMissed = stationReducer(INITIAL_STATION_STATE, {
      type: 'ready',
      frame: ready({
        missed_release: { attempt_id: 'att-1', reason: 'completed', requires_disposition: false, message: 'x', ended_at: '2026-08-11T10:00:00.000Z' },
      }),
      wrapup: null,
    });
    expect(withMissed.missedRelease?.attempt_id).toBe('att-1');
    const cleared = stationReducer(withMissed, { type: 'ready', frame: ready(), wrapup: null });
    expect(cleared.missedRelease).toBeNull();
  });
});

describe('stationReducer — the break queue is one statement', () => {
  it('moves the counter on every statement, including the ones that say it is empty', () => {
    const queued = stationReducer(INITIAL_STATION_STATE, {
      type: 'agent_state',
      frame: { event: 'agent_state', state: 'on_call', since: 'S1', pending_state: 'break', pending_break_reason: 'lunch' },
    });
    expect(queued.pendingBreakCode).toBe('lunch');
    expect(queued.pendingBreakStatements).toBe(1);

    const emptied = stationReducer(queued, {
      type: 'agent_state',
      frame: { event: 'agent_state', state: 'on_call', since: 'S1' },
    });
    expect(emptied.pendingBreakCode).toBeNull();
    expect(emptied.pendingBreakStatements).toBe(2);

    // `ready` states it too, and an empty queue on an already-empty pill still
    // moves the counter — absence is the signal.
    const restated = stationReducer(emptied, { type: 'ready', frame: ready(), wrapup: null });
    expect(restated.pendingBreakStatements).toBe(3);
  });
});

describe('stationReducer — an unchanged value costs no render', () => {
  it.each<StationAction>([
    { type: 'connection', connection: 'idle' },
    { type: 'missed_pings', count: 0 },
    { type: 'pong', offsetMs: null },
    { type: 'pong', offsetMs: 0 },
    { type: 'campaign_state', dialing: true },
  ])('returns the same state for %o', (action) => {
    expect(stationReducer(INITIAL_STATION_STATE, action)).toBe(INITIAL_STATION_STATE);
  });

  it('a pong clears the misses and moves the offset only when it carried a sample', () => {
    const missing = stationReducer(INITIAL_STATION_STATE, { type: 'missed_pings', count: 2 });
    const noSample = stationReducer(missing, { type: 'pong', offsetMs: null });
    expect(noSample.missedPings).toBe(0);
    expect(noSample.clockOffsetMs).toBe(0);
    expect(stationReducer(missing, { type: 'pong', offsetMs: -10_000 }).clockOffsetMs).toBe(-10_000);
  });
});
