import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, Search } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { breadcrumbFor, settingsEntryForPath, type GateInput } from '../../utils/consoleNav';
import { canSearchCampaigns, canSearchNumbers, searchPlaceholder, searchShortcutLabel } from '../../utils/consoleSearch';
import { ProfileMenu } from './ProfileMenu';
import styles from './ConsoleTopBar.module.css';

interface Props {
  onMenuClick?: () => void;
  /** Whether the mobile navigation drawer is open. */
  menuExpanded?: boolean;
  /** id of the mobile navigation drawer the menu button controls. */
  menuControls?: string;
  /** Opens the console's search (`GlobalSearch`). No field without it. */
  onSearchClick?: () => void;
}

/** Flags and capabilities, failing closed outside their providers (as the sidebar reads them). */
function useGateReaders(): Pick<GateInput, 'isFlagEnabled' | 'isCapabilityEnabled'> {
  let isFlagEnabled: (flag: string) => boolean = () => false;
  let isCapabilityEnabled: (capability: string) => boolean = () => false;
  try {
    isFlagEnabled = useFeatureFlags().isEnabled;
  } catch {
    /* no provider: every flag off */
  }
  try {
    isCapabilityEnabled = useGovernance().isEnabled;
  } catch {
    /* no provider: every capability off */
  }
  return { isFlagEnabled, isCapabilityEnabled };
}

/**
 * The console's top bar (decision B28): where you are on the left, the one search field beside
 * it, and the profile menu on the right. The field opens `GlobalSearch` (⌘K): pages, Settings,
 * campaigns and, for a reader who may search customer history, a phone number
 * (`docs/customer-history.md` §5). Its words say only what this reader can search. On a phone
 * the breadcrumb shows only the current page, the field is an icon button, and the menu button
 * opens the sidebar.
 */
export function ConsoleTopBar({ onMenuClick, menuExpanded, menuControls, onSearchClick }: Props) {
  const { pathname } = useLocation();
  const { role, accountId } = useTenant();
  const readers = useGateReaders();
  const gate: GateInput = { role, ...readers };
  const crumbs = breadcrumbFor(pathname, settingsEntryForPath(pathname)?.label);
  const label = searchPlaceholder(canSearchNumbers(gate, accountId ?? null), canSearchCampaigns(gate, accountId ?? null));
  const shortcut = searchShortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform ?? '');

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

      {onSearchClick && (
        <button
          type="button"
          className={styles.search}
          onClick={onSearchClick}
          aria-label={label}
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          data-testid="console-search-trigger"
        >
          <Search size={16} aria-hidden="true" className={styles.searchIcon} />
          <span className={styles.searchText} aria-hidden="true">{label}</span>
          <kbd className={styles.searchKey} aria-hidden="true">{shortcut}</kbd>
        </button>
      )}

      <div className={styles.right}>
        <ProfileMenu />
      </div>
    </div>
  );
}
