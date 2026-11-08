/**
 * POSTing the signed callback, with retries: three tries, backing off between them. Each try is
 * signed afresh (the server refuses a timestamp more than five minutes off its clock). A try
 * that gets no 2xx is retried; after the last, the caller reports the SQS message as failed so
 * the queue redelivers it (rendering again is safe: same keys, and the server fences on
 * `run_id` and `attempt`).
 */
import { signCallback } from '../signature';

export interface PostDeps {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;
  sleep: (ms: number) => Promise<void>;
  /** Unix seconds. */
  now: () => number;
}

export const CALLBACK_TRIES = 3;
export const CALLBACK_BACKOFF_MS = [1_000, 4_000];

export class CallbackError extends Error {
  constructor(
    message: string,
    readonly tries: number,
  ) {
    super(message);
    this.name = 'CallbackError';
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
      });
      if (res.status >= 200 && res.status < 300) {
        onTry?.(n, `http ${res.status}`);
        return res.status;
      }
      last = `http ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }
    onTry?.(n, last);
    if (n < CALLBACK_TRIES) await deps.sleep(CALLBACK_BACKOFF_MS[n - 1] ?? 4_000);
  }
  throw new CallbackError(`callback not delivered after ${CALLBACK_TRIES} tries: ${last}`, CALLBACK_TRIES);
}
