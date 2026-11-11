import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import styles from './SettingsSectionNav.module.css';

export interface SettingsNavSection {
  id: string;
  label: string;
}

/** How long a picked section stays highlighted while the page scrolls to it. */
const PICK_HOLD_MS = 900;

/**
 * The section id a URL hash names. A hash is percent-encoded text typed or pasted by anyone,
 * so a malformed one (`#%E0%A4%A`) is read as written rather than thrown: it names no section.
 */
export function sectionIdOfHash(hash: string): string {
  const raw = hash.replace(/^#/, '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Which section is in view, for the nav's highlight, and the jump to one.
 *
 * - The highlight follows the topmost section crossing the upper part of the view (an
 *   `IntersectionObserver`; without one, as in jsdom, it stays where it was put).
 * - `select(id)` scrolls to the section, highlights it at once and writes `#id` into the URL
 *   (replacing, so Back leaves the page rather than walking its sections).
 * - Every navigation to `#id` naming a section opens the page at it, once `ready` says the
 *   sections are on the page: the first arrival, and each later one while the page stays
 *   mounted (react-router keeps this page's instance across `…/settings#a` → `…/settings#b`, and
 *   across campaigns, when search jumps there). Each navigation is handled once, by its
 *   `location.key`; the one `select` itself wrote is not scrolled to again.
 *
 * `ready` must be false while the sections on screen are not the ones the URL is about (a
 * campaign still loading after a jump from another), or the jump would land on the old page.
 */
export function useSectionInView(sections: readonly SettingsNavSection[], ready: boolean) {
  const { pathname, search, hash, key } = useLocation();
  const navigate = useNavigate();
  const ids = sections.map((s) => s.id);
  const idsKey = ids.join(' ');
  const hashId = sectionIdOfHash(hash);
  const [active, setActive] = useState<string | null>(ids.includes(hashId) ? hashId : ids[0] ?? null);
  const holdUntil = useRef(0);
  /** The navigation (`location.key`) last opened at its section, or found to name none. */
  const handledKey = useRef<string | null>(null);
  /** The hash `select` just wrote: its navigation is already scrolled to. */
  const pickedHash = useRef<string | null>(null);

  // Arrival at `#id`: once per navigation, as soon as the sections exist.
  useEffect(() => {
    if (!ready || handledKey.current === key) return;
    handledKey.current = key;
    if (pickedHash.current !== null && pickedHash.current === hash) {
      pickedHash.current = null;
      return;
    }
    pickedHash.current = null;
    const list = idsKey.split(' ');
    if (!hashId || !list.includes(hashId)) return;
    setActive(hashId);
    holdUntil.current = Date.now() + PICK_HOLD_MS;
    document.getElementById(hashId)?.scrollIntoView?.({ block: 'start' });
  }, [ready, idsKey, hashId, hash, key]);

  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return undefined;
    const list = idsKey.split(' ');
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        if (Date.now() < holdUntil.current) return;
        const first = list.find((id) => visible.has(id));
        if (first) setActive(first);
      },
      // The band from the top of the view to 40% down: the section being read.
      { rootMargin: '0px 0px -60% 0px', threshold: 0 },
    );
    for (const id of list) {
      const element = document.getElementById(id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [ready, idsKey]);

  const select = useCallback(
    (id: string) => {
      setActive(id);
      pickedHash.current = `#${id}`;
      holdUntil.current = Date.now() + PICK_HOLD_MS;
      const reduce = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.getElementById(id)?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      navigate({ pathname, search, hash: `#${id}` }, { replace: true });
    },
    [navigate, pathname, search],
  );

  // A section that has gone (a flag turned off) is never left highlighted.
  const current = active !== null && ids.includes(active) ? active : ids[0] ?? null;
  return { active: current, select };
}

interface SettingsSectionNavProps {
  sections: readonly SettingsNavSection[];
  active: string | null;
  onSelect: (id: string) => void;
}

/**
 * A page's in-page section list: a sticky column beside the sections on a wide screen, a
 * sideways-scrolling strip above them on a phone. Plain anchors (`#id`), so each is a real link
 * that can be copied or opened without the script; a click scrolls smoothly instead.
 */
export function SettingsSectionNav({ sections, active, onSelect }: SettingsSectionNavProps) {
  return (
    <nav className={styles.nav} aria-label="Settings sections" data-testid="settings-section-nav">
      <ul className={styles.list}>
        {sections.map((section) => {
          const isActive = section.id === active;
          return (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className={`${styles.link} ${isActive ? styles.linkActive : ''}`}
                aria-current={isActive ? 'true' : undefined}
                data-testid={`settings-section-link-${section.id}`}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                  event.preventDefault();
                  onSelect(section.id);
                }}
              >
                {section.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
