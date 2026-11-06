import { useLayoutEffect, type ReactNode } from 'react';
import { Router } from 'react-router-dom';
import { useUrlHistory, useUrlLocation } from '../../contexts/UrlScopeContext';
import { isUnscopedPagePath } from '../../utils/returnPath';

/**
 * The console's router: a `<Router>` over `UrlScopeProvider`'s history whose
 * `basename` is the URL's `/t/<tenant>/a/<account>` prefix, or `/` without one.
 *
 * The basename is what keeps the scope out of the rest of the app. Every
 * `<Link to="/agency/…">`, `<Navigate>` and `navigate('/…')` resolves under it, so
 * a click inside a scope stays in that scope, and `useLocation().pathname` reads
 * the app path (`/agency/campaigns`) that the route table, the sidebars and
 * `campaignPanelFromPath` were written against.
 *
 * One case it cannot carry: react-router never leaves its basename, so
 * `navigate('/login')` from inside a scope lands on `/t/…/a/…/login`. Sign-in and
 * invite pages are unscoped by definition (`isUnscopedPagePath`), so that URL is
 * replaced by the bare one before paint. `RequireAuth` puts the prefix into
 * `?next=` itself, so nothing about where the visitor was going is lost.
 */
export function ScopedRouter({ children }: { children: ReactNode }) {
  const { history, prefix, go } = useUrlHistory();
  const { location, action } = useUrlLocation();
  const strayed = prefix !== '' && isUnscopedPagePath(location.pathname);

  useLayoutEffect(() => {
    if (strayed) go(null, undefined, { replace: true });
  }, [strayed, go]);

  if (strayed) return null;

  return (
    <Router basename={prefix || '/'} location={location} navigationType={action} navigator={history}>
      {children}
    </Router>
  );
}
