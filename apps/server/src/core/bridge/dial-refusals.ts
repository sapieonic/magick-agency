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
 *
 * The callers' side of the same vocabulary is here too ({@link classifyDialRefusal}): what a
 * bridge rejection means to the paced dialler, the soft phone and the refusal breaker.
 */
import type { CarrierAccountPauseReason } from '@magick-agency/contracts/agency';
import {
  carrierDialNotSentReason,
  carrierDialRefusalStatus,
  isCarrierAuthRejected,
  isCarrierRateLimited,
  isDialOutcomeUnknown,
  type CarrierDialNotSentReason,
} from '../../telephony/carrier-errors.js';
import { WebRtcCallError, type WebRtcRejectReason } from './bridge-types.js';

/**
 * The bridge's admission refusals: no concurrency slot, or no calls-per-second slot (our
 * per-account gate, or the carrier's 429). Nothing was placed and nothing failed: it is
 * back-pressure, says nothing about the contact, and the next attempt is the retry.
 */
export const CAPACITY_REFUSAL_CODES: ReadonlySet<WebRtcRejectReason> = new Set<WebRtcRejectReason>([
  'global_concurrency_limit',
  'account_concurrency_limit',
  'provider_concurrency_limit',
  'provider_concurrency_unavailable',
  'carrier_rate_limited',
]);

/**
 * The refusals that say the carrier account the dial names cannot dial, and the campaign
 * pause each writes (`agency/carrier-account-pause.ts`): the carrier refused the credential
 * (HTTP 401, `carrier_auth`), or the credential is no longer active
 * (`carrier_account_unavailable`). Every further dial on it would be refused the same way.
 */
export const CARRIER_ACCOUNT_PAUSES: ReadonlyMap<WebRtcRejectReason, CarrierAccountPauseReason> = new Map<
  WebRtcRejectReason,
  CarrierAccountPauseReason
>([
  ['carrier_auth_rejected', 'carrier_auth'],
  ['telephony_credential_unavailable', 'carrier_account_unavailable'],
]);

/**
 * Why the adapter would not send the dial, for a bridge rejection `carrier_dial_not_sent`
 * (read through its `cause`), or null for any other error.
 */
export function dialNotSentReason(err: unknown): CarrierDialNotSentReason | null {
  if (!(err instanceof WebRtcCallError) || err.code !== 'carrier_dial_not_sent') return null;
  return carrierDialNotSentReason(err);
}

/**
 * What a dial's rejection means to the callers of the bridge:
 *  - `station_unavailable`: the agent's socket was not open at dial time;
 *  - `capacity`: an admission refusal ({@link CAPACITY_REFUSAL_CODES});
 *  - `carrier_account`: the carrier account cannot dial, with the pause it writes
 *    ({@link CARRIER_ACCOUNT_PAUSES});
 *  - `not_sent`: the adapter would not send the dial, and why;
 *  - `carrier_refused`: the carrier refused the dial (`telephony_init_failed`), with whether
 *    it may have been placed after all (`outcomeUnknown`) and the HTTP status it answered
 *    (`httpStatus`, null when the adapter's error carries none: a timeout, a network fault,
 *    a carrier whose adapter does not say);
 *  - `other`: anything else (a bridge failure before the carrier, or not a bridge rejection).
 */
export type DialRefusal =
  | { kind: 'station_unavailable' }
  | { kind: 'capacity' }
  | { kind: 'carrier_account'; pause: CarrierAccountPauseReason }
  | { kind: 'not_sent'; reason: CarrierDialNotSentReason }
  | { kind: 'carrier_refused'; outcomeUnknown: boolean; httpStatus: number | null }
  | { kind: 'other' };

/** Classify a dial's rejection ({@link DialRefusal}); the one reading every caller shares. */
export function classifyDialRefusal(err: unknown): DialRefusal {
  if (!(err instanceof WebRtcCallError)) return { kind: 'other' };
  if (err.code === 'station_socket_unavailable') return { kind: 'station_unavailable' };
  if (CAPACITY_REFUSAL_CODES.has(err.code)) return { kind: 'capacity' };
  const pause = CARRIER_ACCOUNT_PAUSES.get(err.code);
  if (pause) return { kind: 'carrier_account', pause };
  if (err.code === 'telephony_init_failed') {
    return { kind: 'carrier_refused', outcomeUnknown: isDialOutcomeUnknown(err), httpStatus: carrierDialRefusalStatus(err) };
  }
  const notSent = dialNotSentReason(err);
  if (notSent) return { kind: 'not_sent', reason: notSent };
  return { kind: 'other' };
}

/**
 * Whether a dial the bridge resolved (`createBridgedCall`, `createUnboundBridgedCall`) was
 * sent to the carrier: the record names the leg it placed (a call id, or the dial request
 * id that cancels it). A teardown that ran before the dial was sent (while the bridge
 * prepared it, or while it waited at the calls-per-second gate) resolves too, with neither:
 * nothing reached the carrier, so nothing a caller does for a placed call (the refusal
 * breaker's reset, PL11) applies to it.
 */
export function dialWasSent(record: { provider_call_id?: string | null; provider_request_id?: string | null }): boolean {
  return Boolean(record.provider_call_id || record.provider_request_id);
}

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

/** A calls-per-second limit gave the dial no slot (our gate, or the carrier's 429). */
export const CARRIER_RATE_LIMITED: UnplacedRefusal = {
  code: 'carrier_rate_limited',
  statusCode: 503,
  outcome: 'carrier_rate_limited',
  errorCode: 'CARRIER_RATE_LIMITED',
};

/** The carrier refused the credential itself (HTTP 401). */
export const CARRIER_AUTH_REJECTED: UnplacedRefusal = {
  code: 'carrier_auth_rejected',
  statusCode: 502,
  outcome: 'carrier_auth_rejected',
  errorCode: 'CARRIER_AUTH_REJECTED',
};

/**
 * A carrier request that the adapter refused before anything was placed, or that the
 * carrier answered by placing nothing: a calls-per-second limit (retryable), the carrier
 * refusing the credential itself (HTTP 401), or a dial the adapter would not send
 * (`CarrierDialNotSentError`: no webhook base, a malformed number, the API unreachable).
 * Null for any other dial failure, which stays a carrier refusal.
 */
export function carrierUnplacedRefusal(err: unknown): UnplacedRefusal | null {
  if (isCarrierRateLimited(err)) return CARRIER_RATE_LIMITED;
  if (isCarrierAuthRejected(err)) return CARRIER_AUTH_REJECTED;
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
