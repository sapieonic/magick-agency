// How an inbound call that reached no one ends (docs/inbound.md §3, §7; `inbound-call-router.ts`):
// the outcome from how its messages ended, and the Missed row's reason from the outcome.
import { describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_CALL_OUTCOMES, AGENCY_INBOUND_MISSED_REASONS } from '@magick-agency/contracts/agency';
import { missedReasonFor, outcomeAfterPlayback } from '../../../../src/agency/inbound/inbound-call-router.js';

describe('outcomeAfterPlayback', () => {
  it('every message heard: the plan\'s outcome', () => {
    expect(outcomeAfterPlayback('closed', 'completed', false)).toBe('closed');
    expect(outcomeAfterPlayback('overflow', 'completed', false)).toBe('overflow');
    expect(outcomeAfterPlayback('overflow_no_capacity', 'completed', false)).toBe('overflow_no_capacity');
    // Our own REST hangup posts a hangup too: a completed sequence keeps its outcome.
    expect(outcomeAfterPlayback('overflow', 'completed', true)).toBe('overflow');
  });

  it('the caller hung up mid-message: abandoned in the queue on the "we will call you back" plan; the others keep why', () => {
    expect(outcomeAfterPlayback('overflow', 'aborted', true)).toBe('abandoned_in_queue');
    expect(outcomeAfterPlayback('overflow', 'aborted', false)).toBe('abandoned_in_queue');
    expect(outcomeAfterPlayback('closed', 'aborted', true)).toBe('closed');
    expect(outcomeAfterPlayback('overflow_no_capacity', 'aborted', true)).toBe('overflow_no_capacity');
  });

  it('no media: failed, unless the carrier said the caller hung up first', () => {
    expect(outcomeAfterPlayback('overflow', 'no_media', false)).toBe('failed');
    expect(outcomeAfterPlayback('closed', 'not_found', false)).toBe('failed');
    expect(outcomeAfterPlayback('overflow', 'no_media', true)).toBe('abandoned_in_queue');
    expect(outcomeAfterPlayback('closed', 'no_media', true)).toBe('closed');
  });
});

describe('missedReasonFor', () => {
  it('no Missed row for an answered or rejected call; every other outcome names a reason of the vocabulary', () => {
    expect(missedReasonFor('answered')).toBeNull();
    expect(missedReasonFor('rejected')).toBeNull();
    for (const outcome of AGENCY_INBOUND_CALL_OUTCOMES.filter((o) => o !== 'answered' && o !== 'rejected')) {
      expect(AGENCY_INBOUND_MISSED_REASONS, outcome).toContain(missedReasonFor(outcome));
    }
    expect(missedReasonFor('abandoned_in_queue')).toBe('abandoned_in_queue');
    expect(missedReasonFor('failed')).toBe('failed');
  });
});
