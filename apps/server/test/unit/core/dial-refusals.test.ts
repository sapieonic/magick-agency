// The one reading of a dial's rejection that the paced dialler, the soft phone and the
// carrier refusal breaker share (`core/bridge/dial-refusals.ts`).
import { describe, it, expect } from 'vitest';
import {
  CAPACITY_REFUSAL_CODES,
  CARRIER_ACCOUNT_PAUSES,
  classifyDialRefusal,
  dialNotSentReason,
} from '../../../src/core/bridge/dial-refusals.js';
import { WebRtcCallError, type WebRtcRejectReason } from '../../../src/core/bridge/bridge-types.js';
import {
  CarrierDialNotSentError,
  CarrierDialOutcomeUnknownError,
  type CarrierDialNotSentReason,
} from '../../../src/telephony/carrier-errors.js';

const rejection = (code: WebRtcRejectReason, cause?: unknown): WebRtcCallError => {
  const err = new WebRtcCallError('refused', code, 503);
  if (cause !== undefined) err.cause = cause;
  return err;
};
const notSent = (reason: CarrierDialNotSentReason) =>
  rejection('carrier_dial_not_sent', new CarrierDialNotSentError('plivo', reason, 'detail'));

describe('classifyDialRefusal', () => {
  it('reads every admission and calls-per-second refusal as capacity', () => {
    expect([...CAPACITY_REFUSAL_CODES].sort()).toEqual([
      'account_concurrency_limit',
      'carrier_rate_limited',
      'global_concurrency_limit',
      'provider_concurrency_limit',
      'provider_concurrency_unavailable',
    ]);
    for (const code of CAPACITY_REFUSAL_CODES) expect(classifyDialRefusal(rejection(code))).toEqual({ kind: 'capacity' });
  });

  it('reads a refused or inactive credential as the carrier account, with its pause', () => {
    expect(Object.fromEntries(CARRIER_ACCOUNT_PAUSES)).toEqual({
      carrier_auth_rejected: 'carrier_auth',
      telephony_credential_unavailable: 'carrier_account_unavailable',
    });
    expect(classifyDialRefusal(rejection('carrier_auth_rejected'))).toEqual({ kind: 'carrier_account', pause: 'carrier_auth' });
    expect(classifyDialRefusal(rejection('telephony_credential_unavailable')))
      .toEqual({ kind: 'carrier_account', pause: 'carrier_account_unavailable' });
  });

  it('reads a dead station, a carrier refusal and a dial not sent', () => {
    expect(classifyDialRefusal(rejection('station_socket_unavailable'))).toEqual({ kind: 'station_unavailable' });
    expect(classifyDialRefusal(rejection('telephony_init_failed'))).toEqual({ kind: 'carrier_refused', outcomeUnknown: false });
    expect(classifyDialRefusal(rejection('telephony_init_failed', new CarrierDialOutcomeUnknownError('maybe'))))
      .toEqual({ kind: 'carrier_refused', outcomeUnknown: true });
    for (const reason of ['configuration', 'destination', 'network'] as const) {
      expect(classifyDialRefusal(notSent(reason))).toEqual({ kind: 'not_sent', reason });
    }
  });

  it('reads anything else as other', () => {
    expect(classifyDialRefusal(new Error('boom'))).toEqual({ kind: 'other' });
    expect(classifyDialRefusal(null)).toEqual({ kind: 'other' });
    // The code without the adapter's error behind it says nothing about why.
    expect(classifyDialRefusal(rejection('carrier_dial_not_sent'))).toEqual({ kind: 'other' });
  });
});

describe('dialNotSentReason', () => {
  it('answers only for a bridge rejection carrier_dial_not_sent', () => {
    expect(dialNotSentReason(notSent('destination'))).toBe('destination');
    expect(dialNotSentReason(new CarrierDialNotSentError('plivo', 'destination', 'bad number'))).toBeNull();
    expect(dialNotSentReason(rejection('telephony_init_failed', new CarrierDialNotSentError('plivo', 'network', 'dns'))))
      .toBeNull();
  });
});
