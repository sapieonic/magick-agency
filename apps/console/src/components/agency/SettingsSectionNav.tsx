import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { prefersReducedMotion, useKeepCurrentInStrip } from '../../hooks/useKeepCurrentInStrip';
import styles from './SettingsSectionNav.module.css';

export interface SettingsNavSection {
  id: string;
  label: string;
}

/** How long a picked section stays highlighted while the page scrolls to it. */
const PICK_HOLD_MS = 900;

/**
 * How far above a jumped-to section's top the "being read" band starts. A jump lands a
 * section its `scroll-margin-top` below the top of the scroll area; the section above it ends
 * a card gap higher, at or under that edge (under the sticky strip on a phone). Starting the
 * band a little above the landing line keeps that last sliver from counting as being read.
 */
const BAND_SLACK_PX = 8;

/** The nearest ancestor that scrolls vertically (the console's content pane), or `null` for the viewport. */
function scrollAreaOf(element: Element | null): Element | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** Where the band starts below the top of the scroll area, from where a jump lands a section. */
function bandTopOf(element: Element | null): number {
  const landing = element ? parseFloat(getComputedStyle(element).scrollMarginTop) : 0;
  return Math.max(0, (Number.isFinite(landing) ? landing : 0) - BAND_SLACK_PX);
}

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
 * - The highlight follows the topmost section crossing the upper part of the scroll area (an
 *   `IntersectionObserver` rooted on it; without one, as in jsdom, it stays where it was put).
 *   The band starts just above where a jump lands a section (`bandTopOf`), so the tail of the
 *   section above, left at the top edge or under the phone's sticky strip, does not win.
 * - `select(id)` scrolls to the section, highlights it at once and writes `#id` into the URL
 *   (replacing, so Back leaves the page rather than walking its sections).
 * - Every navigation to `#id` naming a section opens the page at it, once `ready` says the
 *   sections are on the page: the first arrival, and each later one while the page stays
 *   mounted (react-router keeps this page's instance across `…/settings#a` → `…/settings#b`, and
 *   across campaigns, when search jumps there). Each navigation is handled once, by its
 *   location (react-router hands out a new one per navigation), not by `location.key`: a
 *   fragment typed into the address bar has no history state, so every such navigation
 *   reads `key` 'default', the same as the page's first arrival. The one `select` itself
 *   wrote is not scrolled to again.
 *
 * `ready` must be false while the sections on screen are not the ones the URL is about (a
 * campaign still loading after a jump from another), or the jump would land on the old page.
 *
 * `mountKey` changes whenever the page remounts its sections under the same ids (campaign
 * Settings' Discard): the observer watches elements, not ids, so it must be pointed at the new
 * ones or the highlight stops following the scroll.
 */
export function useSectionInView(
  sections: readonly SettingsNavSection[],
  ready: boolean,
  mountKey: string | number = 0,
) {
  const location = useLocation();
  const { pathname, search, hash } = location;
  const navigate = useNavigate();
  const ids = sections.map((s) => s.id);
  const idsKey = ids.join(' ');
  const hashId = sectionIdOfHash(hash);
  const [active, setActive] = useState<string | null>(ids.includes(hashId) ? hashId : ids[0] ?? null);
  const holdUntil = useRef(0);
  /** The navigation (its location) last opened at its section, or found to name none. */
  const handled = useRef<typeof location | null>(null);
  /** The hash `select` just wrote: its navigation is already scrolled to. */
  const pickedHash = useRef<string | null>(null);

  // Arrival at `#id`: once per navigation, as soon as the sections exist.
  useEffect(() => {
    if (!ready || handled.current === location) return;
    handled.current = location;
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
  }, [ready, idsKey, hashId, hash, location]);

  useEffect(() => {
    if (!ready || typeof IntersectionObserver === 'undefined') return undefined;
    const list = idsKey.split(' ');
    const elements = list.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null);
    let observer: IntersectionObserver | null = null;
    let bandTop = -1;
    const observe = () => {
      const top = bandTopOf(elements[0] ?? null);
      if (observer && top === bandTop) return;
      observer?.disconnect();
      bandTop = top;
      const visible = new Set<string>();
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) visible.add(entry.target.id);
            else visible.delete(entry.target.id);
          }
          if (Date.now() < holdUntil.current) return;
          const first = list.find((id) => visible.has(id));
          if (first) setActive(first);
        },
        // The band from just above the landing line to 40% down the scroll area: the section
        // being read.
        { root: scrollAreaOf(elements[0] ?? null), rootMargin: `-${top}px 0px -60% 0px`, threshold: 0 },
      );
      for (const element of elements) observer.observe(element);
    };
    observe();
    // The landing line moves with the layout (a phone's strip needs more room above a section).
    // Measured once a frame, not on every resize event.
    let frame = 0;
    const onResize = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        observe();
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [ready, idsKey, mountKey]);

  const select = useCallback(
    (id: string) => {
      setActive(id);
      pickedHash.current = `#${id}`;
      holdUntil.current = Date.now() + PICK_HOLD_MS;
      document.getElementById(id)?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
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
 *
 * On the strip, the highlighted section is scrolled into sight whenever it changes, so the
 * strip always shows where the page is.
 */
export function SettingsSectionNav({ sections, active, onSelect }: SettingsSectionNavProps) {
  const navRef = useRef<HTMLElement>(null);
  // A column, or a strip with room for every section, has nothing out of sight.
  useKeepCurrentInStrip(navRef, '[aria-current="true"]', active, { smooth: true });

  return (
    <nav ref={navRef} className={styles.nav} aria-label="Settings sections" data-testid="settings-section-nav">
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
