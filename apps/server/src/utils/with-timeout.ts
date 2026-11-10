/**
 * Settle with a promise, or reject after a bound, whichever is first. Imports nothing, so
 * `instrumentation.ts` (the first import of `src/index.ts`, which must not pull the app graph in
 * ahead of the OTel SDK) can use it. It stops only the WAIT: for work that holds a resource (a
 * cursor, an upload) use an `AbortSignal` the work honours, as the report assembler does.
 */

/**
 * Settle with `promise`, or reject with an `Error` ("`what` timed out after `ms`ms") after `ms`,
 * whichever is first. The timer is cleared on settle and `unref`ed, so it never holds the process
 * open. The work itself is not cancelled: it settles on its own, unobserved.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Settle with `promise`, or resolve with `fallback` after `ms`, whichever is first: the bounded
 * wait whose timeout is an answer, not an error. A rejection of `promise` within the bound rejects.
 * The timer is cleared on settle and `unref`ed, as {@link withTimeout}'s.
 */
export function withTimeoutOr<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
