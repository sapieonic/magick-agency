import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { AgentLanding } from '../agency/AgentLanding';
import { GlobalSearch } from '../common/GlobalSearch';
import { usePostHogIdentify } from '../../hooks/usePostHogIdentify';
import { useProductSurface } from '../../analytics/useProductSurface';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { isAgencyPath, productSurfaceForPath } from '../../utils/consoleNav';
import { FOCUSABLE_SELECTOR, trapTab } from '@magick-agency/web-ui/hooks/useDialogFocus';
import { ConsoleSidebar } from './ConsoleSidebar';
import { ConsoleTopBar } from './ConsoleTopBar';
import styles from './ConsoleLayout.module.css';

export const MOBILE_SIDEBAR_ID = 'console-mobile-sidebar';

/**
 * The console's one shell (decision B28), around every signed-in page except an agent's
 * full-viewport surfaces (`/station`, `/dialer/*`): the work pages under `/agency`, the
 * Settings hub under `/settings`, and the legacy `/app` URLs while they redirect.
 *
 * It replaced two shells, an agency workspace and a "Team & settings" zone, between which
 * four sidebar entries and a "Switch to Magick Agency" link moved people back and forth.
 * Settings now sits in the same sidebar as the work, so nothing leaves the shell.
 *
 * Not an auth boundary: `RequireAuth` wraps it in `App.tsx`, and each route keeps its own
 * capability, flag and permission guards.
 */
export function ConsoleLayout() {
  usePostHogIdentify();
  const { pathname } = useLocation();
  /*
   * The analytics `product`: `'agency'` on the work pages and `'ai'` on Settings, the values
   * the two old shells sent, so the series carry on. One declaration for the whole shell;
   * the hook re-registers when the reader crosses between the two.
   */
  useProductSurface(productSurfaceForPath(pathname));
  const { accountId } = useTenant();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isDrawerOpen = isMobile && sidebarOpen;
  const mainRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // The drawer is a phone-only idea: crossing back to desktop forgets it was open, so a later
  // resize to a phone does not reopen a drawer nobody asked for this time.
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleMenuClick = useCallback(() => setSidebarOpen((prev) => !prev), []);
  const handleSidebarClose = useCallback(() => setSidebarOpen(false), []);

  // A closed drawer is out of the phone's accessibility tree and tab order; an open one
  // isolates the background, traps focus, and closes on Escape. One effect rather than
  // composed hooks, so "un-isolate the background" always happens before "return focus to the
  // toggle": focusing inside an inert subtree is a no-op.
  useEffect(() => {
    const drawer = sidebarRef.current;
    const main = mainRef.current;

    if (!isMobile) {
      if (drawer) drawer.inert = false;
      if (main) main.inert = false;
      return;
    }

    if (!isDrawerOpen) {
      if (drawer) drawer.inert = true;
      if (main) main.inert = false;
      return;
    }

    if (main) main.inert = true;
    if (drawer) drawer.inert = false;
    previousFocusRef.current = document.activeElement as HTMLElement | null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleSidebarClose();
        return;
      }
      trapTab(e, drawer);
    };
    document.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      drawer?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      if (main) main.inert = false;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isMobile, isDrawerOpen, handleSidebarClose]);

  return (
    <div className={styles.layout}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to main content
      </a>

      <div
        id={MOBILE_SIDEBAR_ID}
        ref={sidebarRef}
        className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile ? true : undefined}
        aria-label={isMobile ? 'Navigation menu' : undefined}
      >
        <ConsoleSidebar onClose={handleSidebarClose} />
      </div>

      {sidebarOpen && <div className={styles.overlay} onClick={handleSidebarClose} />}

      <div ref={mainRef} className={styles.main}>
        <div className={styles.topbar}>
          <ConsoleTopBar
            onMenuClick={handleMenuClick}
            menuExpanded={sidebarOpen}
            menuControls={MOBILE_SIDEBAR_ID}
          />
        </div>
        <main id="main-content" className={styles.content}>
          {/*
            Keyed by account, so a switch REMOUNTS the page rather than re-rendering it: every
            id on an agency page is account-scoped (a campaign, a draft mid-build, a roster
            awaiting its mapping), and a page left mounted while requests carry the new
            account header would show one account's data and write to another's. A switch is
            a full page load today (B26); the key stays as the second line of defence.
          */}
          <Outlet key={accountId ?? 'no-account'} />
        </main>
      </div>

      {/* ⌘K / Ctrl+K, on every page of the shell. */}
      <GlobalSearch />
    </div>
  );
}

/**
 * The shell as `App.tsx` mounts it: `ConsoleLayout` behind `AgentLanding`, which sends a
 * DEDICATED agent from Settings and the legacy `/app` URLs to `/dialer` (as it did for the old
 * `/app` shell). It is switched off under `/agency`, whose pages send an agent to their own
 * `/dialer/*` twin. The layout renders in the same place either way, so crossing between
 * `/agency` and `/settings` does not remount it.
 */
export function ConsoleShell() {
  const { pathname } = useLocation();
  return (
    <AgentLanding enabled={!isAgencyPath(pathname)}>
      <ConsoleLayout />
    </AgentLanding>
  );
}
