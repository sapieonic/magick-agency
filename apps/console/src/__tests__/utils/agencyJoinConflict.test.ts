import { describe, it, expect } from 'vitest';
import {
  conflictIsMidCall,
  joinConflictCopy,
  joinConflictFallbackSentence,
  parseJoinConflict,
  switchActionLabel,
  switchConfirmMessage,
  switchFailureCopy,
} from '../../utils/agencyJoinConflict';
import { ApiError } from '../../api/client';

/**
 * The `409 session_on_other_campaign` refusal (`MAG-160`).
 *
 * Asserted against a real `ApiError` rather than a hand-rolled object, because
 * the thing being relied on is that master forwards core's body VERBATIM and
 * that `apiFetch` puts it on `details` — a parser written against an imagined
 * shape would pass its own tests and read nothing off the wire.
 */

const BODY = {
  error: 'Conflict',
  code: 'session_on_other_campaign',
  campaign_id: 'camp-other',
  campaign_name: 'Renewals',
  state: 'available',
  // Core added this after the first cut of this feature. The console prefers its
  // own composed copy on the structured path and only falls back to this.
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

describe('joinConflictCopy', () => {
  it('names the campaign, its state and the way out', () => {
    const copy = joinConflictCopy(parseJoinConflict(new ApiError(409, BODY))!);
    expect(copy.detail).toContain('Renewals');
    expect(copy.detail).toContain('available');
    expect(copy.remedy).toBe('Leave Renewals first, then come back here.');
  });

  it('does not tell a mid-call agent to leave right now', () => {
    // `state` is on the wire precisely so this branch exists: the other station
    // has a live customer on it, and "leave that station" is the wrong
    // instruction for the next few minutes.
    const conflict = parseJoinConflict(new ApiError(409, { ...BODY, state: 'on_call' }))!;
    const copy = joinConflictCopy(conflict);
    expect(copy.detail).toContain('on a call');
    expect(copy.remedy).toContain('Finish what you’re doing');
  });
});

/**
 * The degraded path.
 *
 * The parser above stays strict — a screen shaped like one that names a campaign
 * and then names none reads as broken — so a half-readable body falls through to
 * the ordinary error screen. This is what that screen is allowed to say once it
 * gets there.
 */
describe('joinConflictFallbackSentence', () => {
  it('hands back core’s sentence when the structured read failed', () => {
    const err = new ApiError(409, { ...BODY, campaign_id: undefined });

    // The pair is the point: the parser refuses, and the fallback still beats
    // "Could not join the campaign."
    expect(parseJoinConflict(err)).toBeNull();
    expect(joinConflictFallbackSentence(err)).toBe('You are already joined to Renewals.');
  });

  it('is null when the body carries no sentence', () => {
    const { message: _message, ...withoutMessage } = BODY;
    expect(joinConflictFallbackSentence(new ApiError(409, withoutMessage))).toBeNull();
  });

  it('is null for a blank sentence', () => {
    // Whitespace is not an explanation, and it would render as an empty screen.
    expect(joinConflictFallbackSentence(new ApiError(409, { ...BODY, message: '   ' }))).toBeNull();
  });

  it('refuses to read sentences out of unrelated conflicts', () => {
    // The console has other 409s — `break_already_applied` for one. This is
    // scoped to the join conflict rather than becoming a general error reader.
    expect(
      joinConflictFallbackSentence(
        new ApiError(409, { code: 'break_already_applied', message: 'Break already started.' }),
      ),
    ).toBeNull();
    expect(joinConflictFallbackSentence(new ApiError(500, BODY))).toBeNull();
  });
});

/**
 * The conflict screen's one-click remedy — `AgentConsolePage.confirmSwitch`
 * chains `createAgencySession(other)` → `leaveAgencySession` →
 * `createAgencySession(here)`, and everything below is the pure copy that
 * drives it, kept out of the component so it is testable without a socket.
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

  it('is exactly what joinConflictCopy branches its remedy on', () => {
    // The two must never drift apart — this pins them to the same predicate
    // rather than two copies of the same three-state list.
    const midCallConflict = parseJoinConflict(new ApiError(409, { ...BODY, state: 'on_call' }))!;
    expect(conflictIsMidCall(midCallConflict.state)).toBe(true);
    expect(joinConflictCopy(midCallConflict).remedy).toContain('Finish what you’re doing');
  });
});

describe('switchActionLabel', () => {
  it('names the campaign that will be left', () => {
    const conflict = parseJoinConflict(new ApiError(409, BODY))!;
    expect(switchActionLabel(conflict)).toBe('Leave Renewals and join here');
  });
});

describe('switchConfirmMessage', () => {
  it('states both consequences — the other session closes, this one opens', () => {
    const conflict = parseJoinConflict(new ApiError(409, BODY))!;
    const message = switchConfirmMessage(conflict);
    expect(message).toContain('Renewals');
    expect(message).toMatch(/closes your session/);
    expect(message).toMatch(/joins this campaign/);
  });
});

describe('switchFailureCopy', () => {
  /**
   * Each stage needs its own sentence because each leaves the agent in a
   * different place: `resume` changed nothing, `leave` means they are still
   * on the other station exactly as before, and `rejoin` means they have
   * ALREADY left it and are at neither station — the one an agent must not
   * be left to guess at.
   */
  it('says the other station could not be reached, for a resume failure', () => {
    expect(switchFailureCopy('resume', 'Renewals', new Error('timeout'))).toBe(
      'Couldn’t reach Renewals to leave it — timeout',
    );
    expect(switchFailureCopy('resume', 'Renewals', 'not an Error')).toBe(
      'Couldn’t reach Renewals to leave it. Try again.',
    );
  });

  it('says the other station is still open, for a leave failure', () => {
    expect(switchFailureCopy('leave', 'Renewals', new Error('network error'))).toBe(
      'Renewals is still open — network error',
    );
    expect(switchFailureCopy('leave', 'Renewals', null)).toBe(
      'Renewals is still open. Try again.',
    );
  });

  it('says the other station is already closed, for a rejoin failure', () => {
    expect(switchFailureCopy('rejoin', 'Renewals', new Error('server error'))).toBe(
      'Left Renewals, but couldn’t join this campaign — server error',
    );
    expect(switchFailureCopy('rejoin', 'Renewals', undefined)).toBe(
      'Left Renewals, but couldn’t join this campaign. Try again.',
    );
  });
});
