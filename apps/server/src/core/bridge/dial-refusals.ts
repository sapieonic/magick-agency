/**
 * Dials the bridge refuses with nothing placed at the carrier, each with its own code
 * (`WebRtcRejectReason`), so a caller can tell them from a carrier's refusal of a dial
 * (`telephony_init_failed`, which ends the call with an `ended` and may be charged to the
 * contact). Each tears the registered call down with no `ended` (`abortUnplacedLeg`) and
 * rejects with a {@link WebRtcCallError} whose `cause` is the original error.
 *
 * Errors are recognised by the flags their classes carry rather than `instanceof`: the
 * bridge's suites mock the modules that define them (the call repository, the provider
 * registry), so the classes are not importable there.
 */
import { carrierDialNotSentReason, isCarrierAuthRejected, isCarrierRateLimited } from '../../telephony/carrier-errors.js';
import { WebRtcCallError, type WebRtcRejectReason } from './bridge-types.js';

/** How an unplaced refusal is recorded on the call row and reported to the caller. */
export interface UnplacedRefusal {
  code: WebRtcRejectReason;
  statusCode: number;
  /** `agency_calls.outcome` / `error_code` of the torn-down row. */
  outcome: string;
  errorCode: string;
}

/**
 * The tenant credential the dial names cannot dial: `TelephonyCredentialNotActiveError`
 * from the call row's insert (`code: 'telephony_credential_not_active'`), or
 * `ByocCredentialUnavailableError` from the registry (`credentialUnavailable: true`).
 */
export function isCredentialUnavailable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { credentialUnavailable?: unknown; code?: unknown };
  return e.credentialUnavailable === true || e.code === 'telephony_credential_not_active';
}

export const CREDENTIAL_UNAVAILABLE: UnplacedRefusal = {
  code: 'telephony_credential_unavailable',
  statusCode: 409,
  outcome: 'telephony_credential_unavailable',
  errorCode: 'TELEPHONY_CREDENTIAL_UNAVAILABLE',
};

/**
 * The `errorCode` of a dial the adapter refused before sending anything
 * (`CarrierDialNotSentError`): `CARRIER_DIAL_INVALID_NUMBER` when the number dialled was
 * the problem (`destination`), else `CARRIER_DIAL_NOT_SENT` (`configuration`, `network`).
 */
export const CARRIER_DIAL_NOT_SENT_ERROR_CODE = 'CARRIER_DIAL_NOT_SENT';
export const CARRIER_DIAL_INVALID_NUMBER_ERROR_CODE = 'CARRIER_DIAL_INVALID_NUMBER';

/**
 * A carrier request that the adapter refused before anything was placed, or that the
 * carrier answered by placing nothing: a calls-per-second limit (retryable), the carrier
 * refusing the credential itself (HTTP 401), or a dial the adapter would not send
 * (`CarrierDialNotSentError`: no webhook base, a malformed number, the API unreachable).
 * Null for any other dial failure, which stays a carrier refusal.
 */
export function carrierUnplacedRefusal(err: unknown): UnplacedRefusal | null {
  if (isCarrierRateLimited(err)) {
    return { code: 'carrier_rate_limited', statusCode: 503, outcome: 'carrier_rate_limited', errorCode: 'CARRIER_RATE_LIMITED' };
  }
  if (isCarrierAuthRejected(err)) {
    return { code: 'carrier_auth_rejected', statusCode: 502, outcome: 'carrier_auth_rejected', errorCode: 'CARRIER_AUTH_REJECTED' };
  }
  const notSent = carrierDialNotSentReason(err);
  if (notSent) {
    return {
      code: 'carrier_dial_not_sent',
      statusCode: 503,
      outcome: 'carrier_dial_not_sent',
      errorCode: notSent === 'destination' ? CARRIER_DIAL_INVALID_NUMBER_ERROR_CODE : CARRIER_DIAL_NOT_SENT_ERROR_CODE,
    };
  }
  return null;
}

/** The rejection for an unplaced refusal, carrying the original error as `cause`. */
export function unplacedRefusalError(refusal: UnplacedRefusal, err: unknown): WebRtcCallError {
  const out = new WebRtcCallError(
    err instanceof Error ? err.message : String(err),
    refusal.code,
    refusal.statusCode,
  );
  out.cause = err;
  return out;
}
