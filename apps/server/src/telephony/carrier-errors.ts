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

/**
 * A dial request whose outcome cannot be known: the carrier answered 2xx in a body that
 * cannot be read, or the connection failed after the request may have reached it (a reset,
 * a closed socket). Either way it may have queued or placed the call.
 */
export class CarrierDialOutcomeUnknownError extends Error {
  readonly dialOutcomeUnknown = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CarrierDialOutcomeUnknownError';
  }
}

/** How many links of a `cause` chain are read, so a cyclic `cause` cannot loop. */
const CAUSE_CHAIN_DEPTH = 5;

/**
 * The first link of `err`'s `cause` chain (`err` itself first) that `predicate` accepts, or
 * undefined. Links that are not objects are skipped. Bounded walk
 * ({@link CAUSE_CHAIN_DEPTH} links), so a cyclic `cause` cannot loop.
 */
export function findInCauseChain(
  err: unknown,
  predicate: (link: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_CHAIN_DEPTH && current; depth++) {
    if (typeof current === 'object' && predicate(current as Record<string, unknown>)) {
      return current as Record<string, unknown>;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Whether `err`, or an error in its `cause` chain, carries `flag: true`. Bounded walk. */
function causeChainHas(err: unknown, flag: string): boolean {
  return findInCauseChain(err, (link) => link[flag] === true) !== undefined;
}

/**
 * Whether `err`, or any error in its `cause` chain, says the carrier may have queued the
 * dial. Bounded walk, so a cyclic `cause` cannot loop.
 */
export function isDialOutcomeUnknown(err: unknown): boolean {
  return causeChainHas(err, 'dialOutcomeUnknown');
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
 * The carrier answered a dial with a status that refuses it (any non-2xx but 401 and 429,
 * which have their own errors): nothing was placed. `httpStatus` is what it answered, so a
 * caller can tell a refusal about the account or the dial (4xx) from a fault on the
 * carrier's platform (5xx), read through `cause` chains by {@link carrierDialRefusalStatus}.
 */
export class CarrierDialRefusedError extends Error {
  readonly carrierDialRefused = true;
  constructor(
    /** The provider name, e.g. `plivo`. */
    readonly provider: string,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'CarrierDialRefusedError';
  }
}

/**
 * The HTTP status of the {@link CarrierDialRefusedError} in `err`'s `cause` chain, or null
 * when there is none (or it carries no status). Bounded walk.
 */
export function carrierDialRefusalStatus(err: unknown): number | null {
  const refused = findInCauseChain(err, (link) => link['carrierDialRefused'] === true);
  const status = refused?.['httpStatus'];
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/**
 * The dial was abandoned before it was sent, because the caller no longer wanted it
 * (`OutboundCallRequest.signal` aborted: the call was torn down while the dial waited for
 * a calls-per-second slot). Nothing reached the carrier: an unplaced leg.
 */
export class CarrierDialAbortedError extends Error {
  readonly carrierDialAborted = true;
  constructor(readonly provider: string) {
    super(`${provider} dial not sent: the call ended before it could be placed`);
    this.name = 'CarrierDialAbortedError';
  }
}

/**
 * Why a dial was refused before anything was sent to the carrier
 * ({@link CarrierDialNotSentError}):
 *  - `configuration`: something every dial on this carrier account shares, which the
 *    next dial would trip too: no webhook base for the carrier's callbacks, a callback URL
 *    off that base, a caller ID the carrier cannot take, no max duration;
 *  - `destination`: the number dialled is not one the carrier can take (that contact's
 *    data, not the account's);
 *  - `network`: the carrier's API could not be reached at all (DNS, the TCP connect or the
 *    TLS handshake failed), so the request never left this process.
 */
export type CarrierDialNotSentReason = 'configuration' | 'destination' | 'network';

/**
 * The adapter refused the dial before sending anything to the carrier (`reason` says why):
 * an unplaced leg, never the carrier refusing the call, so the dial path tears it down with
 * no `ended` and does not charge the contact (`core/bridge/dial-refusals.ts`).
 */
export class CarrierDialNotSentError extends Error {
  readonly carrierDialNotSent = true;
  constructor(
    readonly provider: string,
    readonly reason: CarrierDialNotSentReason,
    /** What was wrong, for logs and the call row (never shown to a tenant as is). */
    detail: string,
  ) {
    super(`${provider} dial not sent: ${detail}`);
    this.name = 'CarrierDialNotSentError';
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

/** Whether `err`, or an error in its `cause` chain, is a {@link CarrierAuthRejectedError}. */
export function isCarrierAuthRejected(err: unknown): boolean {
  return causeChainHas(err, 'carrierAuthRejected');
}

/**
 * What `last_error` says when the carrier refused a credential on a dial: the
 * {@link CarrierAuthRejectedError} in `err`'s `cause` chain, in words. Null when there is none.
 */
export function carrierAuthRejectionReason(err: unknown): string | null {
  const rejected = findInCauseChain(err, (link) => link['carrierAuthRejected'] === true);
  if (!rejected) return null;
  const status = rejected['httpStatus'];
  return `The carrier refused the credential on a dial${typeof status === 'number' ? ` (HTTP ${status})` : ''}`;
}

/** Whether `err`, or an error in its `cause` chain, is a {@link CarrierDialAbortedError}. */
export function isCarrierDialAborted(err: unknown): boolean {
  return causeChainHas(err, 'carrierDialAborted');
}

/**
 * The {@link CarrierDialNotSentReason} of the {@link CarrierDialNotSentError} in `err`'s
 * `cause` chain, or null when there is none. Bounded walk.
 */
export function carrierDialNotSentReason(err: unknown): CarrierDialNotSentReason | null {
  const notSent = findInCauseChain(err, (link) => link['carrierDialNotSent'] === true);
  if (!notSent) return null;
  return notSent['reason'] === 'destination' || notSent['reason'] === 'network' ? notSent['reason'] : 'configuration';
}

/** Whether `err`, or an error in its `cause` chain, is a {@link CarrierRateLimitedError}. */
export function isCarrierRateLimited(err: unknown): boolean {
  return causeChainHas(err, 'carrierRateLimited');
}

/**
 * Network error codes that can only come before the request was written: the host was
 * not resolved, the TCP connect was refused or timed out, or the TLS handshake refused the
 * peer's certificate. A reset or a closed socket (`ECONNRESET`, `UND_ERR_SOCKET`, …) is not
 * here: it can come after the request reached the carrier.
 */
const CONNECT_PHASE_ERROR_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * Whether a `fetch` rejection (or an error in its `cause` chain: undici wraps the socket's
 * error in `TypeError('fetch failed')`) says the request was never sent
 * ({@link CONNECT_PHASE_ERROR_CODES}). False for anything else, which may have reached
 * the carrier.
 */
export function isConnectPhaseFailure(err: unknown): boolean {
  return findInCauseChain(err, (link) => typeof link['code'] === 'string' && CONNECT_PHASE_ERROR_CODES.has(link['code'])) !== undefined;
}

/** True for the error `fetch` rejects with when an `AbortSignal.timeout` fires. */
export function isAbortTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
