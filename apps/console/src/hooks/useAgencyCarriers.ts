import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../contexts/TenantContext';
import { listAgencyCarriers } from '../api/agencyCarriers';
import type { AgencyCarrier } from '../types/agency-campaign';

/**
 * The carrier accounts this tenant's campaigns may dial on, or `null` until they are read
 * (and while `enabled` is false: the list needs `agency.campaigns.write`, so a read-only
 * viewer never asks). A failed read leaves `null` and sets `error`; callers then keep the
 * campaign on the carrier it already has, as the console did before the choice existed.
 */
export function useAgencyCarriers({ enabled = true }: { enabled?: boolean } = {}) {
  const { tenantId, accountId } = useTenant();
  const fetchCarriers = useCallback(
    (): Promise<AgencyCarrier[] | null> => listAgencyCarriers(tenantId!, accountId!),
    [tenantId, accountId],
  );
  const { data: carriers, error } = useAsyncResource<AgencyCarrier[] | null>(fetchCarriers, {
    initialData: null,
    errorMessage: 'Could not load the carriers',
    enabled: enabled && tenantId !== null && accountId !== null,
  });
  return { carriers, error };
}
