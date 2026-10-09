import { useState, useEffect, useCallback } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { listMyPhoneNumbers } from '../api/phone-numbers';
import type { TenantPhoneAssignment } from '../types/phone-number';

export function usePhoneNumbers() {
  const { tenantId, accountId } = useTenant();
  const [phoneNumbers, setPhoneNumbers] = useState<TenantPhoneAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!tenantId || !accountId) return;
    setLoading(true);
    setError(null);
    listMyPhoneNumbers(tenantId, accountId)
      .then(setPhoneNumbers)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load phone numbers'))
      .finally(() => setLoading(false));
  }, [tenantId, accountId]);

  useEffect(() => { load(); }, [load]);

  const defaultNumber = phoneNumbers.find(pn => pn.is_default)?.phone_number ?? phoneNumbers[0]?.phone_number ?? '';

  return { phoneNumbers, loading, error, reload: load, defaultNumber };
}
