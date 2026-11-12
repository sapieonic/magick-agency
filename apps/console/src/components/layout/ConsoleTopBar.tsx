import { Fragment } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, Menu, Search } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useNavGate } from '../../hooks/useNavGate';
import { useHomeBadgeCount } from '../../hooks/useHomeBoard';
import { HOME_GATE, backCrumb, breadcrumbFor, dialerOn, passesGate } from '../../utils/consoleNav';
import { menuAttentionLabel } from '../../utils/agency/home';
import { canSearchCampaigns, canSearchNumbers, searchPlaceholder, searchShortcutLabel } from '../../utils/consoleSearch';
import { ProfileMenu } from './ProfileMenu';
import { useSuppliedCrumbs } from './PageCrumbs';
import styles from './ConsoleTopBar.module.css';

interface Props {
  onMenuClick?: () => void;
  /** Whether the mobile navigation drawer is open. */
  menuExpanded?: boolean;
  /** id of the mobile navigation drawer the menu button controls. */
  menuControls?: string;
  /** Opens the console's search (`GlobalSearch`). No field without it. */
  onSearchClick?: () => void;
  /** Phone width: the breadcrumb is the current page, with a back arrow up the trail. */
  phone?: boolean;
}

/**
 * The console's top bar (decision B28): where you are on the left, the one search field beside
 * it, and the profile menu on the right. The field opens `GlobalSearch` (⌘K): pages, Settings,
 * campaigns and, for a reader who may search customer history, a phone number
 * (`docs/customer-history.md` §5). Its words say only what this reader can search. On a phone
 * the breadcrumb shows only the current page, after a back arrow up to the nearest crumb above
 * it that is a link (`backCrumb`; no crumb links to the page it is shown on), the field is an
 * icon button, and the menu button opens the sidebar. Pages leave their own breadcrumbs out and
 * rely on this.
 */
export function ConsoleTopBar({ onMenuClick, menuExpanded, menuControls, onSearchClick, phone = false }: Props) {
  const { pathname } = useLocation();
  const { accountId } = useTenant();
  const gate = useNavGate();
  const crumbs = breadcrumbFor(pathname, useSuppliedCrumbs(pathname), gate.role);
  const back = phone ? backCrumb(crumbs) : null;
  const label = searchPlaceholder(canSearchNumbers(gate, accountId ?? null), canSearchCampaigns(gate, accountId ?? null));
  const shortcut = searchShortcutLabel(typeof navigator === 'undefined' ? '' : navigator.platform ?? '');

  // The sidebar offers Home (and its badge) only with the dialer on and past Home's gate.
  const offersHome = dialerOn(gate) && passesGate(HOME_GATE, gate);
  const menu = { onMenuClick, menuExpanded, menuControls };

  return (
    <div className={styles.topbar}>
      {offersHome ? <AttentionMenuButton {...menu} /> : <MenuButton {...menu} attention={null} />}

      {back && (
        <Link
          to={back.to}
          className={styles.back}
          aria-label={`Back to ${back.label}`}
          data-testid="console-back"
        >
          <ArrowLeft size={20} aria-hidden="true" />
        </Link>
      )}

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

interface MenuButtonProps {
  onMenuClick?: () => void;
  menuExpanded?: boolean;
  menuControls?: string;
}

/**
 * The phone's menu button. `attention` is the Home badge's count and freshness: above zero, the
 * button carries a dot and says "N things need you", because on a phone the sidebar, and the badge
 * on its Home entry, is a closed drawer.
 */
function MenuButton({ onMenuClick, menuExpanded, menuControls, attention }: MenuButtonProps & {
  attention: { count: number | null; stale: boolean } | null;
}) {
  const said = attention ? menuAttentionLabel(attention.count, attention.stale) : null;
  return (
    <button
      className={styles.menuBtn}
      onClick={onMenuClick}
      type="button"
      aria-label={said ? `Toggle menu, ${said}` : 'Toggle menu'}
      aria-expanded={menuExpanded}
      aria-controls={menuControls}
    >
      <Menu size={20} />
      {said && (
        <span
          className={`${styles.menuDot} ${attention?.stale ? styles.menuDotStale : ''}`}
          data-testid="menu-attention-dot"
          aria-hidden="true"
        />
      )}
    </button>
  );
}

/** The menu button for a reader the sidebar offers Home: the Home badge's board, no request of its own. */
function AttentionMenuButton(props: MenuButtonProps) {
  const { tenantId, accountId, role } = useTenant();
  const attention = useHomeBadgeCount(tenantId, accountId, role, NO_MISSED);
  return <MenuButton {...props} attention={attention} />;
}

/** The badge never counts the missed calls (the Inbound badge has them), so the dot needs no missed read. */
const NO_MISSED = { available: false, count: null } as const;
