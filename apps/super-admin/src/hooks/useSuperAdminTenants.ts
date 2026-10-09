import { useState, useEffect, useCallback } from 'react';
import { listTenants } from '../api/super-admin';
import type { SuperAdminTenant } from '@magick-agency/contracts/api/platform/super-admin';

export function useSuperAdminTenants() {
  const [tenants, setTenants] = useState<SuperAdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listTenants();
      setTenants(res.tenants);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tenants');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { tenants, loading, error, reload: load };
}
