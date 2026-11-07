// The carrier refusals the dial path reads through the bridge's wrapping
// (`WebRtcCallError.cause`): auth rejected, rate limited, outcome unknown. Each is read
// through a `cause` chain, and none is mistaken for another.
import { describe, it, expect } from 'vitest';
import {
  CarrierAuthRejectedError,
  CarrierDialNotSentError,
  CarrierDialOutcomeUnknownError,
  CarrierRateLimitedError,
  carrierAuthRejectionReason,
  carrierDialNotSentReason,
  findInCauseChain,
  isCarrierAuthRejected,
  isConnectPhaseFailure,
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

describe('findInCauseChain', () => {
  it('returns the first link the predicate accepts, the error itself first', () => {
    const inner = Object.assign(new Error('inner'), { marker: 2 });
    const outer = Object.assign(new Error('outer'), { marker: 1, cause: inner });
    expect(findInCauseChain(outer, (link) => typeof link['marker'] === 'number')).toBe(outer);
    expect(findInCauseChain(outer, (link) => link['marker'] === 2)).toBe(inner);
    expect(findInCauseChain(outer, (link) => link['marker'] === 3)).toBeUndefined();
  });

  it('skips links that are not objects and stops at a falsy cause', () => {
    const seen: unknown[] = [];
    expect(findInCauseChain('a string', (link) => { seen.push(link); return true; })).toBeUndefined();
    expect(findInCauseChain(null, () => true)).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('reads at most five links, so a cyclic chain ends', () => {
    let visits = 0;
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b');
    a.cause = b;
    b.cause = a;
    expect(findInCauseChain(a, () => { visits++; return false; })).toBeUndefined();
    expect(visits).toBe(5);
    let deep: unknown = Object.assign(new Error('six deep'), { marker: true });
    for (let i = 0; i < 5; i++) deep = wrap(deep);
    expect(findInCauseChain(deep, (link) => link['marker'] === true)).toBeUndefined();
  });

  it('carries the readers built on it', () => {
    expect(carrierAuthRejectionReason(wrap(new CarrierAuthRejectedError('plivo', 401))))
      .toBe('The carrier refused the credential on a dial (HTTP 401)');
    expect(carrierAuthRejectionReason(wrap(new Error('x')))).toBeNull();
    expect(carrierDialNotSentReason(wrap(new CarrierDialNotSentError('plivo', 'destination', 'bad number')))).toBe('destination');
    expect(carrierDialNotSentReason(wrap(new CarrierDialNotSentError('plivo', 'configuration', 'no base')))).toBe('configuration');
    expect(carrierDialNotSentReason(wrap(new Error('x')))).toBeNull();
    const connectFailure = (code: string) =>
      new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    expect(isConnectPhaseFailure(connectFailure('ENOTFOUND'))).toBe(true);
    expect(isConnectPhaseFailure(connectFailure('ECONNRESET'))).toBe(false);
  });
});
