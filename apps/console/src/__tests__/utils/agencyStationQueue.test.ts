import { describe, expect, it } from 'vitest';
import { INITIAL_STATION_STATE, stationReducer } from '../../utils/agencyStationReducer';
import {
  QUEUE_IDLE_COPY,
  effectiveQueue,
  nothingDueCopy,
} from '../../utils/agencyStationIdle';
import type { AgencyQueueIdleReason, AgencyQueueState } from '../../types/agency';

/**
 * Contact assignment's "Nothing due now": the `queue` the station holds (from
 * `ready` and `queue` frames, falling back to the bootstrap's) and the sentence
 * the idle guide says for it.
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

describe('nothingDueCopy', () => {
  const at = (iso: string) => `at ${iso.slice(11, 16)}`;

  it('is null when something is due or no queue is stated', () => {
    expect(nothingDueCopy(null, at)).toBeNull();
    expect(nothingDueCopy({ due: true, reason: null, next_due_at: null }, at)).toBeNull();
  });

  it('says why nothing is due, with the next time when there is one', () => {
    expect(nothingDueCopy(NOTHING, at)).toBe(
      'Your contacts are scheduled for another try later. The next one is due at 12:00.',
    );
    expect(nothingDueCopy({ due: false, reason: 'callbacks_later', next_due_at: null }, at)).toBe(
      'Your open contacts are all callbacks booked for later.',
    );
  });

  it('has a sentence for every reason, never a wire token', () => {
    const reasons: AgencyQueueIdleReason[] = ['queue_empty', 'waiting_for_retry', 'callbacks_later', 'outside_calling_hours'];
    expect(Object.keys(QUEUE_IDLE_COPY).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) {
      const withTime = nothingDueCopy({ due: false, reason, next_due_at: '2026-11-03T09:00:00.000Z' }, at)!;
      const without = nothingDueCopy({ due: false, reason, next_due_at: null }, at)!;
      for (const copy of [withTime, without]) {
        expect(copy).not.toMatch(/_|\{next\}/);
        expect(copy.length).toBeGreaterThan(10);
      }
    }
  });
});
