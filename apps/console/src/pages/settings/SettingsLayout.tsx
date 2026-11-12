import { useEffect, useId, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { CAMPAIGNS_GATE, appliesTo, passesGate, settingsEntryForPath, settingsGroupTitle } from '../../utils/consoleNav';
import { settingsEntryMatches } from '../../utils/consoleSearch';
import { plural } from '../../utils/format/number';
import { rememberSettingsEntry } from '../../utils/settingsLastVisited';
import { useSettingsNav } from './useSettingsNav';
import styles from './SettingsLayout.module.css';

/**
 * The Settings hub (decision B28), inside the console shell: a sub-nav grouped by who a setting
 * affects (you, this account, people and access), the page, and an "Applies to" line above it
 * so nobody has to guess who a change reaches. Each entry is gated as its old sidebar entry was
 * (`SETTINGS_ENTRIES`), a group with nothing left in it is not shown, and every route keeps its
 * own guards in `App.tsx`.
 *
 * "Find a setting" filters the sub-nav with the words ⌘K finds Settings by
 * (`utils/consoleSearch.ts`), so the two never disagree about where a setting lives.
 *
 * The entry open is remembered for this viewer, so `/settings` reopens it
 * (`SettingsIndexRedirect`). On a phone the sub-nav collapses into one "Settings page" picker
 * above the page (CSS swaps the two), rather than stacking every entry above every page.
 */
export default function SettingsLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { groups, names, gate } = useSettingsNav();
  const entry = settingsEntryForPath(pathname);
  const [filter, setFilter] = useState('');
  const filterId = useId();
  const statusId = `${filterId}-status`;
  const pickerId = `${filterId}-picker`;
  const userId = user?.id ?? null;
  const entryId = entry?.id ?? null;
  // Only an entry the reader may open, so a page they were bounced from is not reopened.
  const openable = entryId !== null && groups.some((g) => g.entries.some((e) => e.id === entryId));

  useEffect(() => {
    if (entryId && openable) rememberSettingsEntry(userId, entryId);
  }, [userId, entryId, openable]);

  const query = filter.trim();
  const shown = query === ''
    ? groups
    : groups.flatMap((group) => {
      const entries = group.entries.filter((e) => settingsEntryMatches(e, query));
      return entries.length > 0 ? [{ ...group, entries }] : [];
    });
  const count = shown.reduce((n, g) => n + g.entries.length, 0);

  return (
    <div className={styles.hub}>
      <aside className={styles.side}>
        <div className={styles.compact} data-testid="settings-compact-nav">
          <label htmlFor={pickerId} className={styles.compactLabel}>Settings page</label>
          <select
            id={pickerId}
            className={styles.compactSelect}
            value={openable ? entryId! : ''}
            onChange={(e) => {
              const next = groups.flatMap((g) => g.entries).find((x) => x.id === e.target.value);
              if (next) navigate(next.path);
            }}
            data-testid="settings-compact-select"
          >
            {!openable && <option value="">Choose a page</option>}
            {groups.map((group) => (
              <optgroup key={group.scope} label={settingsGroupTitle(group.scope, names)}>
                {group.entries.map((e) => (
                  <option key={e.id} value={e.id}>{e.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className={styles.full}>
          <div className={styles.filter}>
            <Search size={15} aria-hidden="true" className={styles.filterIcon} />
            <label htmlFor={filterId} className={styles.srOnly}>Find a setting</label>
            <input
              id={filterId}
              type="search"
              className={styles.filterInput}
              placeholder="Find a setting"
              autoComplete="off"
              spellCheck={false}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && filter !== '') {
                  e.preventDefault();
                  setFilter('');
                }
              }}
              aria-describedby={statusId}
              data-testid="settings-filter"
            />
          </div>
          <p id={statusId} className={styles.srOnly} aria-live="polite">
            {query === '' ? '' : `${plural(count, 'setting')} found`}
          </p>

          <nav aria-label="Settings" data-testid="settings-nav">
            {shown.map((group) => (
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
            {shown.length === 0 && (
              <p className={styles.empty} data-testid="settings-filter-empty">
                No setting matches “{query}”.
              </p>
            )}
          </nav>
          {passesGate(CAMPAIGNS_GATE, gate) && (
            <p className={styles.hint} data-testid="settings-campaign-hint">
              Caller IDs, calling hours and retries belong to one campaign: open it from{' '}
              <Link to="/agency/campaigns">Campaigns</Link> and go to its Settings tab.
            </p>
          )}
        </div>
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
