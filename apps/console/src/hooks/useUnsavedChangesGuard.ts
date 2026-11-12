import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { UNSAFE_NavigationContext, parsePath, useLocation, type Navigator, type To } from 'react-router-dom';
import { useHoldHistorySteps } from '../contexts/UrlScopeContext';

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
 * - **Back and Forward**: held by `UrlScopeProvider` before the router hears of them
 *   (`useHoldHistorySteps`), which steps the browser back to this entry; then it asks.
 *   Leaving replays the step. Not a `popstate` listener of the page's own: Chromium runs a
 *   window's listeners in the order they were added, so the history's, added at app mount,
 *   always went first and the page was gone before it could ask. Outside the provider (a
 *   memory router) there is no browser Back to hold.
 * - **Reload, close, typing a URL, an account switch** (a full page load): `beforeunload`, so
 *   the browser asks in its own words.
 *
 * Nothing is held while `dirty` is false; a page clears it by saving or discarding.
 */
export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const { navigator, basename } = useContext(UNSAFE_NavigationContext);
  const { pathname } = useLocation();
  const holdSteps = useHoldHistorySteps();
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
    /** Set once the person chose to leave, so the step that carries it out is not held again. */
    let leaving = false;
    const leaveBy = (delta: number) => () => {
      leaving = true;
      go(delta);
    };
    nav.go = (delta: number) => {
      hold(leaveBy(delta));
    };
    const releaseSteps = holdSteps(({ pathname: to, delta }) => {
      // A step within this page (a hash typed into the address bar) loses nothing.
      if (leaving || to === hereRef.current) return false;
      hold(leaveBy(delta));
      return true;
    });

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older browsers ask only when this is set.
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      nav.push = push;
      nav.replace = replace;
      nav.go = go;
      releaseSteps();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty, navigator, hold, holdSteps]);

  const leave = useCallback(() => {
    const run = pendingRef.current;
    hold(null);
    run?.();
  }, [hold]);
  const stay = useCallback(() => hold(null), [hold]);

  return { asking, leave, stay };
}
