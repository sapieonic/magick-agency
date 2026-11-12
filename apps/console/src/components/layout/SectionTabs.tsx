import { Link } from 'react-router-dom';
import type { TabBar } from '../../utils/consoleNav';
import styles from './SectionTabs.module.css';

/**
 * The tab bar of a section that groups more than one page (Campaigns, Inbound, Reports). Each
 * tab is a link to the page's own URL, so a tab survives a refresh and the back button; only
 * the tabs the reader may open are passed in (`tabBarFor`).
 */
export function SectionTabs({ bar }: { bar: TabBar }) {
  return (
    <nav className={styles.tabs} aria-label={`${bar.section.label} pages`} data-testid="section-tabs">
      {bar.tabs.map((tab) => {
        const active = tab.id === bar.activeId;
        return (
          <Link
            key={tab.id}
            to={tab.to}
            className={`${styles.tab} ${active ? styles.tabActive : ''}`}
            aria-current={active ? 'page' : undefined}
            data-testid={`section-tab-${tab.id}`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
