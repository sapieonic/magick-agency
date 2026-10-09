import { useState, useEffect, useCallback } from 'react';
import { getTenantDetail } from '../api/super-admin';
import type { SuperAdminTenantDetail } from '@magick-agency/contracts/api/platform/super-admin';

export function useSuperAdminTenant(tenantId: string | undefined) {
  const [data, setData] = useState<SuperAdminTenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * A silent refetch that FAILED, reported next to the action that triggered it
   * rather than in place of the page. Separate from `error` on purpose — see
   * below.
   */
  const [refreshError, setRefreshError] = useState<string | null>(null);

  /**
   * `silent` refetches without replacing the page — neither with a spinner nor
   * with an error.
   *
   * The page early-returns a full-page spinner on `loading` and a full-page
   * `ErrorAlert` on `error`, so BOTH flags unmount the tenant view. Skipping
   * only `setLoading` left the second half live: a reconcile that succeeded and
   * whose follow-up GET then 500'd or timed out replaced the whole page with
   * "Failed to load tenant", taking with it the result note the operator had
   * just earned. The money was fixed and the screen said the repair failed —
   * the most misleading state this surface can reach.
   *
   * So a silent load keeps the current `data` on screen and routes its failure
   * to `refreshError`, which the page renders beside the note. A full-page
   * error stays reserved for a real initial load, where there is nothing to
   * keep on screen and nothing else to explain the blank.
   */
  const load = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!tenantId) return;
    if (!silent) setLoading(true);
    if (silent) setRefreshError(null);
    else setError(null);
    try {
      const res = await getTenantDetail(tenantId);
      setData(res);
      setRefreshError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load tenant';
      if (silent) setRefreshError(message);
      else setError(message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  return { data, loading, error, refreshError, reload: load };
}
