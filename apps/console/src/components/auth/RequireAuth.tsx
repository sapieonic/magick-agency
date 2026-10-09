import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { currentPath, loginPathReturningTo } from '../../utils/returnPath';
import type { ReactNode } from 'react';

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, pendingEmailVerification } = useAuth();
  const location = useLocation();

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
     */
    return <Navigate to={loginPathReturningTo(currentPath(location))} replace />;
  }

  return <>{children}</>;
}
