import { useEffect, useRef, type MutableRefObject } from 'react';

/**
 * `true` while the component is mounted, for a guard on async work that cannot
 * itself be cancelled (there is no `AbortController` on this API layer): "is there
 * still anything to render into?" before a `setState` that lands after the await.
 *
 * **Set on the way IN as well as cleared on the way out.** `React.StrictMode`
 * (which `main.tsx` wraps the whole app in) runs every effect setup → cleanup →
 * setup in development, so a cleanup-only effect leaves this `false` while the
 * component is very much mounted — every response is then discarded as stale and
 * the surface spins forever (or, on the station's switch flow, a permanent
 * "Switching…" with Cancel doing nothing). A defect that exists only in
 * development is still a defect: it is the build every reviewer and every
 * developer sees.
 *
 * Nine files carried this effect by hand, each with its own copy of that
 * paragraph; they read this instead.
 */
export function useMountedRef(): MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
