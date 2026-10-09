import { useState, useCallback } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { Menu, Settings } from 'lucide-react';
import { AgencySidebar } from './AgencySidebar';
import { TenantSwitcher } from './TenantSwitcher';
import { AccountSwitcher } from './AccountSwitcher';
import { useTenant } from '../../contexts/TenantContext';
import { useProductSurface } from '../../analytics/useProductSurface';
import styles from './AgencyLayout.module.css';

/**
 * The Agency workspace shell.
 *
 * A second shell rather than a section of `AppLayout`, for the reason the UX
 * spec gives for the station (§A.1) and one more: the two products have
 * different navigation *shapes*. The main app's sidebar is nine collapsible
 * sections built for browsing; agency is three destinations an operator returns
 * to all day. Folding agency into the main tree would add a tenth section that
 * is mostly empty, and folding the main tree into agency would put nine
 * irrelevant sections in front of a supervisor watching a live campaign.
 *
 * It is NOT a separate auth tree. Unlike `/super-admin/*`, this shares Firebase
 * auth, the tenant/account context, RBAC, and `apiFetch` — the only thing that
 * changes is the chrome. Treating it as a second auth boundary would be a
 * security surface invented for a layout preference.
 */
export function AgencyLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { accountId, accounts } = useTenant();
  // Every event fired inside this workspace belongs to the agency product. Set
  // here for the same reason the shell exists: it is the one place that knows
  // this for everything mounted under it.
  useProductSurface('agency');

  const handleMenuClick = useCallback(() => setSidebarOpen((prev) => !prev), []);
  const handleSidebarClose = useCallback(() => setSidebarOpen(false), []);

  return (
    <div className={styles.layout}>
      <div className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ''}`}>
        <AgencySidebar onClose={handleSidebarClose} />
      </div>

      {sidebarOpen && <div className={styles.overlay} onClick={handleSidebarClose} />}

      <div className={styles.main}>
        <div className={styles.topbar}>
          <button className={styles.menuBtn} onClick={handleMenuClick} aria-label="Toggle menu">
            <Menu size={20} />
          </button>

          {/*
            The way to the platform zone (`/app`: Team, Notifications, Call
            summaries — this console's own pages). Rendered in the topbar rather
            than the sidebar so it survives the mobile breakpoint, where the
            sidebar is behind a menu button and an exit hidden inside a drawer is
            not an exit.

            PORT NOTE (magick-agency, decision B17): cusui labelled this "Back to
            MagickVoice" with a back arrow, because `/app` was the parent
            product. Here `/app` is in-product, so the link stays (removing it
            would leave a supervisor no way to Team or Call summaries from the
            workspace) and says where it goes instead. The label is hidden below
            the mobile breakpoint, so the link carries the name itself.
          */}
          <Link to="/app" className={styles.backLink} aria-label="Team and settings">
            <Settings size={16} aria-hidden="true" />
            <span>Team &amp; settings</span>
          </Link>

          <div className={styles.topbarRight}>
            <TenantSwitcher />
            <AccountSwitcher />
          </div>
        </div>

        {/*
          Every agency call is account-scoped: core requires `x-mgkvc-account` on
          every authenticated route and answers 400 without it. Rather than let
          each page fire a request that fails with a header error naming nothing
          the operator can act on, the shell says what is missing once. Only
          reachable when the tenant genuinely has no account, since the context
          auto-selects the stored, then default, then first account.
        */}
        {!accountId ? (
          <main className={styles.content}>
            <div className={styles.noAccount}>
              <h2>Select an account</h2>
              <p>
                {accounts.length === 0
                  ? 'This workspace has no accounts yet. An account is where campaigns, contacts and the Do Not Call list live, so one has to exist before the Agency Dialer can be used.'
                  : 'Choose an account from the switcher above. Campaigns, rosters and dialing all belong to a single account.'}
              </p>
            </div>
          </main>
        ) : (
          <main className={styles.content}>
            {/*
              Keyed by account so switching accounts REMOUNTS the page rather
              than re-rendering it.

              Every id inside this workspace is account-scoped — a campaign id, a
              draft campaign mid-build, an uploaded roster awaiting its column
              mapping. Without the key, switching accounts leaves all of that
              mounted while subsequent requests carry the new account header, so
              the page shows one account's campaign and writes to another's. A
              stale render would be a cosmetic bug; this one crosses a tenancy
              boundary, which is why it is a key and not a `useEffect` that tries
              to tidy up after the fact.
            */}
            <Outlet key={accountId} />
          </main>
        )}
      </div>
    </div>
  );
}
