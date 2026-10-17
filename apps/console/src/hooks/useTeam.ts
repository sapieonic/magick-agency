import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { listTenantMembers } from '../api/tenants';
import type { TenantMember } from '../types/team';
import { awaitingScope } from './awaitingScope';

/**
 * The tenant's members. A reload keeps the previous list in place while it runs,
 * and a slower, older response can never overwrite a newer one
 * (`useAsyncResource`).
 *
 * `loaded` is true once any load has answered — what lets a page show its
 * spinner for the first load only, rather than blanking the table on every reload.
 */
export function useTeam() {
  const { tenantId } = useTenant();
  const fetchMembers = useCallback(
    (): Promise<TenantMember[] | null> => (tenantId ? listTenantMembers(tenantId) : awaitingScope()),
    [tenantId],
  );
  const { data, loading, error, reload } = useAsyncResource(fetchMembers, {
    initialData: null,
    errorMessage: 'Failed to load team',
  });

  return { members: data ?? [], loaded: data !== null, loading, error, reload };
}
