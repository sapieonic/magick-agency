import { describe, it, expect } from 'vitest';
import { ApiError } from '../../api/client';
import { errorBody, errorCode, errorStatus } from '../../utils/agencyErrors';

/**
 * Built from a real `ApiError`, not a hand-made `{ status, body }`: the field names
 * are the whole risk (`statusCode`/`details`), and a hand-built shape is how a
 * reader of the wrong field once passed its tests.
 */
const refusal = () =>
  new ApiError(409, {
    error: 'Disposition Required',
    code: 'attempt_not_dispositionable',
    message: 'Submit a disposition for your last call before going available.',
  });

describe('agency error reads', () => {
  it('reads the envelope, the status and the code off an ApiError', () => {
    const err = refusal();
    expect(errorBody(err)?.message).toBe(
      'Submit a disposition for your last call before going available.',
    );
    expect(errorStatus(err)).toBe(409);
    expect(errorCode(err)).toBe('attempt_not_dispositionable');
  });

  it('never reads `body` or `status` — the names ApiError does not have', () => {
    const lookalike = { status: 409, body: { code: 'attempt_not_dispositionable' } };
    expect(errorBody(lookalike)).toBeNull();
    expect(errorStatus(lookalike)).toBeNull();
    expect(errorCode(lookalike)).toBeNull();
  });

  it('is null for anything that is not an error envelope', () => {
    for (const err of [null, undefined, 'boom', 42, new Error('plain'), { details: 'text' }]) {
      expect(errorBody(err)).toBeNull();
      expect(errorStatus(err)).toBeNull();
      expect(errorCode(err)).toBeNull();
    }
  });

  it('refuses a non-string code rather than passing it on', () => {
    expect(errorCode({ details: { code: 7 } })).toBeNull();
    // The body is still an envelope — it has a `code` — so callers reading the
    // message are not penalised for a malformed code.
    expect(errorBody({ details: { code: 7, message: 'x' } })).not.toBeNull();
  });
});
