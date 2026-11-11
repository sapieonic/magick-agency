import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu } from 'lucide-react';
import { CustomerSearchPopover } from '../agency/customers/CustomerSearchPopover';
import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { useGovernance } from '../../contexts/GovernanceContext';
import { DIALER_FLAG, breadcrumbFor, settingsEntryForPath } from '../../utils/consoleNav';
import { ProfileMenu } from './ProfileMenu';
import styles from './ConsoleTopBar.module.css';

interface Props {
  onMenuClick?: () => void;
  /** Whether the mobile navigation drawer is open. */
  menuExpanded?: boolean;
  /** id of the mobile navigation drawer the menu button controls. */
  menuControls?: string;
}

function useCapability(capability: string): boolean {
  try {
    return useGovernance().isEnabled(capability);
  } catch {
    return false;
  }
}

/**
 * The console's top bar (decision B28): where you are on the left, "Search a number" beside it,
 * and the profile menu on the right. On a phone the breadcrumb shows only the current page and
 * the menu button opens the sidebar.
 */
export function ConsoleTopBar({ onMenuClick, menuExpanded, menuControls }: Props) {
  const { pathname } = useLocation();
  const { accountId } = useTenant();
  const agencyCapability = useCapability('agency');
  const dialerFlag = useFeatureFlagEnabled(DIALER_FLAG);
  const dialerOn = agencyCapability && dialerFlag;
  const crumbs = breadcrumbFor(pathname, settingsEntryForPath(pathname)?.label);

  return (
    <div className={styles.topbar}>
      <button
        className={styles.menuBtn}
        onClick={onMenuClick}
        type="button"
        aria-label="Toggle menu"
        aria-expanded={menuExpanded}
        aria-controls={menuControls}
      >
        <Menu size={20} />
      </button>

      {crumbs.length > 0 && (
        <nav className={styles.breadcrumb} aria-label="Breadcrumb" data-testid="console-breadcrumb">
          <ol className={styles.crumbs}>
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={`${crumb.label}-${i}`}>
                  {i > 0 && (
                    <li className={styles.separator} aria-hidden="true">
                      /
                    </li>
                  )}
                  <li className={last ? styles.crumbCurrent : styles.crumb}>
                    {crumb.to && !last ? (
                      <Link to={crumb.to}>{crumb.label}</Link>
                    ) : (
                      <span aria-current={last ? 'page' : undefined}>{crumb.label}</span>
                    )}
                  </li>
                </Fragment>
              );
            })}
          </ol>
        </nav>
      )}

      {/*
        "Search a number" (`docs/customer-history.md` §5): one phone number, every call to it.
        Hidden without `agency.customer_history.read` (the popover checks), without the dialer,
        and until an account is resolved, since the search carries the account header.
      */}
      {accountId && dialerOn && (
        <div className={styles.search}>
          <CustomerSearchPopover />
        </div>
      )}

      <div className={styles.right}>
        <ProfileMenu />
      </div>
    </div>
  );
}
