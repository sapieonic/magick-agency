import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { listTenantMembers } from '../api/tenants';
import type { TenantMember } from '../types/team';

export function useTeam() {
  const { tenantId } = useTenant();
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!tenantId) return;
    setLoading(true);
    setError(null);
    listTenantMembers(tenantId)
      .then(setMembers)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load team'))
      .finally(() => setLoading(false));
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  return { members, loading, error, reload: load };
}
