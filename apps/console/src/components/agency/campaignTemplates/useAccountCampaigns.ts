import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../../../contexts/TenantContext';
import { listAgencyCampaigns } from '../../../api/agencyCampaigns';
import type { AgencyCampaign } from '../../../types/agency-campaign';

/**
 * The account's campaigns (not archived), newest first, read while `enabled`: the pickers of "Copy
 * from a campaign" (every status) and "Apply to draft campaigns" (`['draft']`).
 */
export function useAccountCampaigns(enabled: boolean, statuses?: readonly string[]) {
  const { tenantId, accountId } = useTenant();
  const key = statuses?.join(',') ?? '';
  const fetcher = useCallback(
    () => listAgencyCampaigns(tenantId ?? undefined, accountId ?? undefined, key ? key.split(',') : undefined),
    [tenantId, accountId, key],
  );
  return useAsyncResource<AgencyCampaign[]>(fetcher, {
    initialData: [],
    errorMessage: 'Could not load the campaigns.',
    enabled: enabled && Boolean(tenantId && accountId),
  });
}
