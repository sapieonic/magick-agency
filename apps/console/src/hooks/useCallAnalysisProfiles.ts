import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import {
  listCallAnalysisProfiles,
  deleteCallAnalysisProfile,
} from '../api/call-analysis-profiles';
import type { CallAnalysisProfile } from '../types/call-analysis-profile';

/**
 * The account's call-analysis profiles. Mirrors `useSipConnections`: load-on-mount,
 * `reload` for post-mutation refresh, `remove` for a delete-then-refresh.
 *
 * `defaultProfile` is surfaced separately because the dialer needs to pre-select
 * it — the account's `is_default` profile is what a call gets when the agent
 * doesn't choose one, so the picker should show that choice rather than imply
 * "none".
 */
export function useCallAnalysisProfiles(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  const { tenantId, accountId } = useTenant();
  const [profiles, setProfiles] = useState<CallAnalysisProfile[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!enabled || !tenantId || !accountId) {
      // Gated off or ids not yet resolved: clear the spinner so the consumer
      // renders its empty/gated state instead of hanging on loading=true.
      setLoading(false);
      return () => {};
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    listCallAnalysisProfiles(tenantId, 100, 0, accountId)
      .then(res => {
        if (cancelled) return;
        setProfiles(res.profiles ?? []);
        setTotal(res.total ?? 0);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load analysis profiles');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [enabled, tenantId, accountId]);

  useEffect(() => load(), [load]);

  const remove = useCallback(async (id: string) => {
    /*
      Throws rather than resolving, because resolving to `undefined` is
      indistinguishable from a successful delete at the call site: the dialog
      closes, nothing is said, and the row is still in the table — the exact
      symptom the delete-refusal fix removed, reached from a different cause.
      `AnalysisProfilesPage` renders `err.message` above the table, so this lands
      where a refusal lands.

      Narrow: both ids resolve before any row can render, so this is unreachable
      in practice. That is why it is a throw rather than a rendered state — what
      it must not be is a silent no-op.
    */
    if (!tenantId || !accountId) {
      throw new Error('No workspace is selected. Reload the page and try again.');
    }
    await deleteCallAnalysisProfile(tenantId, id, accountId);
    load();
  }, [tenantId, accountId, load]);

  const defaultProfile = profiles.find(p => p.is_default) ?? null;

  return { profiles, total, defaultProfile, loading, error, reload: load, remove };
}
