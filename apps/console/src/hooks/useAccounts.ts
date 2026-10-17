import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { listAccounts } from '../api/accounts';
import type { Account } from '../types/auth';
import { awaitingScope } from './awaitingScope';

/** The tenant's accounts, stale-response guarded (`useAsyncResource`). */
export function useAccounts() {
  const { tenantId } = useTenant();
  const fetchAccounts = useCallback(
    (): Promise<Account[]> => (tenantId ? listAccounts(tenantId) : awaitingScope()),
    [tenantId],
  );
  const { data: accounts, loading, error, reload } = useAsyncResource(fetchAccounts, {
    initialData: [],
    errorMessage: 'Failed to load accounts',
  });

  return { accounts, loading, error, reload };
}
