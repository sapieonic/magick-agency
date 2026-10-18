import { useEffect, useRef } from 'react';

/**
 * Call `fn` when the reader comes back to this page: the tab becoming visible
 * again, or the window regaining focus.
 *
 * Both events, because two side-by-side windows both stay `visible`, so
 * `visibilitychange` never fires when a supervisor clicks back into this one —
 * `focus` is the event that does (`AuthContext` listens to both for the same
 * reason). A focus while the tab is hidden is ignored.
 *
 * `fn` is read through a ref, so the listeners are attached once.
 */
export function useRefetchOnReturn(fn: () => unknown): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'visible') void fnRef.current();
    };
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, []);
}
