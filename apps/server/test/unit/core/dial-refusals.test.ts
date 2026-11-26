// The one reading of a dial's rejection that the paced dialler, the soft phone and the
// carrier refusal breaker share (`core/bridge/dial-refusals.ts`).
import { describe, it, expect } from 'vitest';
import {
  CAPACITY_REFUSAL_CODES,
  CARRIER_ACCOUNT_PAUSES,
  CARRIER_API_REFUSED_ERROR_CODE,
  carrierInitFailureErrorCode,
  carrierUnplacedRefusal,
  classifyDialRefusal,
  dialNotSentReason,
  isCredentialUnavailable,
} from '../../../src/core/bridge/dial-refusals.js';
import { WebRtcCallError, type WebRtcRejectReason } from '../../../src/core/bridge/bridge-types.js';
import {
  CarrierApiRefusedError,
  CarrierRequestTimeoutError,
  DIAL_OUTCOME_UNKNOWN_ERROR_CODE,
  CarrierDialNotSentError,
  CarrierDialOutcomeUnknownError,
  CarrierDialRefusedError,
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
      'carrier_account_concurrency_limit',
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
    expect(classifyDialRefusal(rejection('telephony_init_failed'))).toEqual({ kind: 'carrier_refused', outcomeUnknown: false, httpStatus: null });
    expect(classifyDialRefusal(rejection('telephony_init_failed', new CarrierDialOutcomeUnknownError('maybe'))))
      .toEqual({ kind: 'carrier_refused', outcomeUnknown: true, httpStatus: null });
    expect(classifyDialRefusal(rejection('telephony_init_failed', new CarrierDialRefusedError('plivo', 403, 'geo'))))
      .toEqual({ kind: 'carrier_refused', outcomeUnknown: false, httpStatus: 403 });
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

describe('a dial refused after the carrier took the login (CR4: CarrierApiRefusedError)', () => {
  const apiRefused = () => new CarrierApiRefusedError('voicelink', 401, 'VoiceLink /v1/add_lead error 401: {}');

  it('is a carrier refusal with an `ended` (not unplaced: no credential mark, no carrier_auth pause), classified apart', () => {
    expect(carrierUnplacedRefusal(apiRefused())).toBeNull();
    expect(classifyDialRefusal(rejection('telephony_init_failed', apiRefused()))).toEqual({ kind: 'carrier_api_refused' });
    // Read through the bridge's wrapping only: a bare adapter error is not a bridge rejection.
    expect(classifyDialRefusal(apiRefused())).toEqual({ kind: 'other' });
  });

  it('ends the call with its own error code; unknown outcome and every other refusal keep theirs', () => {
    expect(CARRIER_API_REFUSED_ERROR_CODE).toBe('CARRIER_API_REFUSED');
    expect(carrierInitFailureErrorCode(apiRefused())).toBe('CARRIER_API_REFUSED');
    expect(carrierInitFailureErrorCode(Object.assign(new Error('wrapped'), { cause: apiRefused() }))).toBe('CARRIER_API_REFUSED');
    expect(carrierInitFailureErrorCode(new CarrierRequestTimeoutError('VoiceLink /v1/add_lead', 1, true))).toBe(DIAL_OUTCOME_UNKNOWN_ERROR_CODE);
    expect(carrierInitFailureErrorCode(new CarrierDialRefusedError('voicelink', 403, 'x'))).toBe('TELEPHONY_INIT_FAILED');
    expect(carrierInitFailureErrorCode(new Error('VoiceLink /v1/add_lead error 401'))).toBe('TELEPHONY_INIT_FAILED');
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

describe('isCredentialUnavailable (PL3 and its addendum)', () => {
  it('is the credential that cannot dial, not a keyring fault on this server', () => {
    const byoc = (keyringFault: boolean) => Object.assign(new Error('x'), { credentialUnavailable: true, keyringFault });
    expect(isCredentialUnavailable(byoc(false))).toBe(true);
    expect(isCredentialUnavailable(Object.assign(new Error('x'), { credentialUnavailable: true }))).toBe(true);
    expect(isCredentialUnavailable(Object.assign(new Error('x'), { code: 'telephony_credential_not_active' }))).toBe(true);
    // A missing master key or no keyring: the credential is fine, the server is not.
    expect(isCredentialUnavailable(byoc(true))).toBe(false);
    expect(isCredentialUnavailable(new Error('boom'))).toBe(false);
    expect(isCredentialUnavailable(null)).toBe(false);
  });
});
