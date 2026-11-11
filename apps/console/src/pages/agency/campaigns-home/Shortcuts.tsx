import { Link } from 'react-router-dom';
import {
  ChartNoAxesCombined,
  ChevronRight,
  PhoneOff,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { hasPermission, type Permission } from '../../../utils/permissions';
import styles from '../AgencyCampaignsPage.module.css';

interface Shortcut {
  label: string;
  hint: string;
  to: string;
  icon: LucideIcon;
  permission: Permission;
}

/* Gated on the same floors as the sidebar entries they mirror, so the rail never
   offers a destination whose first request 403s. Team is in the Settings hub. */
const SHORTCUTS: Shortcut[] = [
  {
    label: 'Analytics',
    hint: 'Compare campaigns and agents',
    to: '/agency/analytics',
    icon: ChartNoAxesCombined,
    permission: 'agency.campaigns.read',
  },
  {
    label: 'Do Not Call',
    hint: 'Numbers that are never dialled',
    to: '/agency/dnc',
    icon: PhoneOff,
    permission: 'agency.dnc.read',
  },
  {
    label: 'Team',
    hint: 'Invite agents and supervisors',
    to: '/settings/team',
    icon: Users,
    permission: 'user.invite',
  },
];

export function Shortcuts({ role }: { role: Parameters<typeof hasPermission>[0] }) {
  const items = SHORTCUTS.filter((s) => hasPermission(role, s.permission));
  if (items.length === 0) return null;
  return (
    <section className={styles.railCard} aria-labelledby="campaigns-shortcuts-heading">
      <h2 id="campaigns-shortcuts-heading" className={styles.railTitle}>
        Shortcuts
      </h2>
      <ul className={styles.shortcuts} role="list">
        {items.map((s) => {
          const body = (
            <>
              <span className={styles.shortcutIcon} aria-hidden="true">
                <s.icon size={16} />
              </span>
              <span className={styles.shortcutText}>
                <span className={styles.shortcutLabel}>{s.label}</span>
                <span className={styles.shortcutHint}>{s.hint}</span>
              </span>
              <ChevronRight size={15} className={styles.shortcutChevron} aria-hidden="true" />
            </>
          );
          return (
            <li key={s.label}>
              <Link to={s.to} className={styles.shortcut}>
                {body}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const RULES = [
  'A campaign starts as a draft. Nothing is dialled until you start it.',
  'Several campaigns can run at once. They share your account’s lines.',
  'Stopping a campaign lets calls already in progress finish.',
];

export function Rules() {
  return (
    <ul className={styles.rules} role="list">
      {RULES.map((rule) => (
        <li key={rule}>{rule}</li>
      ))}
    </ul>
  );
}

export function RulesCard() {
  return (
    <section className={styles.railCard} aria-labelledby="campaigns-rules-heading">
      <h2 id="campaigns-rules-heading" className={styles.railTitle}>
        Good to know
      </h2>
      <Rules />
    </section>
  );
}
