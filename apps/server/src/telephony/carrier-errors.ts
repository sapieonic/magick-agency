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

/** True for the error `fetch` rejects with when an `AbortSignal.timeout` fires. */
export function isAbortTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}
