import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useUrlScope } from '../../contexts/UrlScopeContext';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { currentPath, loginPathReturningTo } from '../../utils/returnPath';
import { withUrlScope } from '../../utils/urlScope';
import type { ReactNode } from 'react';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, pendingEmailVerification } = useAuth();
  const location = useLocation();
  const { scope } = useUrlScope();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (pendingEmailVerification) {
    return <Navigate to="/verify-email" replace />;
  }

  if (!user) {
    /**
     * The requested URL is carried through sign-in as `?next=`.
     *
     * It used to be thrown away, and `LoginPage` then navigated unconditionally to
     * `/app` — so a deep link into the product worked only for someone already
     * signed in. That is the failure mode a shareable entry point like `/dialer`
     * cannot afford: the whole point of giving an agent one URL to bookmark is that
     * it works on the one morning it matters, their first sign-in of the day.
     *
     * `/verify-email` above deliberately does NOT carry it. That branch is a
     * signed-in user with an unverified address, so there is nothing to come back
     * to yet — verification restarts the flow.
     *
     * See `utils/returnPath.ts` for why this is a query param rather than router
     * state, and for the open-redirect validation the value goes through on the way
     * back out.
     *
     * `location` is the app path, without the `/t/:tenantId/a/:accountId` prefix
     * (it is the router's basename), so the prefix is put back here. Without it a
     * shared link opened signed out would sign the visitor in to whichever account
     * their browser last had open — the one thing the scoped URL exists to stop.
     */
    const path = currentPath(location);
    return <Navigate to={loginPathReturningTo(scope ? withUrlScope(scope, path) : path)} replace />;
  }

  return <>{children}</>;
}
