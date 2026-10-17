import { useEffect } from 'react';
import { isSessionExpired } from '../utils/session';

/**
 * While signed in, check the 6-hour absolute session cap once a minute and on
 * every return to the tab (focus, visibility), so an idle open tab is logged
 * out promptly once the session ages out rather than on its next request.
 *
 * Checks once straight away too: a tab restored after the cap passed must not
 * wait a minute to notice, and again whenever the signed-in user object
 * changes. `expireSession` must be stable (a `useCallback`), or every render
 * re-arms the interval.
 */
export function useSessionWatchdog(signedInUser: object | null, expireSession: () => Promise<void>): void {
  useEffect(() => {
    if (!signedInUser) return;
    const check = () => { if (isSessionExpired()) void expireSession(); };
    check();
    const intervalId = window.setInterval(check, 60_000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [signedInUser, expireSession]);
}
