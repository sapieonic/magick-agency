import { Link, useLocation } from 'react-router-dom';
import {
  ChartNoAxesCombined,
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
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { missedBadgeLabel, missedBadgeText } from '../../hooks/useMissedCallsCount';
import {
  DIALER_FLAG,
  activeNavId,
  visibleSections,
  type ConsoleSectionId,
  type GateInput,
} from '../../utils/consoleNav';
import { TenantSwitcher } from './TenantSwitcher';
import { AccountSwitcher } from './AccountSwitcher';
import styles from './ConsoleSidebar.module.css';

const ICONS: Record<ConsoleSectionId, LucideIcon> = {
  campaigns: ListChecks,
  inbound: PhoneIncoming,
  reports: ChartNoAxesCombined,
  dnc: PhoneOff,
};

function itemClass(active: boolean): string {
  return `${styles.navItem} ${active ? styles.navItemActive : ''}`;
}

/** Flags and capabilities, failing closed outside their providers (as `useFeatureFlagEnabled` does). */
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
 * The four work sections. Mounted only when the dialer is on for the account (the `agency`
 * capability and `agency_dialer_enabled`), so the missed-calls count is never asked for by a
 * tenant without it.
 */
function WorkNav({ onClose }: { onClose?: () => void }) {
  const { role } = useTenant();
  const { pathname } = useLocation();
  const readers = useGateReaders();
  const missed = useMissedCallsAccess();
  const badge = missedBadgeText(missed.count);
  const badgeSr = missedBadgeLabel(missed.count);
  const active = activeNavId(pathname);
  const sections = visibleSections({ role, ...readers, missedAvailable: missed.available });

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
 * The console's one sidebar (decision B28), top to bottom: which tenant and account you are in
 * (and the way to switch), the work sections, then Settings and the app version pinned at the
 * foot.
 *
 * Every work entry is gated as the pages it groups are (`utils/consoleNav`), so an `agent`
 * (level 5) is offered none of them; a dedicated agent is kept out of this shell altogether
 * (`AgentLanding`, `AgencyHomeRedirect`). There is no "open the station" entry: a station is
 * one campaign's, and the campaign page carries the control.
 */
export function ConsoleSidebar({ onClose }: { onClose?: () => void }) {
  const { pathname } = useLocation();
  const { isFlagEnabled, isCapabilityEnabled } = useGateReaders();
  const dialerOn = isCapabilityEnabled('agency') && isFlagEnabled(DIALER_FLAG);
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
        <TenantSwitcher variant="context" />
        <AccountSwitcher variant="context" />
      </div>

      <nav className={styles.nav} aria-label="Main">
        {dialerOn && <WorkNav onClose={onClose} />}
      </nav>

      <div className={styles.footer}>
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
        <AppVersion version={__APP_VERSION__} />
      </div>
    </aside>
  );
}
