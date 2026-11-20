import { describe, it, expect } from 'vitest';
import { conflictIsMidCall, parseJoinConflict } from '../../utils/agencyJoinConflict';
import { ApiError } from '../../api/client';

/**
 * The `409 session_on_other_campaign` refusal.
 *
 * Asserted against a real `ApiError` rather than a hand-rolled object, because
 * the thing being relied on is that the server forwards the dialer runtime's body unchanged and
 * that `apiFetch` puts it on `details` — a parser written against an imagined
 * shape would pass its own tests and read nothing off the wire.
 */

const BODY = {
  error: 'Conflict',
  code: 'session_on_other_campaign',
  campaign_id: 'camp-other',
  campaign_name: 'Renewals',
  state: 'available',
  // The API's sentence. The station never shows it (AS15); the parser keeps it on the conflict.
  message: 'You are already joined to Renewals.',
};

describe('parseJoinConflict', () => {
  it('reads the campaign and state off a real 409', () => {
    const conflict = parseJoinConflict(new ApiError(409, BODY));
    expect(conflict).toEqual({
      error: 'Conflict',
      code: 'session_on_other_campaign',
      campaign_id: 'camp-other',
      campaign_name: 'Renewals',
      state: 'available',
      message: 'You are already joined to Renewals.',
    });
  });

  it('refuses a 409 that is some other conflict', () => {
    // The console has other 409s — `break_already_applied`, for one. Claiming
    // them all would put a campaign-shaped screen in front of an unrelated
    // refusal.
    expect(parseJoinConflict(new ApiError(409, { error: 'Conflict', code: 'break_already_applied' }))).toBeNull();
  });

  it('refuses the same body on a different status', () => {
    expect(parseJoinConflict(new ApiError(500, BODY))).toBeNull();
  });

  it.each([
    ['no campaign name', { ...BODY, campaign_name: undefined }],
    ['no campaign id', { ...BODY, campaign_id: 42 }],
    ['a state outside the union', { ...BODY, state: 'napping' }],
    // Empty is as unreadable as absent, and it is the one that gets through a
    // type check: it renders "You’re joined to  — available." with an "Open "
    // link, which is the exact screen this refusal exists to prevent.
    ['an empty campaign name', { ...BODY, campaign_name: '' }],
    ['a whitespace campaign name', { ...BODY, campaign_name: '   ' }],
    ['an empty campaign id', { ...BODY, campaign_id: '' }],
  ])('refuses a half-readable body: %s', (_label, body) => {
    // A partial conflict is not rendered as a whole one. A screen that names no
    // campaign looks like it meant to say something and failed, which is worse
    // than the generic error it would have replaced.
    expect(parseJoinConflict(new ApiError(409, body))).toBeNull();
  });

  it('refuses non-errors', () => {
    expect(parseJoinConflict(null)).toBeNull();
    expect(parseJoinConflict(new Error('network'))).toBeNull();
  });
});

/**
 * The conflict screen's one-click remedy: `useStationJoin`'s `confirmSwitch` chains
 * `createAgencySession(other)` → `leaveAgencySession` → `createAgencySession(here)`, and it and
 * the screen's words (`StationJoinScreens`, `switchFailedLine`) gate on this predicate.
 */
describe('conflictIsMidCall', () => {
  it('is true for the three states that mean a live customer or an owed disposition', () => {
    expect(conflictIsMidCall('reserved')).toBe(true);
    expect(conflictIsMidCall('on_call')).toBe(true);
    expect(conflictIsMidCall('wrapup')).toBe(true);
  });

  it('is false for the two states nothing is happening in', () => {
    expect(conflictIsMidCall('offline')).toBe(false);
    expect(conflictIsMidCall('available')).toBe(false);
  });
});
