import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_NavigationContext, useLocation } from 'react-router-dom';
import { navigationBlockers } from '../utils/navigationBlockers';

export interface UnsavedChangesGuard {
  /** A navigation away is waiting for the person to say whether to leave. */
  asking: boolean;
  /** Leave: carry out the navigation that was held. */
  leave: () => void;
  /** Stay: drop it, and keep the edits on screen. */
  stay: () => void;
}

/** A path without trailing slashes, so `/x/settings/` is the same page as `/x/settings`. */
function samePath(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

/**
 * Hold navigation away from a page while it has unsaved edits, so the page can ask first.
 *
 * The console's router is a plain `<Router>` over `UrlScopeContext`'s browser history
 * (`ScopedRouter`), not a data router, so react-router's `useBlocker` is not available. While
 * `dirty`, this adds a blocker to the navigator's one stack (`utils/navigationBlockers.ts`;
 * nothing is patched per page, so guards mounted together come and go in any order), which
 * covers the same three ways out:
 *
 * - **In-app navigation** (links, the sidebar, search, `navigate()`): a push or replace to
 *   another path is held and `asking` set. A change of hash or query on this path goes through
 *   (the section nav writes `#id` with replace), and so does a trailing slash.
 * - **Back and Forward**: held by `UrlScopeProvider` before the router hears of them, which
 *   steps the browser back to this entry; then it asks. Leaving replays the step. Outside the
 *   provider (a memory router) there is no browser Back to hold.
 * - **Reload, close, typing a URL, an account switch** (a full page load): `beforeunload`, so
 *   the browser asks in its own words.
 *
 * A redirect that must happen (`useUrlScope().go(…, { force: true })`: the open account taken
 * away) is never held. Nothing is held while `dirty` is false; a page clears it by saving or
 * discarding.
 */
export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const { navigator, basename } = useContext(UNSAFE_NavigationContext);
  const { pathname } = useLocation();
  /** The held navigation, run by `leave`; `asking` mirrors whether there is one. */
  const pendingRef = useRef<(() => void) | null>(null);
  const [asking, setAsking] = useState(false);
  const hold = useCallback((run: (() => void) | null) => {
    pendingRef.current = run;
    setAsking(run !== null);
  }, []);

  /** This page's path as the navigator writes it: with the router's basename. */
  const here = basename && basename !== '/' ? `${basename.replace(/\/+$/, '')}${pathname}` : pathname;
  const hereRef = useRef(here);
  hereRef.current = here;

  useEffect(() => {
    if (!dirty) {
      hold(null);
      return undefined;
    }
    const removeBlocker = navigationBlockers(navigator).add(({ pathname: to }, proceed) => {
      // No path (a hash or query alone, or a trailing slash): this page still; nothing is lost.
      if (to !== null && (to === '' || samePath(to) === samePath(hereRef.current))) return false;
      hold(proceed);
      return true;
    });

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      removeBlocker();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty, navigator, hold]);

  const leave = useCallback(() => {
    const run = pendingRef.current;
    hold(null);
    run?.();
  }, [hold]);
  const stay = useCallback(() => hold(null), [hold]);

  return { asking, leave, stay };
}
