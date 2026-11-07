// The carrier refusals the dial path reads through the bridge's wrapping
// (`WebRtcCallError.cause`): auth rejected, rate limited, outcome unknown. Each is read
// through a `cause` chain, and none is mistaken for another.
import { describe, it, expect } from 'vitest';
import {
  CarrierAuthRejectedError,
  CarrierDialOutcomeUnknownError,
  CarrierRateLimitedError,
  isCarrierAuthRejected,
  isCarrierRateLimited,
  isDialOutcomeUnknown,
} from '../../../src/telephony/carrier-errors.js';

const wrap = (cause: unknown) => Object.assign(new Error('Telephony initiation failed'), { cause });

describe('carrier refusals', () => {
  it('are read through a cause chain', () => {
    expect(isCarrierAuthRejected(wrap(new CarrierAuthRejectedError('plivo', 401)))).toBe(true);
    expect(isCarrierRateLimited(wrap(wrap(new CarrierRateLimitedError('plivo', 'local_gate', 5000))))).toBe(true);
  });

  it('are distinct from one another and from an unknown outcome', () => {
    const auth = new CarrierAuthRejectedError('plivo', 401);
    const rate = new CarrierRateLimitedError('plivo', 'carrier', 0);
    const unknown = new CarrierDialOutcomeUnknownError('maybe placed');
    expect([isCarrierAuthRejected(auth), isCarrierRateLimited(auth), isDialOutcomeUnknown(auth)]).toEqual([true, false, false]);
    expect([isCarrierAuthRejected(rate), isCarrierRateLimited(rate), isDialOutcomeUnknown(rate)]).toEqual([false, true, false]);
    expect([isCarrierAuthRejected(unknown), isCarrierRateLimited(unknown)]).toEqual([false, false]);
    expect(isCarrierAuthRejected(new Error('401'))).toBe(false);
    expect(isCarrierAuthRejected(null)).toBe(false);
  });

  it('a cyclic cause chain ends', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(isCarrierAuthRejected(a)).toBe(false);
  });

  it('say what happened without naming a secret', () => {
    expect(new CarrierAuthRejectedError('plivo', 401).message).toBe('plivo refused the credential (HTTP 401)');
    expect(new CarrierRateLimitedError('plivo', 'local_gate', 5000).message).toMatch(/no slot within 5000 ms/);
    expect(new CarrierRateLimitedError('plivo', 'carrier', 0).message).toMatch(/HTTP 429/);
  });
});
