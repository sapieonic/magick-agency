import { Link, Outlet, useLocation } from 'react-router-dom';
import { appliesTo, settingsEntryForPath, settingsGroupTitle } from '../../utils/consoleNav';
import { useSettingsNav } from './useSettingsNav';
import styles from './SettingsLayout.module.css';

/**
 * The Settings hub (decision B28), inside the console shell: a sub-nav grouped by who a setting
 * affects (you, this account, people and access), the page, and an "Applies to" line above it
 * so nobody has to guess who a change reaches. Each entry is gated as its old sidebar entry was
 * (`SETTINGS_ENTRIES`), a group with nothing left in it is not shown, and every route keeps its
 * own guards in `App.tsx`.
 */
export default function SettingsLayout() {
  const { pathname } = useLocation();
  const { groups, names } = useSettingsNav();
  const entry = settingsEntryForPath(pathname);

  return (
    <div className={styles.hub}>
      <aside className={styles.side}>
        <nav aria-label="Settings" data-testid="settings-nav">
          {groups.map((group) => (
            <section key={group.scope} className={styles.group} data-testid={`settings-group-${group.scope}`}>
              <h2 className={styles.groupTitle}>{settingsGroupTitle(group.scope, names)}</h2>
              <ul className={styles.list}>
                {group.entries.map((e) => {
                  const active = entry?.id === e.id;
                  return (
                    <li key={e.id}>
                      <Link
                        to={e.path}
                        className={`${styles.item} ${active ? styles.itemActive : ''}`}
                        aria-current={active ? 'page' : undefined}
                        data-testid={`settings-nav-${e.id}`}
                      >
                        {e.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </nav>
        <p className={styles.hint}>
          Caller IDs, calling hours and retries belong to one campaign, so they’re in that campaign’s Settings tab.
        </p>
      </aside>

      <div className={styles.page}>
        {entry && (
          <p className={styles.appliesTo} data-testid="settings-applies-to">
            Applies to: <strong>{appliesTo(entry.scope, names)}</strong>
          </p>
        )}
        <Outlet />
      </div>
    </div>
  );
}
