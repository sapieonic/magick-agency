// Carrier REST failures whose meaning the dial path must not guess at.
//
// Most carrier failures say plainly that a dial was not placed: a refused login, a 4xx/5xx
// from `add_lead`. Two do not. A dial request the carrier never answered within its timeout,
// and a 200 whose body cannot be read, may each have QUEUED the lead: the carrier can still
// ring the customer seconds later. The dial path treats both as failed (the agent and the
// concurrency slots are released at once, and the call's tokens are cleared, so a late
// media connect from the carrier is refused and closed, which hangs that call up), but it
// must not dial the same contact again while the carrier may still be dialling it. Errors
// that carry `dialOutcomeUnknown: true` say so; {@link isDialOutcomeUnknown} reads it
// through `cause` chains, because the bridge wraps the adapter's error.

/**
 * How long a contact waits before its next dial when the carrier may have queued the one
 * that just failed (an `add_lead` that timed out, or a 2xx whose body could not be read),
 * or when a process died with the dial sent and no answer or bridge recorded (the reaper,
 * `agency/reaper.ts`). The pacing tick would otherwise dial it again at once, while the
 * carrier may still be dialling it: two calls to one customer. 15 min is far beyond any
 * queue the concurrency guards let build at the carrier; a call the carrier does place
 * meanwhile is refused at its media connect and hung up.
 */
export const DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS = 15 * 60_000;

/**
 * When the contact of a dial nothing saw end may be dialled again: a dial sent (`dialed_at`
 * set) and never answered or bridged may still be placed by the carrier, so not before
 * {@link DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS} after it was sent; any other is dialable
 * `now`. The one rule for a campaign attempt the reaper ends (`reapedRedialNotBefore`,
 * `agency/reaper.ts`) and a soft-phone call it ends `orphaned`
 * (`manualNoOutcomeSettlement`, `agency/softphone/manual-disposition.ts`).
 */
export function dialOutcomeUnknownNotBefore(
  dial: { dialed_at: Date | string | null; answered_at: Date | string | null; bridged_at: Date | string | null },
  now: Date = new Date(),
): Date {
  if (dial.dialed_at && !dial.answered_at && !dial.bridged_at) {
    const notBefore = new Date(dial.dialed_at).getTime() + DIAL_OUTCOME_UNKNOWN_REDIAL_DELAY_MS;
    if (notBefore > now.getTime()) return new Date(notBefore);
  }
  return now;
}

/**
 * The `errorCode` the bridge ends a call with when its dial failed with an unknown outcome
 * (`webrtc-bridge-manager.ts`, `telephony_init_failed`): how a lifecycle observer, which sees
 * the code and not the error, tells such a dial from one that plainly failed.
 */
export const DIAL_OUTCOME_UNKNOWN_ERROR_CODE = 'TELEPHONY_INIT_OUTCOME_UNKNOWN';

/** A carrier REST request abandoned after its timeout. */
export class CarrierRequestTimeoutError extends Error {
  constructor(
    /** What timed out, e.g. `VoiceLink /v1/add_lead`, `VoiceLink login`. */
    readonly operation: string,
    readonly timeoutMs: number,
    /** True when the request may have taken effect (a dial request whose answer never came). */
    readonly dialOutcomeUnknown: boolean,
  ) {
    super(`${operation} timed out after ${timeoutMs} ms${dialOutcomeUnknown ? '; the lead may be queued at the carrier' : ''}`);
    this.name = 'CarrierRequestTimeoutError';
  }
}

/** A dial request the carrier answered 2xx in a body that cannot be read: it may have queued the lead. */
export class CarrierDialOutcomeUnknownError extends Error {
  readonly dialOutcomeUnknown = true;
  constructor(message: string) {
    super(message);
    this.name = 'CarrierDialOutcomeUnknownError';
  }
}

/**
 * Whether `err`, or any error in its `cause` chain, says the carrier may have queued the
 * dial. Bounded walk, so a cyclic `cause` cannot loop.
 */
export function isDialOutcomeUnknown(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && (current as { dialOutcomeUnknown?: unknown }).dialOutcomeUnknown === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The carrier refused our credential on a dial (HTTP 401): every further dial on that
 * credential will be refused too, so the caller stops dialling on it rather than charging
 * each contact a failed attempt. Nothing was placed.
 */
export class CarrierAuthRejectedError extends Error {
  readonly carrierAuthRejected = true;
  constructor(
    /** The provider name, e.g. `plivo`. */
    readonly provider: string,
    readonly httpStatus: number,
  ) {
    super(`${provider} refused the credential (HTTP ${httpStatus})`);
    this.name = 'CarrierAuthRejectedError';
  }
}

/**
 * The dial could not be sent for now because of a calls-per-second limit, and was not
 * placed: retry it shortly, it says nothing about the contact.
 *
 *  - `local_gate`: our own per-account gate could not admit the dial in time; nothing
 *    reached the carrier.
 *  - `carrier`: the carrier answered 429 and placed nothing.
 */
export class CarrierRateLimitedError extends Error {
  readonly carrierRateLimited = true;
  constructor(
    readonly provider: string,
    readonly source: 'local_gate' | 'carrier',
    /** How long the dial waited for a slot before giving up (0 for `carrier`). */
    readonly waitedMs: number,
  ) {
    super(source === 'local_gate'
      ? `${provider} dial not sent: the account's calls-per-second limit gave no slot within ${waitedMs} ms`
      : `${provider} refused the dial for its rate limit (HTTP 429)`);
    this.name = 'CarrierRateLimitedError';
  }
}

/** Whether `err`, or an error in its `cause` chain, carries `flag: true`. Bounded walk. */
function causeChainHas(err: unknown, flag: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && (current as Record<string, unknown>)[flag] === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether `err`, or an error in its `cause` chain, is a {@link CarrierAuthRejectedError}. */
export function isCarrierAuthRejected(err: unknown): boolean {
  return causeChainHas(err, 'carrierAuthRejected');
}

/**
 * What `last_error` says when the carrier refused a credential on a dial: the
 * {@link CarrierAuthRejectedError} in `err`'s `cause` chain, in words. Null when there is none.
 */
export function carrierAuthRejectionReason(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === 'object' && (current as Record<string, unknown>)['carrierAuthRejected'] === true) {
      const status = (current as { httpStatus?: unknown }).httpStatus;
      return `The carrier refused the credential on a dial${typeof status === 'number' ? ` (HTTP ${status})` : ''}`;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Whether `err`, or an error in its `cause` chain, is a {@link CarrierRateLimitedError}. */
export function isCarrierRateLimited(err: unknown): boolean {
  return causeChainHas(err, 'carrierRateLimited');
}

/** True for the error `fetch` rejects with when an `AbortSignal.timeout` fires. */
export function isAbortTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
