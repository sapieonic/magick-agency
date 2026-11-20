import { describe, expect, it } from 'vitest';
import { INITIAL_STATION_STATE, stationReducer } from '../../utils/agencyStationReducer';
import { effectiveQueue, nothingDueReason } from '../../utils/agencyStationIdle';
import type { AgencyQueueState } from '../../types/agency';

/**
 * Contact assignment's "Nothing due now": the `queue` the station holds (from
 * `ready` and `queue` frames, falling back to the bootstrap's) and the reason
 * nothing is due, which the page reports (the words are `noCallsSubtitle`'s).
 */

const NOTHING: AgencyQueueState = { due: false, reason: 'waiting_for_retry', next_due_at: '2026-11-03T12:00:00.000Z' };

describe('the queue in the station state', () => {
  it('is unstated until the socket says something', () => {
    expect(INITIAL_STATION_STATE.queue).toBeUndefined();
  });

  it('a queue frame sets it, and restating the same queue costs no render', () => {
    const once = stationReducer(INITIAL_STATION_STATE, { type: 'queue', queue: NOTHING });
    expect(once.queue).toEqual(NOTHING);
    expect(stationReducer(once, { type: 'queue', queue: { ...NOTHING } })).toBe(once);
    const due = stationReducer(once, { type: 'queue', queue: { due: true, reason: null, next_due_at: null } });
    expect(due.queue).toEqual({ due: true, reason: null, next_due_at: null });
  });

  it('ready replaces it as a snapshot: absent means the campaign states none', () => {
    const held = stationReducer(INITIAL_STATION_STATE, { type: 'queue', queue: NOTHING });
    const pool = stationReducer(held, {
      type: 'ready', frame: { event: 'ready', session_id: 's', state: 'available' }, wrapup: null,
    });
    expect(pool.queue).toBeNull();
    const strict = stationReducer(held, {
      type: 'ready',
      frame: { event: 'ready', session_id: 's', state: 'available', queue: { due: false, reason: 'queue_empty', next_due_at: null } },
      wrapup: null,
    });
    expect(strict.queue).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
  });
});

describe('effectiveQueue', () => {
  it('uses the bootstrap until the socket has stated a queue, then the socket', () => {
    expect(effectiveQueue(undefined, NOTHING)).toEqual(NOTHING);
    expect(effectiveQueue(undefined, undefined)).toBeNull();
    expect(effectiveQueue(null, NOTHING)).toBeNull();
    const due = { due: true, reason: null, next_due_at: null };
    expect(effectiveQueue(due, NOTHING)).toBe(due);
  });
});

describe('nothingDueReason', () => {
  it('is null when something is due or no queue is stated', () => {
    expect(nothingDueReason(null)).toBeNull();
    expect(nothingDueReason(undefined)).toBeNull();
    expect(nothingDueReason({ due: true, reason: null, next_due_at: null })).toBeNull();
  });

  it('is the queue’s reason when nothing is due', () => {
    expect(nothingDueReason(NOTHING)).toBe('waiting_for_retry');
    expect(nothingDueReason({ due: false, reason: 'outside_calling_hours', next_due_at: null })).toBe('outside_calling_hours');
  });

  it('is null for a nothing-due queue that states no reason: nothing to report', () => {
    expect(nothingDueReason({ due: false, reason: null, next_due_at: null })).toBeNull();
  });
});
