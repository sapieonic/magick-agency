import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { listMyPhoneNumbers } from '../api/phone-numbers';
import type { TenantPhoneAssignment } from '../types/phone-number';

/** The account's assigned numbers, stale-response guarded (`useAsyncResource`). */
export function usePhoneNumbers() {
  const { tenantId, accountId } = useTenant();
  const fetchNumbers = useCallback(
    (): Promise<TenantPhoneAssignment[]> => listMyPhoneNumbers(tenantId!, accountId!),
    [tenantId, accountId],
  );
  // Waiting for the scope is still loading here: the page shows its spinner, never an empty list.
  const ready = tenantId !== null && accountId !== null;
  const { data: phoneNumbers, loading, error, reload } = useAsyncResource(fetchNumbers, {
    initialData: [],
    errorMessage: 'Failed to load phone numbers',
    enabled: ready,
  });

  const defaultNumber = phoneNumbers.find(pn => pn.is_default)?.phone_number ?? phoneNumbers[0]?.phone_number ?? '';

  return { phoneNumbers, loading: loading || !ready, error, reload, defaultNumber };
}
