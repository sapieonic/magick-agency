import { useState, useCallback } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  X,
  Search,
  Headset,
  ArrowRight,
  Users,
  Bell,
  Sparkles,
  Shield,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { hasPermission } from '../../utils/permissions';
import { agencyPersona, isAgencySupervisor } from '../../utils/agencyPersona';
import { Logo } from '../common/Logo';
import { brand } from '../../brand';
import type { Permission } from '../../utils/permissions';
import type { Role } from '../../types/auth';
import type { LucideIcon } from 'lucide-react';
import styles from './Sidebar.module.css';

interface SidebarProps {
  collapsed?: boolean;
  onClose?: () => void;
}

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  permission: Permission;
  /** Optional client-exposed feature flag that must be on for this item to show. */
  flag?: string;
  /** Optional governance capability that must be enabled for this item to show. */
  capability?: string;
}

interface NavSection {
  header: string;
  icon: LucideIcon;
  collapsible: boolean;
  description: string;
  items: NavItem[];
}

/**
 * One section, ADMIN, holding Team, Notifications and Call Summaries (the analysis
 * profiles page; its gates are the `agency_call_analysis` flag and the
 * `agency.analytics` capability, the active account's `analyze_calls`). This
 * shell is the platform zone (team and settings); the agency workspace is entered from the
 * switch below.
 */
const NAV_SECTIONS: NavSection[] = [
  {
    header: 'ADMIN',
    icon: Shield,
    collapsible: true,
    description: 'Team and account settings',
    items: [
      { label: 'Team', to: '/app/team', icon: Users, permission: 'user.invite' },
      // Floored at `tenant.read` (the `viewer` level), NOT at an admin
      // permission: this page manages the signed-in person's OWN email
      // subscriptions, and an unsubscribe only admins can reach is not an
      // unsubscribe. Every role above `agent` therefore sees it here.
      //
      // An `agent` (level 5) does not see THIS sidebar at all — `AgentLanding`
      // leaves `/app` — so the floor is not what decides their access. What
      // used to be claimed here, that the page "would be empty for them", is
      // false: the API's `campaign.dispatched` and `campaign.completed` are
      // `audience: explicit` and shown to every role including `agent`, because
      // the addresses are typed into a campaign form and may be theirs. Only
      // `agency.campaign.completed` (`agency.supervise`) and `usage.digest`
      // (`account_admin`) floor above them. The route itself is ungated, so a
      // direct link works and renders their two real campaign toggles.
      //
      // The agency shell has its own entry (`AgencySidebar`) — supervisors who
      // live in `/agency` are the audience for `agency.campaign.completed` and
      // the digest, and without it they had no path to their own settings
      // without switching products (`GlobalSearch` is AppLayout-only, so
      // Cmd+K does not help either).
      { label: 'Notifications', to: '/app/notifications', icon: Bell, permission: 'tenant.read' },
      { label: 'Call Summaries', to: '/app/call-summaries', icon: Sparkles, permission: 'agency.analysis_profiles.read', flag: 'agency_call_analysis', capability: 'agency.analytics' },
    ],
  },
];

function getVisibleSections(
  role: Role | undefined,
  isFlagEnabled: (flag: string) => boolean,
  isCapabilityEnabled: (capability: string) => boolean,
): NavSection[] {
  return NAV_SECTIONS
    .map(section => ({
      ...section,
      items: section.items.filter(
        item => hasPermission(role, item.permission)
          && (!item.flag || isFlagEnabled(item.flag))
          && (!item.capability || isCapabilityEnabled(item.capability)),
      ),
    }))
    .filter(section => section.items.length > 0);
}

/** Check if the current path is inside a section. */
function isSectionActive(items: NavItem[], pathname: string): boolean {
  return items.some(item =>
    item.to === '/app'
      ? pathname === '/app'
      : pathname.startsWith(item.to),
  );
}

export function Sidebar({ collapsed, onClose }: SidebarProps) {
  const { role } = useTenant();
  /**
   * Where the Agency Dialer entry below points, and what it is called.
   *
   * Derived once rather than inline twice: the destination and the label are a
   * matched pair — "workspace" is only true of `/agency/campaigns` — and two
   * independent ternaries on the same predicate are two places for one of them to
   * be flipped without the other.
   */
  const agencyEntry = isAgencySupervisor(role)
    ? { to: '/agency/campaigns', label: 'Switch to Magick Agency' }
    : { to: '/dialer', label: 'Take dialer calls' };
  const { isEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const location = useLocation();
  const visibleSections = getVisibleSections(role, isEnabled, isCapabilityEnabled);
  const [searchQuery, setSearchQuery] = useState('');

  // Sections with an active route start expanded; everything else starts collapsed
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    for (const section of visibleSections) {
      if (!section.collapsible || isSectionActive(section.items, location.pathname)) {
        initial.add(section.header);
      }
    }
    return initial;
  });

  const toggleSection = useCallback((header: string) => {
    setExpandedSections(prev => {
      const next = new Set(prev);
      if (next.has(header)) {
        next.delete(header);
      } else {
        next.add(header);
      }
      return next;
    });
  }, []);

  const filteredSections = searchQuery.trim()
    ? visibleSections
        .map(section => ({
          ...section,
          items: section.items.filter(item =>
            item.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
            section.header.toLowerCase().includes(searchQuery.toLowerCase())
          ),
        }))
        .filter(section => section.items.length > 0)
    : visibleSections;

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.logoSection}>
        <span className={styles.brand}>
          <Logo size={28} className={styles.logoMark} />
          {!collapsed && <span className={styles.logo}>{brand.name}</span>}
        </span>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          type="button"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      {!collapsed && (
        <div className={styles.searchSection}>
          <div className={styles.searchWrapper}>
            <Search size={14} className={styles.searchIcon} />
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Search pages..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search navigation"
            />
            {searchQuery && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
      )}

      <nav className={styles.nav}>
        {filteredSections.map(section => {
          const isExpanded = searchQuery.trim() ? true : expandedSections.has(section.header);

          return (
            <div key={section.header} className={styles.section}>
              {!collapsed && (
                section.collapsible ? (
                  <>
                    <button
                      type="button"
                      className={styles.sectionHeader}
                      onClick={() => toggleSection(section.header)}
                      aria-expanded={isExpanded}
                    >
                      <span className={styles.sectionLabel}>
                        <section.icon size={13} className={styles.sectionIcon} />
                        {section.header}
                      </span>
                      <ChevronRight
                        size={12}
                        className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`}
                      />
                    </button>
                    {isExpanded && !searchQuery.trim() && (
                      <div className={styles.sectionDescription}>{section.description}</div>
                    )}
                  </>
                ) : (
                  <div className={styles.sectionHeaderStatic}>
                    <section.icon size={13} className={styles.sectionIcon} />
                    {section.header}
                  </div>
                )
              )}
              {(isExpanded || !section.collapsible || collapsed) &&
                section.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    /*
                      There is no `end` list or `/app/calls` active-state override:
                      none of those is a console nav item (the nav is Team,
                      Notifications, Call Summaries), so both would always be false.
                    */
                    className={({ isActive }) =>
                      `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                    }
                    onClick={onClose}
                    title={collapsed ? item.label : undefined}
                  >
                    <item.icon size={18} className={styles.navIcon} />
                    {!collapsed && item.label}
                  </NavLink>
                ))}
            </div>
          );
        })}
      </nav>

      {/*
        The switch into the Agency workspace.
        ── Why a switcher and not a nav section ─────────────────────────────────
        Agency is a separate workspace with its own shell (`AgencyLayout`), so a
        nav item that silently replaced the surrounding chrome would be a lie
        about where the click leads. The arrow and the "workspace" wording are
        the honest signal.

        ── Why THIS gate ───────────────────────────────────────────────────────
        `agency.supervise` rather than a hand-written role list. The permission
        floors at `account_admin` in the API's `PERMISSION_MATRIX`, so it already
        resolves to account_admin / tenant_admin / tenant_owner — and when that
        floor moves, this moves with it. Listing roles here would drift from the
        matrix silently, and a nav gate that disagrees with the API's gate is a
        surface that either 403s on click or hides something the user may use.

        All three gates are required and the two entitlements default off: the API's
        `agency` capability, the API's `agency_dialer_enabled` flag, and standing in
        the dialer at all. A DEDICATED agent (level 5) never reads this sidebar —
        `AgentLanding` redirects them out of `/app` before it renders.

        ── Why the gate is the PERSONA and not `agency.supervise` alone ─────────
        It was the supervisory permission, and that left a hole. `agency.supervise`
        floors at `account_admin`, but `agency.station.connect` floors at `agent`
        (5) — so a `viewer` or an `operator` holds every agent permission, takes
        dialer calls, and held NO entry point to the dialer from anywhere in the
        platform. `AgentHomePage` even offers those two roles a documented way back
        OUT to `/app` (now "Go to settings"); there was no way in. They were
        expected to be handed the `/dialer` URL and to remember it.

        So the gate is the persona being non-null — "does this person have any
        standing in the dialer" — and the DESTINATION is persona-routed, which is
        what keeps this from becoming a dead control. A supervisor sent to `/dialer`
        would be bounced straight back to `/agency/campaigns` by `AgentHomePage`,
        and an agent-persona user sent to `/agency/campaigns` reads a list that
        floors at `agency.campaigns.read`. Two personas, two destinations, same
        two entitlements — the same split `AgencyHomeRedirect` makes at `/agency`,
        derived from the same predicate so a moved floor moves both together.

        The label changes with the destination on purpose: "workspace" is honest
        for the supervisor (a different shell, and the arrow says so) and would be
        a lie for an agent, who gets a full-viewport page with no shell at all.
      */}
      {!collapsed
        && agencyPersona(role) !== null
        && isCapabilityEnabled('agency')
        && isEnabled('agency_dialer_enabled') && (
        <NavLink
          to={agencyEntry.to}
          className={styles.workspaceSwitch}
          onClick={onClose}
        >
          <Headset size={16} className={styles.workspaceIcon} />
          <span className={styles.workspaceLabel}>{agencyEntry.label}</span>
          <ArrowRight size={14} className={styles.workspaceArrow} />
        </NavLink>
      )}

      {!collapsed && (
        <div className={styles.versionFooter}>
          <span className={styles.versionLabel}>v{__APP_VERSION__}</span>
        </div>
      )}
    </aside>
  );
}
