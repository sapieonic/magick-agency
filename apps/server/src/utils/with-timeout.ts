/**
 * Settle with a promise, or reject after a bound, whichever is first. Imports nothing, so
 * `instrumentation.ts` (the first import of `src/index.ts`, which must not pull the app graph in
 * ahead of the OTel SDK) can use it as freely as the report assembler.
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
