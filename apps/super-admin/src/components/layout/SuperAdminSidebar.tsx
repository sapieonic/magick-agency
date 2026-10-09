import { NavLink } from 'react-router-dom';
import { Building2, Users, ShieldCheck, ScrollText, Phone, BarChart3, Flag, X } from 'lucide-react';
import { Logo } from '../common/Logo';
import { brand } from '../../brand';
import styles from './SuperAdminSidebar.module.css';

interface Props {
  onClose?: () => void;
}

interface NavItem {
  label: string;
  to: string;
  icon: typeof Building2;
  end: boolean;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    heading: 'Operations',
    items: [
      { label: 'Tenants', to: '/tenants', icon: Building2, end: false },
      { label: 'Users', to: '/users', icon: Users, end: false },
      { label: 'Admins', to: '/admins', icon: ShieldCheck, end: false },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { label: 'Phone Numbers', to: '/phone-numbers', icon: Phone, end: false },
      { label: 'Feature Flags', to: '/feature-flags', icon: Flag, end: false },
    ],
  },
  {
    heading: 'Insights',
    items: [
      { label: 'Usage', to: '/usage', icon: BarChart3, end: false },
      { label: 'Audit Log', to: '/audit', icon: ScrollText, end: false },
    ],
  },
];

export function SuperAdminSidebar({ onClose }: Props) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.logoSection}>
        <Logo size={26} />
        <span className={styles.logo}>{brand.name}</span>
        <span className={styles.badge}>Admin</span>
        <button
          className={styles.closeBtn}
          onClick={onClose}
          type="button"
          aria-label="Close menu"
        >
          <X size={18} />
        </button>
      </div>

      <nav className={styles.nav}>
        {NAV_SECTIONS.map((section) => (
          <div key={section.heading} className={styles.section}>
            <div className={styles.sectionHeader}>{section.heading}</div>
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `${styles.navItem} ${isActive ? styles.navItemActive : ''}`
                }
                onClick={onClose}
              >
                <item.icon size={18} className={styles.navIcon} />
                {item.label}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
