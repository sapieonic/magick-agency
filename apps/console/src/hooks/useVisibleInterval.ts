import { useEffect, useRef } from 'react';

/**
 * Call `fn` every `ms` while `enabled` — but only while the page is visible, and
 * never while the previous call is still running.
 *
 * The two pages that poll a campaign (the campaigns home and the detail page)
 * each had their own `setInterval`, and they had drifted: the home skipped a
 * hidden tab and refused to stack ticks, the detail page did neither, so a
 * backgrounded detail tab kept reading every ten seconds and a slow backend
 * received a new request on top of one it had not answered.
 *
 *  - **Visible only.** A hidden tab skips the tick rather than queueing it;
 *    pair this with `useRefetchOnReturn` to catch up the moment the reader
 *    comes back.
 *  - **Single-flight.** When `fn` returns a promise, ticks that fall due before
 *    it settles are skipped, not stacked.
 *
 * `fn` is read through a ref, so passing a fresh closure each render neither
 * restarts the interval nor calls a stale one.
 */
export function useVisibleInterval(
  fn: () => unknown,
  ms: number,
  enabled: boolean,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight || document.visibilityState !== 'visible') return;
      const result = fnRef.current();
      if (result instanceof Promise) {
        inFlight = true;
        void result.catch(() => {}).finally(() => { inFlight = false; });
      }
    }, ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
}
