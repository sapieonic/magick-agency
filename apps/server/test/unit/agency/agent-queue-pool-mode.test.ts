import { describe, expect, it } from 'vitest';
import { poolModeQueueState } from '../../../src/agency/pacing/agent-queue.js';

/**
 * The My contacts summary's queue on a `pool` campaign (`poolModeQueueState`): the campaign's
 * open contacts through the pacing probe's rule (`queueStateFrom`), read from their earliest
 * `next_attempt_at`. Strict / preferred read the probe itself (`agency-agent-queue.test.ts`).
 */
const NOW = new Date('2026-11-03T12:00:00Z');
const OPEN = { calling_window_start: '00:00:00', calling_window_end: '23:59:59', calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC' };
const SHUT = { ...OPEN, calling_window_start: '09:00:00', calling_window_end: '09:00:00' };
const LATER = new Date('2026-11-03T13:00:00Z');

describe('poolModeQueueState', () => {
  it('due when the earliest open contact is due, even with the window shut (due wins, as for an owner)', () => {
    expect(poolModeQueueState(OPEN as never, new Date('2026-11-03T11:00:00Z'), NOW)).toEqual({ due: true, reason: null, next_due_at: null });
    expect(poolModeQueueState(SHUT as never, NOW, NOW)).toEqual({ due: true, reason: null, next_due_at: null });
  });

  it('queue_empty with nothing open; outside_calling_hours first when the window is shut', () => {
    expect(poolModeQueueState(OPEN as never, null, NOW)).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
    expect(poolModeQueueState(SHUT as never, null, NOW)).toEqual({ due: false, reason: 'outside_calling_hours', next_due_at: null });
    expect(poolModeQueueState(SHUT as never, LATER, NOW)).toEqual({
      due: false, reason: 'outside_calling_hours', next_due_at: LATER.toISOString(),
    });
  });

  it('waiting_for_retry (never callbacks_later) when everything open is due later', () => {
    expect(poolModeQueueState(OPEN as never, LATER, NOW)).toEqual({
      due: false, reason: 'waiting_for_retry', next_due_at: LATER.toISOString(),
    });
  });
});
