import { describe, it, expect } from 'vitest';
import { AGENCY_ACTION_ERROR_CODES } from '../../types/agency';
import {
  PERMANENT_REDIAL_REFUSALS,
  REDIAL_FAILED_COPY,
  REDIAL_REFUSAL_CODES,
  REDIAL_UNCERTAIN_COPY,
  REDIAL_REFUSAL_COPY,
  redialRefusalCopy,
  redialRemainingCopy,
  redialTag,
} from '../../utils/agencyRedialCopy';

/** Shaped like the `ApiError` the client throws. */
function apiError(statusCode: number, details: unknown) {
  return Object.assign(new Error('ignored'), { statusCode, details });
}

describe('wrap-up redial copy', () => {
  it('covers exactly the redial refusals, every one a real action error code', () => {
    for (const code of REDIAL_REFUSAL_CODES) expect(AGENCY_ACTION_ERROR_CODES).toContain(code);
    expect(Object.keys(REDIAL_REFUSAL_COPY).sort()).toEqual([...REDIAL_REFUSAL_CODES].sort());
  });

  it.each([
    ['redial_limit_reached', 'No redials left for this call. Save the outcome.'],
    ['disposition_already_submitted', 'The outcome for this call is already saved, so it can’t be redialed.'],
    ['redial_blocked_dnc', 'This number is on a Do Not Call list, so it can’t be redialed. Save the outcome.'],
    [
      'redial_blocked_calling_hours',
      'It’s outside this contact’s calling hours, so it can’t be redialed now. Save the outcome.',
    ],
  ])('says what %s means, keyed off the code rather than the message', (code, copy) => {
    expect(redialRefusalCopy(apiError(409, { error: 'Conflict', code, message: 'server words' }))).toBe(copy);
  });

  it('shows redial_blocked’s message, which names the cause', () => {
    expect(
      redialRefusalCopy(
        apiError(409, { error: 'Conflict', code: 'redial_blocked', message: 'No usable caller ID.' }),
      ),
    ).toBe('Couldn’t redial: No usable caller ID.');
    expect(redialRefusalCopy(apiError(409, { error: 'Conflict', code: 'redial_blocked', message: '' }))).toBe(
      REDIAL_REFUSAL_COPY.redial_blocked,
    );
  });

  it('shows redial_not_allowed’s message as received (the campaign off or not running, the wrap-up over, ...)', () => {
    expect(
      redialRefusalCopy(
        apiError(409, {
          error: 'Conflict',
          code: 'redial_not_allowed',
          message: 'The campaign is not running, so the customer cannot be redialled. Save the outcome.',
        }),
      ),
    ).toBe('The campaign is not running, so the customer cannot be redialled. Save the outcome.');
    expect(redialRefusalCopy(apiError(409, { error: 'Conflict', code: 'redial_not_allowed', message: '' }))).toBe(
      'Redial isn’t available for this call. Save the outcome instead.',
    );
  });

  it('does not claim a redial with no usable answer failed: it may have been placed', () => {
    expect(redialRefusalCopy(new Error('Failed to fetch'))).toBe(REDIAL_UNCERTAIN_COPY);
    expect(redialRefusalCopy(apiError(502, { error: 'Bad Gateway' }))).toBe(REDIAL_UNCERTAIN_COPY);
    expect(REDIAL_UNCERTAIN_COPY).not.toMatch(/couldn’t|failed/i);
  });

  it('says it could not redial when the server answered with a refusal it does not name', () => {
    expect(redialRefusalCopy(apiError(409, { error: 'Conflict', code: 'state_changing', message: 'x' }))).toBe(
      REDIAL_FAILED_COPY,
    );
  });

  it('holds only the refusals that cannot change within the wrap-up as permanent', () => {
    expect([...PERMANENT_REDIAL_REFUSALS].sort()).toEqual(
      ['disposition_already_submitted', 'redial_blocked_dnc', 'redial_not_allowed'].sort(),
    );
  });

  it('counts what is left in plain words', () => {
    expect(redialRemainingCopy(2)).toBe('2 redials left');
    expect(redialRemainingCopy(1)).toBe('1 redial left');
    expect(redialRemainingCopy(0)).toBe('No redials left');
  });

  it('tags a redial with its number and the server’s total', () => {
    expect(redialTag({ of_attempt_id: 'att-1', number: 1, remaining: 1 })).toBe('Redial 1 of 2');
    expect(redialTag({ of_attempt_id: 'att-2', number: 2, remaining: 0 })).toBe('Redial 2 of 2');
  });
});
