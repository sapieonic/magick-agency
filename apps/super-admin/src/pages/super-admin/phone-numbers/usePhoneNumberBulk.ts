import { useCallback, useMemo, useState } from 'react';
import { retirePhoneNumber, reactivatePhoneNumber } from '../../../api/super-admin';
import type { PhoneNumber } from '@magick-agency/contracts/api/platform/super-admin';
import { mapWithConcurrency } from '@magick-agency/web-ui/concurrency';

export type BulkAction = 'retire' | 'reactivate';

/**
 * Row selection and the bulk retire / reactivate run of the phone-numbers page.
 *
 * Only VISIBLE rows count: `visible` is the filtered table, so a row hidden by
 * a filter or the search is never acted on even if it was selected earlier.
 * Eligibility is derived from row data: retire takes active numbers with no
 * tenant assignments, reactivate takes retired ones.
 */
export function usePhoneNumberBulk(visible: PhoneNumber[], { afterRun, onError }: {
  /** Runs after every bulk run, whatever the outcome (the page refetches). */
  afterRun: () => Promise<void>;
  /** The partial-failure tally, or `null` to clear the page's error first. */
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<BulkAction | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const selectedRows = useMemo(
    () => visible.filter(pn => selected.has(pn.id)),
    [visible, selected],
  );
  const retireEligible = useMemo(
    () => selectedRows.filter(pn => pn.status === 'active' && (pn.assignment_count ?? 0) === 0),
    [selectedRows],
  );
  const reactivateEligible = useMemo(
    () => selectedRows.filter(pn => pn.status === 'retired'),
    [selectedRows],
  );

  const allVisibleSelected = visible.length > 0 && visible.every(pn => selected.has(pn.id));

  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelected(prev => {
      if (visible.length > 0 && visible.every(pn => prev.has(pn.id))) return new Set();
      return new Set(visible.map(pn => pn.id));
    });
  };

  // Run a bulk lifecycle action over the eligible selected rows using the
  // per-item endpoints, at most `DEFAULT_CONCURRENCY` in flight, then refetch.
  const runBulk = async () => {
    const action = bulkAction;
    if (!action) return;
    const targets = action === 'retire' ? retireEligible : reactivateEligible;
    setBulkRunning(true);
    onError(null);
    // Run all eligible items, tolerating partial failure: settled results let
    // us report exactly how many succeeded/failed instead of aborting on the
    // first error and leaving the table out of sync with the server.
    const results = await mapWithConcurrency(targets, pn =>
      action === 'retire' ? retirePhoneNumber(pn.id) : reactivatePhoneNumber(pn.id),
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    const succeeded = results.length - failed;
    try {
      await afterRun(); // always refetch so the table reflects server state
    } finally {
      setBulkRunning(false);
      setBulkAction(null);
    }
    if (failed > 0) {
      const verb = action === 'retire' ? 'retired' : 'reactivated';
      onError(
        `${succeeded} number${succeeded !== 1 ? 's' : ''} ${verb}, ${failed} failed. Please retry the failed number${failed !== 1 ? 's' : ''}.`,
      );
    }
  };

  return {
    selected,
    selectedRows,
    retireEligible,
    reactivateEligible,
    allVisibleSelected,
    bulkAction,
    setBulkAction,
    bulkRunning,
    clearSelection,
    toggleSelect,
    toggleSelectAll,
    runBulk,
  };
}
