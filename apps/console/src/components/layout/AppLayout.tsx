import { useState, useCallback, useEffect, useRef } from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { GlobalSearch } from '../common/GlobalSearch';
import { usePostHogIdentify } from '../../hooks/usePostHogIdentify';
import { useProductSurface } from '../../analytics/useProductSurface';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import styles from './AppLayout.module.css';

const SIDEBAR_COLLAPSED_KEY = 'mv:sidebar-collapsed';
const MOBILE_SIDEBAR_ID = 'app-mobile-sidebar';
const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AppLayout() {
  const { user, loading } = useAuth();
  usePostHogIdentify();
  // Everything mounted under this shell is the primary AI application; the
  // agency shell tags its own events `'agency'`.
  useProductSurface('ai');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true',
  );
  const isMobile = useMediaQuery('(max-width: 768px)');
  const isDrawerOpen = isMobile && sidebarOpen;
  const mainRef = useRef<HTMLDivElement>(null);

  // The drawer is a mobile-only concept — resetting `sidebarOpen` when the
  // viewport crosses back to desktop keeps a later resize back to mobile from
  // reopening a drawer the user never explicitly opened this time around.
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const handleMenuClick = useCallback(() => {
    setSidebarOpen(prev => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }, []);

  // Closed drawer is removed from the mobile accessibility tree and tab order;
  // background content is isolated, focus is trapped, and Escape closes it
  // while open. Deliberately one effect (not composed hooks) so "un-isolate the
  // background" always happens before "restore focus to the toggle" — those two
  // DOM writes must be ordered relative to each other, which cross-effect
  // cleanup/setup phasing can't guarantee.
  const sidebarRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

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
      if (e.key === 'Tab' && drawer) {
        const focusable = drawer.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);

    const timer = setTimeout(() => {
      drawer?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)?.focus();
    }, 50);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      clearTimeout(timer);
      // Un-isolate the background before returning focus to it — focusing an
      // element inside an inert subtree is a no-op.
      if (main) main.inert = false;
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [isMobile, isDrawerOpen, handleSidebarClose]);

  if (loading) {
    return (
      <div className={styles.layout} aria-busy="true">
        <div className={styles.sidebar}>
          <div className={styles.loadingSidebar}>
            <div className={`${styles.loadingLogo} skeleton`} />
            <div className={styles.loadingNav}>
              {Array.from({ length: 7 }, (_, index) => (
                <div
                  key={index}
                  className={`${styles.loadingNavItem} skeleton`}
                />
              ))}
            </div>
          </div>
        </div>

        <div className={styles.main}>
          <div className={styles.topbar}>
            <div className={styles.loadingTopbar}>
              <div className={`${styles.loadingTopbarPrimary} skeleton`} />
              <div className={styles.loadingTopbarActions}>
                <div className={`${styles.loadingTopbarAction} skeleton`} />
                <div className={`${styles.loadingTopbarAction} skeleton`} />
                <div className={`${styles.loadingTopbarAction} skeleton`} />
              </div>
            </div>
          </div>

          <main className={styles.content}>
            <div className={styles.loadingContent}>
              <div className={`${styles.loadingHeader} skeleton`} />
              <div className={`${styles.loadingSubheader} skeleton`} />
              <div className={styles.loadingGrid}>
                {Array.from({ length: 4 }, (_, index) => (
                  <div
                    key={index}
                    className={`${styles.loadingCard} skeleton`}
                  />
                ))}
              </div>
              <div className={`${styles.loadingTable} skeleton`} />
            </div>
          </main>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className={styles.layout}>
      <a href="#main-content" className={styles.skipLink}>
        Skip to main content
      </a>

      <div
        id={MOBILE_SIDEBAR_ID}
        ref={sidebarRef}
        className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''} ${collapsed ? styles.sidebarCollapsed : ''}`}
        role={isMobile ? 'dialog' : undefined}
        aria-modal={isMobile ? true : undefined}
        aria-label={isMobile ? 'Navigation menu' : undefined}
      >
        <Sidebar collapsed={collapsed} onClose={handleSidebarClose} />
        {/* Collapse is a desktop-only affordance (see AppLayout.module.css); omitting it on
            mobile also keeps it from lingering, hidden-but-tabbable, inside the drawer's focus trap. */}
        {!isMobile && (
          <button
            className={styles.collapseHandle}
            onClick={handleToggleCollapse}
            type="button"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        )}
      </div>

      {sidebarOpen && (
        <div className={styles.overlay} onClick={handleSidebarClose} />
      )}

      <div ref={mainRef} className={`${styles.main} ${collapsed ? styles.mainCollapsed : ''}`}>
        <div className={styles.topbar}>
          <TopBar
            onMenuClick={handleMenuClick}
            menuExpanded={sidebarOpen}
            menuControls={MOBILE_SIDEBAR_ID}
          />
        </div>
        <main id="main-content" className={styles.content}>
          <Outlet />
        </main>
      </div>

      <GlobalSearch />
    </div>
  );
}
