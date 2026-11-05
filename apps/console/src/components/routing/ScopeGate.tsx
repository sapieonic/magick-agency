import { useLayoutEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useUrlScope } from '../../contexts/UrlScopeContext';
import type { UrlScope } from '../../utils/urlScope';

/**
 * Keeps every signed-in page's URL scoped to the tenant and account on screen,
 * `/t/:tenantId/a/:accountId/…` — the layout route around every route that needs a
 * sign-in (`App.tsx`). What it decides, given the URL and `TenantContext`:
 *
 *  - **Unscoped URL** (an old `/dialer` bookmark, `/` after sign-in, a tenant
 *    switch): once an account is resolved, REPLACE the URL with the same app path
 *    under `/t/<tenant>/a/<account>`. Replace, not push, so the back button does
 *    not land on the unscoped URL and get bounced forward again.
 *  - **Scoped URL the context has adopted**: render the page.
 *  - **Scoped URL naming a tenant or account this person cannot open**: say so
 *    (`ScopeUnavailable`). Silently opening another account instead would show
 *    the wrong data under a link that promised something else — the one failure a
 *    shareable link must not have.
 *
 * And what it deliberately leaves alone, rendering the page as before:
 *
 *  - **Not signed in** (or still loading, or awaiting email verification):
 *    `RequireAuth` inside each route owns that, and carries the scoped URL
 *    through sign-in as `?next=`.
 *  - **No tenant, no account, or account resolution failed**: there is no scope to
 *    put in the URL, and the layouts already have copy and a retry for each
 *    (`HomeRedirect`'s bound, `AccountUnavailable`). Waiting here would turn
 *    those into a spinner with no way out.
 */
export function ScopeGate() {
  const { user, loading, tenants, pendingEmailVerification } = useAuth();
  const { tenantId, accountId, accounts, accountResolution } = useTenant();
  const { scope, go } = useUrlScope();

  const decision = decide();

  // Keyed on the ids, not the object, which `decide` rebuilds every render.
  const enterTenant = decision.kind === 'enter' ? decision.scope.tenantId : null;
  const enterAccount = decision.kind === 'enter' ? decision.scope.accountId : null;
  useLayoutEffect(() => {
    if (enterTenant && enterAccount) {
      go({ tenantId: enterTenant, accountId: enterAccount }, undefined, { replace: true });
    }
  }, [enterTenant, enterAccount, go]);

  switch (decision.kind) {
    case 'render':
      return <Outlet />;
    case 'denied':
      return <ScopeUnavailable what={decision.what} />;
    case 'enter':
    case 'wait':
      return (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
          <LoadingSpinner size="lg" />
        </div>
      );
  }

  function decide():
    | { kind: 'render' }
    | { kind: 'wait' }
    | { kind: 'enter'; scope: UrlScope }
    | { kind: 'denied'; what: 'tenant' | 'account' } {
    if (loading || !user || pendingEmailVerification) return { kind: 'render' };
    // `tenants` is written in the same update as `user`, so empty here is final.
    if (tenants.length === 0) return { kind: 'render' };

    if (scope) {
      if (!tenants.some((t) => t.id === scope.tenantId)) return { kind: 'denied', what: 'tenant' };
      // The context adopts the URL's tenant in an effect; this is the render before.
      if (tenantId !== scope.tenantId) return { kind: 'wait' };
      if (accountResolution === 'loading') return { kind: 'wait' };
      if (accountResolution === 'error') return { kind: 'render' };
      if (accountId === scope.accountId) return { kind: 'render' };
      // Listed but not yet adopted (the render before the context's effect), or
      // not one of theirs at all.
      return accounts.some((a) => a.id === scope.accountId)
        ? { kind: 'wait' }
        : { kind: 'denied', what: 'account' };
    }

    if (accountResolution === 'loading') return { kind: 'wait' };
    if (tenantId && accountId && accountResolution !== 'error') {
      return { kind: 'enter', scope: { tenantId, accountId } };
    }
    return { kind: 'render' };
  }
}

/**
 * A shared link to a tenant or account the signed-in person cannot open.
 *
 * Full-viewport, outside both shells, so it carries its own way out: back to their
 * own workspace (the unscoped root, which `ScopeGate` then scopes to the account
 * they can open), or sign out — the link may simply have been meant for another
 * of their sign-ins.
 */
function ScopeUnavailable({ what }: { what: 'tenant' | 'account' }) {
  const { logout } = useAuth();
  const { accountResolution, reloadAccounts } = useTenant();
  const { go } = useUrlScope();
  // A narrowed account list (`'degraded'`) may simply be missing the account, so
  // that case is offered a retry rather than told it has no access.
  const mayBeShort = what === 'account' && accountResolution === 'degraded';

  return (
    <div style={{ padding: '3rem 1rem' }}>
      <EmptyState
        icon={<Lock size={40} aria-hidden />}
        title={what === 'tenant' ? 'You can’t open this workspace' : 'You can’t open this account'}
        description={
          mayBeShort
            ? 'We couldn’t load your full list of accounts, so we can’t tell yet whether you have access to the one this link is for. Try again in a moment.'
            : `This link is for ${what === 'tenant' ? 'a workspace' : 'an account'} you aren’t a member of with this sign-in. Ask whoever sent it to check your access, or carry on in your own.`
        }
        action={
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
            {mayBeShort ? (
              <button type="button" onClick={reloadAccounts}>
                Try again
              </button>
            ) : null}
            <button type="button" onClick={() => go(null, '/')}>
              Go to my workspace
            </button>
            <button type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        }
      />
    </div>
  );
}
