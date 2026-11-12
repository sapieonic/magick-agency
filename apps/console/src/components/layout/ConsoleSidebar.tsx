import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ChartNoAxesCombined,
  Headset,
  House,
  ListChecks,
  PhoneIncoming,
  PhoneOff,
  Settings,
  X,
  type LucideIcon,
} from 'lucide-react';
import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { Logo } from '../common/Logo';
import { brand } from '../../brand';
import { useTenant } from '../../contexts/TenantContext';
import { useNavGate } from '../../hooks/useNavGate';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { missedBadgeLabel, missedBadgeText } from '../../hooks/useMissedCallsCount';
import { useHomeBoard } from '../../hooks/useHomeBoard';
import {
  homeAttentionKey,
  publishHomeAttentionCount,
  useHomeAttentionCount,
} from '../../hooks/useHomeAttentionCount';
import { attentionBadgeLabel, attentionBadgeText, homeAttention, homeBadgeCount, type HomeMissed } from '../../utils/agency/home';
import {
  SETTINGS_GATE,
  activeNavId,
  dialerOn,
  passesGate,
  visibleSections,
  type ConsoleSectionId,
} from '../../utils/consoleNav';
import { TenantSwitcher } from './TenantSwitcher';
import { AccountSwitcher } from './AccountSwitcher';
import styles from './ConsoleSidebar.module.css';

const ICONS: Record<ConsoleSectionId, LucideIcon> = {
  home: House,
  campaigns: ListChecks,
  inbound: PhoneIncoming,
  reports: ChartNoAxesCombined,
  dnc: PhoneOff,
  dialer: Headset,
};

function itemClass(active: boolean): string {
  return `${styles.navItem} ${active ? styles.navItemActive : ''}`;
}

/**
 * Home and the four work sections. Mounted only when the dialer is on for the account (the `agency`
 * capability and `agency_dialer_enabled`), so the missed-calls count is never asked for by a
 * tenant without it.
 */
function WorkNav({ onClose }: { onClose?: () => void }) {
  const { pathname } = useLocation();
  const gate = useNavGate({ missed: true });
  const missed = useMissedCallsAccess();
  const badge = missedBadgeText(missed.count);
  const badgeSr = missedBadgeLabel(missed.count);
  const active = activeNavId(pathname);
  const sections = visibleSections(gate);

  return (
    <>
      {sections.map(({ section, href }) => {
        const Icon = ICONS[section.id];
        const isActive = active === section.id;
        return (
          <Link
            key={section.id}
            to={href}
            className={itemClass(isActive)}
            aria-current={isActive ? 'page' : undefined}
            onClick={onClose}
            data-testid={`console-nav-${section.id}`}
          >
            <Icon size={18} className={styles.navIcon} aria-hidden="true" />
            <span className={styles.navLabel}>{section.label}</span>
            {section.id === 'home' ? (
              <HomeNavBadge onHome={isActive} missed={{ available: missed.available, count: missed.count }} />
            ) : null}
            {section.id === 'inbound' && badge ? (
              <span className={styles.navBadge} data-testid="sidebar-missed-badge">
                <span aria-hidden="true">{badge}</span>
                <span className={styles.srOnly}>{`, ${badgeSr}`}</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The Home entry's badge: how many dangers and warnings need the supervisor, counted from the
 * list the Home page shows (`homeAttention`, `homeBadgeCount`): never a "waiting, nothing wrong"
 * row, and never the missed calls, which the Inbound entry's badge already counts. Rendered only
 * beside the Home entry, so only for a reader who passes Home's gate. On Home the page publishes
 * the count on every refresh and this reads it; anywhere else this reads the board itself
 * (`useHomeBoard` background mode: one request a minute, none while the tab is hidden or the
 * shared count is fresh) and publishes on every read, so the freshness check holds. In the
 * attention tone, apart from the missed-calls count.
 */
function HomeNavBadge({ onHome, missed }: { onHome: boolean; missed: HomeMissed }) {
  const { tenantId, accountId } = useTenant();
  const key = homeAttentionKey(tenantId, accountId);
  const board = useHomeBoard({ tenantId, accountId, enabled: !onHome, mode: 'background', attentionKey: key });
  const count = board.status === 'ready' && !onHome ? homeBadgeCount(homeAttention(board.reads, missed, () => '')) : null;
  // `refreshedAt` is a dependency so a read that changed nothing still stamps the shared count.
  useEffect(() => {
    if (key && count !== null) publishHomeAttentionCount(key, count);
  }, [key, count, board.refreshedAt]);
  const shared = useHomeAttentionCount(key);
  const text = attentionBadgeText(shared);
  const label = attentionBadgeLabel(shared);
  if (!text) return null;
  return (
    <span className={`${styles.navBadge} ${styles.navBadgeAttention}`} data-testid="sidebar-attention-badge">
      <span aria-hidden="true">{text}</span>
      <span className={styles.srOnly}>{`, ${label}`}</span>
    </span>
  );
}

/**
 * The console's one sidebar (decision B28), top to bottom: which tenant and account you are in
 * (and the way to switch), the work sections, then Settings and the app version pinned at the
 * foot.
 *
 * Every work entry is gated as the pages it groups are (`utils/consoleNav`), so an `agent`
 * (level 5) is offered none of the work pages. A DEDICATED agent (role `agent`) lands on
 * `/dialer` and, while the dialer is on, is kept out of this shell on every page (`AgentLanding`
 * sends them to the page's `/dialer/*` twin, or `/dialer`); viewers and operators land in the shell and keep the
 * dialler as "Take calls", a link out to `/dialer` for whoever takes calls but does not
 * supervise. There is no per-campaign station entry: a station is one campaign's, and the
 * campaign page carries the control.
 *
 * Settings sits at the foot of the main navigation landmark, and is left out for a dedicated
 * agent while the dialer is on (`SETTINGS_GATE`): `AgentLanding` would send them from it to
 * `/dialer`. With the dialer on, such an agent never sees this shell at all.
 */
export function ConsoleSidebar({ onClose }: { onClose?: () => void }) {
  const { pathname } = useLocation();
  const gate = useNavGate();
  const workNav = dialerOn(gate);
  const settingsShown = passesGate(SETTINGS_GATE, gate);
  const settingsActive = activeNavId(pathname) === 'settings';

  return (
    <aside className={styles.sidebar}>
      <div className={styles.brandRow}>
        <Logo size={24} />
        <span className={styles.brandName}>{brand.name}</span>
        <button className={styles.closeBtn} onClick={onClose} type="button" aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      {/*
        Where you are: the tenant small, the account under it. Each opens the existing
        switcher when there is more than one to choose from, and is a plain label otherwise.
        A switch is a full page load at the new account's home (B26), through the
        `TenantContext` setters the two switchers call.
      */}
      <div className={styles.context} data-testid="sidebar-context">
        <TenantSwitcher />
        <AccountSwitcher />
      </div>

      <nav className={styles.nav} aria-label="Main">
        <div className={styles.navWork}>{workNav && <WorkNav onClose={onClose} />}</div>
        {settingsShown && (
          <div className={styles.navFoot}>
            <Link
              to="/settings"
              className={itemClass(settingsActive)}
              aria-current={settingsActive ? 'page' : undefined}
              onClick={onClose}
              data-testid="console-nav-settings"
            >
              <Settings size={18} className={styles.navIcon} aria-hidden="true" />
              <span className={styles.navLabel}>Settings</span>
            </Link>
          </div>
        )}
      </nav>

      <div className={styles.footer}>
        <AppVersion version={__APP_VERSION__} />
      </div>
    </aside>
  );
}
