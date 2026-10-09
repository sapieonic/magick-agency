import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import styles from './GlobalSearch.module.css';

interface PageEntry {
  label: string;
  path: string;
  section: string;
  keywords: string[];
  /** Optional client-exposed feature flag gating this entry. */
  flag?: string;
  /** Optional governance capability gating this entry. */
  capability?: string;
}

// PORT NOTE (magick-agency): cusui's page directory listed every AI, broadcast,
// messaging, knowledge, credits and API-key page. Only the entries for surfaces
// the console ports are kept — the agency workspace, Team and Notifications —
// each verbatim with its comment; `Call Summaries` is added for the analysis
// profiles page, now the agency's own (gated on agency's `agency_call_analysis`
// flag and `agency.analytics` capability, as its route is).
const PAGES: PageEntry[] = [
  // Agency Dialer. These live OUTSIDE `/app` in their own workspace shell, so
  // selecting one leaves the main app — which is exactly what the sidebar's
  // "Switch to Magick Agency" control does, and why they belong here rather
  // than being unreachable by search. Gated identically to that control.
  { label: 'Agency Campaigns', path: '/agency/campaigns', section: 'Agency', keywords: ['agency', 'dialer', 'campaign', 'power dial', 'outbound', 'agent'], flag: 'agency_dialer_enabled', capability: 'agency' },
  { label: 'New Agency Campaign', path: '/agency/campaigns/new', section: 'Agency', keywords: ['agency', 'dialer', 'campaign', 'new', 'create', 'roster', 'upload'], flag: 'agency_dialer_enabled', capability: 'agency' },
  // Q2: DNC is agency-only — it suppresses agency dialing and nothing else. The
  // label carries that scope because this result is reached from inside the
  // primary app, where no shell supplies it; and `compliance` / `opt out` are
  // gone, because someone typing those is asking a platform-wide question this
  // page does not answer. Offering it as the answer is the misreading.
  //
  // So this reads "Agency Do Not Call" while the page's own `<h1>` and the
  // agency sidebar entry both say "Do Not Call". The divergence is a decision,
  // not drift: inside `/agency` the shell IS the scope and repeating it in the
  // heading is noise, whereas the command palette opens over any page in the
  // primary app, where a bare "Do Not Call" is the tenant-wide reading Q2 exists
  // to remove.
  { label: 'Agency Do Not Call', path: '/agency/dnc', section: 'Agency', keywords: ['dnc', 'do not call', 'suppress', 'blocklist', 'blacklist', 'agency', 'dialing'], flag: 'agency_dialer_enabled', capability: 'agency' },
  { label: 'Team', path: '/app/team', section: 'Admin', keywords: ['team', 'member', 'invite'] },
  // No `capability` and no permission: the page manages the signed-in person's
  // own email subscriptions. "unsubscribe" is in the keywords because that is
  // the word somebody reaches for search with when a digest arrives they did
  // not want.
  { label: 'Notifications', path: '/app/notifications', section: 'Admin', keywords: ['notification', 'email', 'digest', 'summary', 'unsubscribe', 'alert'] },
  { label: 'Call Summaries', path: '/app/call-summaries', section: 'Admin', keywords: ['summary', 'summaries', 'analysis', 'transcript', 'sentiment', 'profile'], flag: 'agency_call_analysis', capability: 'agency.analytics' },
];

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const { isEnabled } = useFeatureFlags();
  const { isEnabled: isCapabilityEnabled } = useGovernance();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Pages visible given the current tenant's feature flags and governance
  // capabilities (an entry may require either or both).
  const availablePages = useMemo(
    () => PAGES.filter((page) =>
      (!page.flag || isEnabled(page.flag))
      && (!page.capability || isCapabilityEnabled(page.capability)),
    ),
    [isEnabled, isCapabilityEnabled],
  );

  // Filter pages based on query
  const filtered = useMemo(() => {
    if (!query.trim()) return availablePages;
    const q = query.toLowerCase().trim();
    return availablePages.filter((page) => {
      if (page.label.toLowerCase().includes(q)) return true;
      if (page.section.toLowerCase().includes(q)) return true;
      return page.keywords.some((kw) => kw.toLowerCase().includes(q));
    });
  }, [query, availablePages]);

  // Build a flat list with section headers for rendering
  const grouped = useMemo(() => {
    const sections: { section: string; items: PageEntry[] }[] = [];
    const sectionMap = new Map<string, PageEntry[]>();

    for (const page of filtered) {
      const existing = sectionMap.get(page.section);
      if (existing) {
        existing.push(page);
      } else {
        const items = [page];
        sectionMap.set(page.section, items);
        sections.push({ section: page.section, items });
      }
    }

    return sections;
  }, [filtered]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered]);

  // Global shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) {
            setQuery('');
            setSelectedIndex(0);
          }
          return !prev;
        });
      }
    }

    document.addEventListener('keydown', handleGlobalKeyDown);
    return () => document.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Auto-focus input when opened
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const items = resultsRef.current.querySelectorAll<HTMLElement>('[data-result-index]');
    const target = items[selectedIndex];
    if (target) {
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const navigateTo = useCallback(
    (path: string) => {
      navigate(path);
      close();
    },
    [navigate, close],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0));
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1));
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        const page = filtered[selectedIndex];
        if (page) {
          navigateTo(page.path);
        }
        return;
      }

      // Focus trap: keep focus in the container
      if (e.key === 'Tab') {
        e.preventDefault();
      }
    },
    [close, filtered, selectedIndex, navigateTo],
  );

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        close();
      }
    },
    [close],
  );

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick} role="dialog" aria-modal="true" aria-label="Quick navigation">
      <div className={styles.container} ref={containerRef} onKeyDown={handleKeyDown}>
        <div className={styles.inputWrapper}>
          <svg
            className={styles.searchIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search pages..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search pages"
          />
        </div>

        <div className={styles.results} ref={resultsRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No results found</div>
          ) : (
            grouped.map((group) => (
              <div key={group.section}>
                <div className={styles.sectionHeader}>{group.section}</div>
                {group.items.map((page) => {
                  flatIndex++;
                  const idx = flatIndex;
                  const isSelected = idx === selectedIndex;
                  return (
                    <div
                      key={page.path}
                      data-result-index={idx}
                      className={`${styles.resultItem} ${isSelected ? styles.resultItemSelected : ''}`}
                      onClick={() => navigateTo(page.path)}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      role="option"
                      aria-selected={isSelected}
                    >
                      <span className={styles.resultLabel}>{page.label}</span>
                      <span className={styles.resultSection}>{page.section}</span>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className={styles.hintBar}>
          <span className={styles.hintKey}>&uarr;</span>
          <span className={styles.hintKey}>&darr;</span>
          {' Navigate  '}
          <span className={styles.hintKey}>Enter</span>
          {' Open  '}
          <span className={styles.hintKey}>Esc</span>
          {' Close'}
        </div>
      </div>
    </div>
  );
}
