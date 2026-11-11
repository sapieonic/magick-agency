import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_NavigationContext, parsePath, useLocation, type Navigator, type To } from 'react-router-dom';

export interface UnsavedChangesGuard {
  /** A navigation away is waiting for the person to say whether to leave. */
  asking: boolean;
  /** Leave: carry out the navigation that was held. */
  leave: () => void;
  /** Stay: drop it, and keep the edits on screen. */
  stay: () => void;
}

/**
 * Hold navigation away from a page while it has unsaved edits, so the page can ask first.
 *
 * The console's router is a plain `<Router>` over `UrlScopeContext`'s browser history
 * (`ScopedRouter`), not a data router, so react-router's `useBlocker` is not available. This
 * covers the same three ways out:
 *
 * - **In-app navigation** (links, the sidebar, search, `navigate()`): while `dirty`, the
 *   router's navigator holds any push or replace to another path and sets `asking`. A change
 *   of hash or query on this path goes through (the section nav writes `#id` with replace).
 * - **Back and Forward**: a `popstate` listener in the capture phase, which runs before the
 *   history's own, stops the event and steps the browser back to this entry, then asks.
 *   Leaving replays the step. It needs the entry index react-router keeps in `history.state`;
 *   without one (a memory router) the step goes through.
 * - **Reload, close, typing a URL, an account switch** (a full page load): `beforeunload`, so
 *   the browser asks in its own words.
 *
 * Nothing is held while `dirty` is false; a page clears it by saving or discarding.
 */
export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const { navigator, basename } = useContext(UNSAFE_NavigationContext);
  const { pathname, key } = useLocation();
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

  /** This entry's index in the browser history (react-router keeps it in `history.state.idx`). */
  const indexRef = useRef<number | null>(null);
  useEffect(() => {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    indexRef.current = typeof idx === 'number' ? idx : null;
  }, [key]);

  useEffect(() => {
    if (!dirty) {
      hold(null);
      return undefined;
    }
    const nav = navigator as Navigator;
    const { push, replace, go } = nav;
    const samePage = (to: To) => {
      const target = typeof to === 'string' ? parsePath(to) : to;
      return target.pathname === undefined || target.pathname === '' || target.pathname === hereRef.current;
    };
    nav.push = (...args: Parameters<Navigator['push']>) => {
      if (samePage(args[0])) push(...args);
      else hold(() => push(...args));
    };
    nav.replace = (...args: Parameters<Navigator['replace']>) => {
      if (samePage(args[0])) replace(...args);
      else hold(() => replace(...args));
    };
    nav.go = (delta: number) => {
      hold(() => go(delta));
    };

    let reverting = false;
    let leaving = false;
    const onPopState = (event: PopStateEvent) => {
      if (leaving) return;
      if (reverting) {
        // The browser coming back to this entry, which this listener asked for.
        reverting = false;
        event.stopImmediatePropagation();
        return;
      }
      const to = (event.state as { idx?: unknown } | null)?.idx;
      const from = indexRef.current;
      if (typeof to !== 'number' || from === null || to === from) return;
      if (window.location.pathname === hereRef.current) return;
      event.stopImmediatePropagation();
      reverting = true;
      window.history.go(from - to);
      hold(() => {
        leaving = true;
        window.history.go(to - from);
      });
    };

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = '';
    };

    window.addEventListener('popstate', onPopState, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      nav.push = push;
      nav.replace = replace;
      nav.go = go;
      window.removeEventListener('popstate', onPopState, true);
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
