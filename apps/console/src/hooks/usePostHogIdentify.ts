import { useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { identifyUser } from '../analytics/posthog';

/**
 * Identifies the authenticated user with PostHog and associates the active
 * tenant/account groups — mirroring the backend identity model
 * (distinct_id = user.id, groups `tenant` and `account`).
 *
 * Re-runs when the user or active tenant/account changes. Safe no-op when
 * analytics is disabled (no key) or the user isn't loaded yet.
 */
export function usePostHogIdentify(): void {
  const { user } = useAuth();
  const { activeTenant, tenantId, accountId, accounts, role } = useTenant();

  const activeAccount = accountId ? accounts.find((a) => a.id === accountId) ?? null : null;

  useEffect(() => {
    if (!user?.id) return;
    identifyUser({
      userId: user.id,
      email: user.email ?? undefined,
      displayName: user.display_name ?? undefined,
      role,
      tenantId: tenantId ?? undefined,
      accountId: accountId ?? undefined,
      tenant: activeTenant
        ? {
            name: activeTenant.name,
            slug: activeTenant.slug,
            status: activeTenant.status,
            created_at: activeTenant.created_at,
          }
        : undefined,
      account: activeAccount
        ? {
            name: activeAccount.name,
            slug: activeAccount.slug,
            status: activeAccount.status,
            created_at: activeAccount.created_at,
          }
        : undefined,
    });
  }, [user?.id, user?.email, user?.display_name, role, tenantId, accountId, activeTenant, activeAccount]);
}
