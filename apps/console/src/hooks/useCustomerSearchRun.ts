import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { searchCustomers } from '../api/customerHistory';
import { useTenant } from '../contexts/TenantContext';
import { rememberCustomerSearch } from '../utils/customerSearchRecent';
import { rememberCustomerSearchAnswer, type CustomerHistoryLocationState } from '../utils/customerHistoryStore';
import { customerHistoryRefusal } from '../utils/customerHistoryCopy';

export interface CustomerSearchRun {
  /**
   * Search one number and open its history: a `POST` with the raw text and the picked country
   * (CH6: never in a URL), the answer kept in memory and the number in the device's recent list,
   * then `resultsPath` with only the search id in the history state. True once it navigated;
   * false on a refusal (in {@link error}) or when a newer search or an unmount overtook it.
   */
  run: (value: string, countryIso: string) => Promise<boolean>;
  busy: boolean;
  /** The refusal in the console's words, or null. */
  error: string | null;
  clearError: () => void;
}

/**
 * The customer-history search as "Search a number" (`CustomerSearchBox`) and ⌘K
 * (`GlobalSearch`) both run it, so the two cannot drift: the same request and account header,
 * the same recent list, the same history state, and a search in flight cancelled when its
 * caller goes away, so a late answer never navigates.
 */
export function useCustomerSearchRun(resultsPath: string, store: Storage | undefined): CustomerSearchRun {
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The search in flight; aborted when the caller unmounts (the panel closed, the page left). */
  const inflight = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      inflight.current?.abort();
      inflight.current = null;
    },
    [],
  );

  const run = useCallback(
    async (value: string, iso: string): Promise<boolean> => {
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      setBusy(true);
      setError(null);
      try {
        // The platform default the picker does not list has no ISO: no `country` names it.
        const answer = await searchCustomers(
          iso ? { by: 'phone', value, country: iso } : { by: 'phone', value },
          tenantId ?? undefined,
          accountId ?? undefined,
          controller.signal,
        );
        // Nobody is waiting for this answer any more: never navigate them away from where they went.
        if (controller.signal.aborted) return false;
        rememberCustomerSearchAnswer(answer);
        rememberCustomerSearch(store, { e164: answer.key.value, country: iso });
        const state: CustomerHistoryLocationState = { searchId: answer.search_id };
        navigate(resultsPath, { state });
        return true;
      } catch (err: unknown) {
        if (controller.signal.aborted) return false;
        setError(customerHistoryRefusal(err, 'Could not search this number. Try again.', 'search').message);
        return false;
      } finally {
        if (inflight.current === controller) {
          inflight.current = null;
          setBusy(false);
        }
      }
    },
    [tenantId, accountId, store, navigate, resultsPath],
  );

  const clearError = useCallback(() => setError(null), []);

  return { run, busy, error, clearError };
}
