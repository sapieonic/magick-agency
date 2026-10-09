import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { listAccounts } from '../api/accounts';
import type { Account } from '../types/auth';

export function useAccounts() {
  const { tenantId } = useTenant();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    listAccounts(tenantId)
      .then(setAccounts)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load accounts'))
      .finally(() => setLoading(false));
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  return { accounts, loading, error, reload: load };
}
