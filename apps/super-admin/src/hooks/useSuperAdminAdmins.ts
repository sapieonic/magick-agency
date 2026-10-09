import { useState, useEffect, useCallback } from 'react';
import { listAdmins } from '../api/super-admin';
import type { SuperAdmin } from '@magick-agency/contracts/api/platform/super-admin';

export function useSuperAdminAdmins() {
  const [admins, setAdmins] = useState<SuperAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listAdmins();
      setAdmins(res.admins);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { admins, loading, error, reload: load };
}
