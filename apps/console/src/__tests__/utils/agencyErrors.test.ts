import { describe, it, expect } from 'vitest';
import { ApiError } from '../../api/client';
import { errorBody, errorCode, errorStatus, retryOnStationTokenUnavailable, STATION_TOKEN_RETRY_DELAYS_MS } from '../../utils/agencyErrors';

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

describe('retryOnStationTokenUnavailable (D9)', () => {
  const tokenUnavailable = () =>
    new ApiError(503, { error: 'Service Unavailable', code: 'station_token_unavailable', message: 'Try again in a moment.' });

  it('retries a 503 station_token_unavailable with the stated delays, then returns the answer', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await retryOnStationTokenUnavailable(async () => {
      calls += 1;
      if (calls < 3) throw tokenUnavailable();
      return 'joined';
    }, async (ms) => { waits.push(ms); });
    expect(out).toBe('joined');
    expect(waits).toEqual(STATION_TOKEN_RETRY_DELAYS_MS.slice(0, 2));
  });

  it('gives up after the last delay with the refusal, so the screen can still say it', async () => {
    const waits: number[] = [];
    const err = tokenUnavailable();
    await expect(retryOnStationTokenUnavailable(async () => { throw err; }, async (ms) => { waits.push(ms); }))
      .rejects.toBe(err);
    expect(waits).toEqual([...STATION_TOKEN_RETRY_DELAYS_MS]);
  });

  it('never retries any other refusal', async () => {
    let calls = 0;
    await expect(retryOnStationTokenUnavailable(async () => { calls += 1; throw refusal(); }, async () => {}))
      .rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});
