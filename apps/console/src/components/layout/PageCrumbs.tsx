import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { Crumb } from '../../utils/consoleNav';

/**
 * How a page tells the top bar's breadcrumb what `consoleNav` cannot know from the URL, such as
 * a campaign's name: "Campaigns / Diwali renewals / Settings" instead of "Campaigns / Campaign".
 *
 * A page calls `usePageCrumbs([...])` with the crumbs that follow its section; `breadcrumbFor`
 * puts the section first. The crumbs are held against the path they were set for, so a page
 * that has just been left never names the next one, and outside `ConsoleLayout` (a page in a
 * test, say) the hook does nothing.
 */
interface PageCrumbsState {
  pathname: string;
  crumbs: Crumb[];
}

type SetCrumbs = (next: PageCrumbsState | null) => void;

/* Two contexts, so a page that sets its crumbs is not re-rendered by its own setting them. */
const SetCrumbsContext = createContext<SetCrumbs | null>(null);
const CrumbsContext = createContext<PageCrumbsState | null>(null);

export function PageCrumbsProvider({ children }: { children: ReactNode }) {
  const [value, set] = useState<PageCrumbsState | null>(null);
  return (
    <SetCrumbsContext.Provider value={set}>
      <CrumbsContext.Provider value={value}>{children}</CrumbsContext.Provider>
    </SetCrumbsContext.Provider>
  );
}

/**
 * Supply the crumbs after the section for the current page, or `null` to leave the default.
 * Compared by content, so a fresh array each render does not loop.
 */
export function usePageCrumbs(crumbs: Crumb[] | null): void {
  const set = useContext(SetCrumbsContext);
  const { pathname } = useLocation();
  const key = crumbs ? JSON.stringify(crumbs) : null;

  useEffect(() => {
    if (!set || key === null) return undefined;
    set({ pathname, crumbs: JSON.parse(key) as Crumb[] });
    return () => set(null);
  }, [set, pathname, key]);
}

/** The crumbs the page on `pathname` supplied, if any; read by the top bar. */
export function useSuppliedCrumbs(pathname: string): Crumb[] | null {
  const value = useContext(CrumbsContext);
  return value && value.pathname === pathname ? value.crumbs : null;
}
