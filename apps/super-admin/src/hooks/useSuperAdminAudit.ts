import { useState, useEffect, useCallback } from 'react';
import { listAuditLog } from '../api/super-admin';
import type { SuperAdminAuditEntry, SuperAdminAuditListParams } from '@magick-agency/contracts/api/platform/super-admin';

export function useSuperAdminAudit(
  limit = 50,
  offset = 0,
  filters: Omit<SuperAdminAuditListParams, 'limit' | 'offset'> = {},
) {
  const [entries, setEntries] = useState<SuperAdminAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    listAuditLog({ limit, offset, ...filters })
      .then((res) => {
        if (cancelled) return;
        setEntries(res.entries);
        setTotal(res.total);
        setActions(res.actions ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load audit log');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [limit, offset, filters.actor, filters.action, filters.resource_type, filters.resource_id, filters.q, filters.from, filters.to, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  return { entries, total, actions, loading, error, reload };
}
