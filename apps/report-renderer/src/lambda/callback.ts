/**
 * POSTing the signed callback, with retries: three tries, backing off between them. Each try is
 * signed afresh (the server refuses a timestamp more than five minutes off its clock). A try
 * that gets no 2xx is retried; after the last, the caller reports the SQS message as failed so
 * the queue redelivers it (rendering again is safe: same keys, and the server fences on
 * `run_id` and `attempt`).
 *
 * A 4xx other than 408 and 429 is final: the server refused this callback as it stands (a bad
 * signature is a secret mismatch, a 400 a body it rejects, a 404 a callback URL with no route),
 * and neither a retry nor a re-render changes that. It throws {@link CallbackRefusedError}, which
 * the handler logs without failing the SQS message; the server's tick finds the files in S3 by
 * itself once the render timeout passes. Each try is bounded by `CALLBACK_TIMEOUT_MS`.
 */
import { signCallback } from '../signature';

export interface PostDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number }>;
  sleep: (ms: number) => Promise<void>;
  /** Unix seconds. */
  now: () => number;
}

export const CALLBACK_TRIES = 3;
export const CALLBACK_BACKOFF_MS = [1_000, 4_000];
/** One try's bound: a hung connection must not hold the invocation to the function's timeout. */
export const CALLBACK_TIMEOUT_MS = 15_000;

/** A status the server will answer again whatever is retried (module header). */
export function isFinalRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export class CallbackError extends Error {
  constructor(
    message: string,
    readonly tries: number,
  ) {
    super(message);
    this.name = 'CallbackError';
  }
}

/** The server refused the callback for good (a final 4xx): not retried, not redelivered. */
export class CallbackRefusedError extends Error {
  constructor(readonly status: number) {
    super(`callback refused with http ${status}`);
    this.name = 'CallbackRefusedError';
  }
}

export async function postCallback(url: string, rawBody: string, secret: string, deps: PostDeps, onTry?: (n: number, outcome: string) => void): Promise<number> {
  let last = '';
  for (let n = 1; n <= CALLBACK_TRIES; n++) {
    try {
      const res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signCallback(secret, rawBody, deps.now()) },
        body: rawBody,
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) {
        onTry?.(n, `http ${res.status}`);
        return res.status;
      }
      if (isFinalRefusal(res.status)) {
        onTry?.(n, `http ${res.status} (final)`);
        throw new CallbackRefusedError(res.status);
      }
      last = `http ${res.status}`;
    } catch (error) {
      if (error instanceof CallbackRefusedError) throw error;
      last = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    onTry?.(n, last);
    if (n < CALLBACK_TRIES) await deps.sleep(CALLBACK_BACKOFF_MS[n - 1] ?? 4_000);
  }
  throw new CallbackError(`callback not delivered after ${CALLBACK_TRIES} tries: ${last}`, CALLBACK_TRIES);
}
