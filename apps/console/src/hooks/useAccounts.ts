import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { listAccounts } from '../api/accounts';
import type { Account } from '../types/auth';

/** The tenant's accounts, stale-response guarded (`useAsyncResource`). */
export function useAccounts() {
  const { tenantId } = useTenant();
  const fetchAccounts = useCallback(
    (): Promise<Account[]> => listAccounts(tenantId!),
    [tenantId],
  );
  // Waiting for the scope is still loading here: the page shows its spinner, never an empty list.
  const ready = tenantId !== null;
  const { data: accounts, loading, error, reload } = useAsyncResource(fetchAccounts, {
    initialData: [],
    errorMessage: 'Failed to load accounts',
    enabled: ready,
  });

  return { accounts, loading: loading || !ready, error, reload };
}
