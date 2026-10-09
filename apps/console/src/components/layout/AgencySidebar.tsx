import { NavLink } from 'react-router-dom';
import { Bell, ChartNoAxesCombined, ListChecks, PhoneOff, Plus, X, type LucideIcon } from 'lucide-react';
import { Logo } from '../common/Logo';
import { brand } from '../../brand';
import { hasPermission, type Permission } from '../../utils/permissions';
import { useTenant } from '../../contexts/TenantContext';
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
];

export function AgencySidebar({ onClose }: Props) {
  const { role } = useTenant();
  const items = NAV_ITEMS.filter((item) => hasPermission(role, item.permission));

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logoSection}>
        <Logo size={26} />
        <span className={styles.logo}>{brand.name}</span>
        <span className={styles.badge}>Agency</span>
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
    </aside>
  );
}
