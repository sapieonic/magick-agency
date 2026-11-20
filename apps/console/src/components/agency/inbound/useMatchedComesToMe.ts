import { useEffect, useState } from 'react';
import { getMyContactsSummary } from '../../../api/agencyAssignment';
import { useTenant } from '../../../contexts/TenantContext';
import type { AgencyAssignmentMode } from '@magick-agency/contracts/agency';

/**
 * Whether a call-later booked on an inbound caller's matched contact comes back to this agent
 * (AS8): the matched campaign's routing decides, as it does for an outbound call. Strict and
 * preferred campaigns bring it to the agent; a pool campaign gives it to whoever is free.
 *
 * The station's own campaign answers from its bootstrap. Another campaign's routing is read once
 * per campaign from the agent's own summary there (`GET /my-contacts/summary`), and only once the
 * outcome is owed (`enabled`). Until it is known, or when it cannot be read, the answer is `false`:
 * "Another agent may get the call" is true whoever gets it, and the station never promises a call
 * it cannot keep.
 */
export function useMatchedComesToMe({
  campaignId,
  stationCampaignId,
  stationMode,
  enabled,
}: {
  /** The matched contact's campaign, or null for a caller on no list. */
  campaignId: string | null;
  stationCampaignId: string | null;
  stationMode: AgencyAssignmentMode | null;
  enabled: boolean;
}): boolean {
  const { tenantId, accountId } = useTenant();
  const own = campaignId !== null && campaignId === stationCampaignId;
  const [read, setRead] = useState<{ campaignId: string; mode: AgencyAssignmentMode | null } | null>(null);

  useEffect(() => {
    if (!enabled || campaignId === null || own || read?.campaignId === campaignId) return undefined;
    let live = true;
    getMyContactsSummary(campaignId, tenantId ?? undefined, accountId ?? undefined)
      .then((summary) => {
        if (live) setRead({ campaignId, mode: summary.assignment_mode ?? null });
      })
      .catch(() => {
        if (live) setRead({ campaignId, mode: null });
      });
    return () => {
      live = false;
    };
  }, [enabled, campaignId, own, read?.campaignId, tenantId, accountId]);

  const mode = own ? stationMode : read?.campaignId === campaignId ? read.mode : null;
  return mode !== null && mode !== 'pool';
}
