import { NavLink } from 'react-router-dom';
import { Bell, Briefcase, ChartColumn, ChartNoAxesCombined, FileText, ListChecks, Phone, PhoneIncoming, PhoneOff, Plus, Settings2, X, type LucideIcon } from 'lucide-react';
import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { Logo } from '../common/Logo';
import { brand } from '../../brand';
import { hasPermission, type Permission } from '../../utils/permissions';
import { useTenant } from '../../contexts/TenantContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { REPORTS_FLAG } from '../../utils/reports/reportsFlag';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { missedBadgeLabel, missedBadgeText } from '../../hooks/useMissedCallsCount';
import styles from './AgencySidebar.module.css';

interface Props {
  onClose?: () => void;
}

interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  end: boolean;
  permission: Permission;
  /** A client-exposed flag that must also be on. */
  flag?: string;
  /**
   * Missed inbound calls' entries: shown while the caller can read the list (`useMissedCallsAccess`:
   * inbound on, or rows still to read with it off) instead of by `flag` alone, and carrying the
   * open count for the caller's scope as a badge.
   */
  missed?: 'list' | 'summary';
}

/**
 * Only surfaces that exist today.
 *
 * ── The Supervisor Dashboard's absence has ended, and here is the record ────
 * This note used to explain why the supervisor dashboard was "deliberately absent rather
 * than present-and-empty": the API's stats payload produced no `pacing_state`,
 * `stall_reason`, per-agent rows or human/machine connect split, and "a health strip with no diagnosis in it is worse than no health
 * strip — it reads as *nothing wrong* when the truth is *nothing measured*".
 *
 * All four landed and the campaign detail page has rendered them for some time,
 * so the premise expired while the note stood. `Analytics` is the entry that
 * replaces it. Kept here in full because the reasoning still governs the NEXT
 * empty surface somebody is tempted to add: the bar is a screen that can say
 * something true, not a screen that can be reached.
 *
 * Every entry is permission-gated below, which is what keeps this list honest for
 * the persona reading it — a supervisor sees four destinations, and an `agent`
 * (level 5) sees none, which is why an agent is never routed into this shell at
 * all. See `AgencyHomeRedirect`.
 */
const NAV_ITEMS: NavItem[] = [
  {
    label: 'Campaigns',
    to: '/agency/campaigns',
    icon: ListChecks,
    end: true,
    permission: 'agency.campaigns.read',
  },
  {
    label: 'New campaign',
    to: '/agency/campaigns/new',
    icon: Plus,
    end: false,
    permission: 'agency.campaigns.write',
  },
  {
    /* Same floor as the campaign list, because it reads the same list plus one
       `/stats` per campaign — and both are `agency.campaigns.read` in the API.
       Gating it any higher would hide a page whose every request would succeed. */
    label: 'Analytics',
    to: '/agency/analytics',
    icon: ChartNoAxesCombined,
    end: false,
    permission: 'agency.campaigns.read',
  },
  {
    /*
     * Reports (`docs/reports.md`): a supervisor's history and subscriptions; a viewer
     * or operator sees the runs they requested (their own review). Floored at the
     * agency workspace's own floor (`agency.campaigns.read`, viewer) rather than at
     * `agency.station.connect`, because a dedicated `agent` gets no destinations in
     * this shell: their entry is "My reports" in the agent nav (`/dialer/reports`).
     * Behind `agency_reports_enabled`, default off.
     */
    label: 'Reports',
    to: '/agency/reports',
    icon: FileText,
    end: false,
    permission: 'agency.campaigns.read',
    flag: REPORTS_FLAG,
  },
  {
    /*
     * The soft phone's calls, account-wide (`docs/softphone.md` §7). The server
     * scopes `GET /softphone/calls` to the whole account only for
     * `agency.supervise`, so that is the floor here; and the flag, default off.
     */
    label: 'Soft-phone calls',
    to: '/agency/softphone',
    icon: Phone,
    end: false,
    permission: 'agency.supervise',
    flag: 'agency_softphone_enabled',
  },
  {
    /*
     * Missed inbound calls (`docs/inbound.md` §7). Floored at the workspace's own floor, as
     * Reports is: `agency.inbound.read` floors at `agent`, but a dedicated agent gets no
     * destinations in this shell (their entry is "Missed calls" in the agent nav,
     * `/dialer/missed`). Here a supervisor reads the account's rows and anyone else their own
     * (the server's rule). Shown with `agency_inbound_enabled` on, and with it off while there are
     * rows to read (the kill switch stops calls, not their follow-up); the badge is the open count.
     */
    label: 'Missed calls',
    to: '/agency/inbound/missed',
    icon: PhoneIncoming,
    end: false,
    permission: 'agency.campaigns.read',
    missed: 'list',
  },
  {
    /*
     * The inbound summary (`docs/inbound.md` §11): the account's inbound calls over a range, for
     * supervisors (`agency.supervise`, the route's gate). Shown when the Missed list is.
     */
    label: 'Inbound summary',
    to: '/agency/inbound/summary',
    icon: ChartColumn,
    end: false,
    permission: 'agency.supervise',
    missed: 'summary',
  },
  {
    label: 'Do Not Call',
    to: '/agency/dnc',
    icon: PhoneOff,
    end: false,
    permission: 'agency.dnc.read',
  },
  {
    /*
     * The one entry here that leaves the agency shell, and it is the only path
     * to it for the people the mail is actually addressed to.
     *
     * `agency.campaign.completed` floors at `agency.supervise` and
     * `usage.digest` at `account_admin` — so a supervisor who lives in
     * `/agency` is the audience for both notices and had no way to reach their
     * own settings without switching products. The main sidebar's entry is
     * AppLayout-only, and so is `GlobalSearch`, so Cmd+K did not help either.
     *
     * Floored at `agency.supervise` rather than the main sidebar's
     * `tenant.read`: this shell's audience for a notification setting IS the
     * supervisor, and an `agent` is never routed here at all
     * (`AgencyHomeRedirect`). The destination itself is ungated, exactly as it
     * is from the other shell.
     */
    label: 'Notifications',
    to: '/app/notifications',
    icon: Bell,
    end: false,
    permission: 'agency.supervise',
  },
  {
    /* Leaves the shell like Notifications: the settings live in the platform zone,
       and the people who edit them (`agency.softphone.manage`) live here. */
    label: 'Soft phone settings',
    to: '/app/softphone',
    icon: Settings2,
    end: false,
    permission: 'agency.softphone.manage',
    flag: 'agency_softphone_enabled',
  },
  {
    /* Leaves the shell like the soft phone's settings: the routes are a platform-zone page, and
       the people who edit them (`agency.inbound.write`, account admins) live here. */
    label: 'Inbound settings',
    to: '/app/inbound',
    icon: Settings2,
    end: false,
    permission: 'agency.inbound.write',
    flag: INBOUND_FLAG,
  },
  {
    /* Leaves the shell like the two above: tenant admins and owners work here too, and
       adding an account (decision AA1) is a platform-zone page. */
    label: 'Accounts',
    to: '/app/accounts',
    icon: Briefcase,
    end: false,
    permission: 'account.create',
  },
];

/*
  The badge tells the agency shell apart from the platform shell at `/app`. A
  brand whose name already says "Agency" says it twice, and the extra word was
  what pushed the wordmark onto two lines at the default sidebar width.
*/
export function showsShellBadge(brandName: string): boolean {
  return !/\bagency\b/i.test(brandName);
}

const SHOW_BADGE = showsShellBadge(brand.name);

export function AgencySidebar({ onClose }: Props) {
  const { role } = useTenant();
  const softphone = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const reports = useFeatureFlagEnabled(REPORTS_FLAG);
  const inbound = useFeatureFlagEnabled(INBOUND_FLAG);
  const flagOn: Record<string, boolean> = { [SOFTPHONE_FLAG]: softphone, [REPORTS_FLAG]: reports, [INBOUND_FLAG]: inbound };
  const missedAccess = useMissedCallsAccess();
  const missedBadge = missedBadgeText(missedAccess.count);
  const missedBadgeSr = missedBadgeLabel(missedAccess.count);
  const items = NAV_ITEMS.filter(
    (item) => hasPermission(role, item.permission)
      && (!item.flag || flagOn[item.flag] === true)
      && (!item.missed || missedAccess.available),
  );

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logoSection}>
        <Logo size={26} />
        <span className={styles.logo}>{brand.name}</span>
        {SHOW_BADGE && <span className={styles.badge}>Agency</span>}
        <button className={styles.closeBtn} onClick={onClose} type="button" aria-label="Close menu">
          <X size={18} />
        </button>
      </div>

      <nav className={styles.nav}>
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
            onClick={onClose}
          >
            <item.icon size={18} className={styles.navIcon} />
            {item.label}
            {item.missed === 'list' && missedBadge ? (
              <span className={styles.navBadge} data-testid="sidebar-missed-badge">
                <span aria-hidden="true">{missedBadge}</span>
                <span className={styles.srOnly}>{`, ${missedBadgeSr}`}</span>
              </span>
            ) : null}
          </NavLink>
        ))}
      </nav>

      {/*
        There is deliberately NO "open the station" control here.

        `/station` requires `?campaign=<id>` — `AgentConsolePage` reads the query
        param and refuses with "No campaign selected." without it. A station is
        an agent joined to ONE campaign's pool, so there is no campaign-less
        station to link to, and a sidebar link has no campaign in scope. An
        earlier revision shipped a bare `/station` link here, which looked like a
        working control and could only ever land on the refusal.

        The control lives on the campaign detail page instead, where an id
        exists. If this ever needs to be a global entry point it needs a
        campaign picker first, not a link.
      */}

      <AppVersion version={__APP_VERSION__} />
    </aside>
  );
}
