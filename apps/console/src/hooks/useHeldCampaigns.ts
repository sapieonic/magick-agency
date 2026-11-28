import { listAgencyCampaigns, listArchivedAgencyCampaigns } from '../api/agencyCampaigns';
import type { AgencyCampaign } from '../types/agency-campaign';
import { useCompareRead } from './useCompareRead';

export interface HeldCampaigns {
  /** The account's campaigns: null until they load, empty when the read failed (`failed`). */
  campaigns: AgencyCampaign[] | null;
  failed: boolean;
  /** The campaign `campaignId` names, when the list has it. */
  campaign: AgencyCampaign | null;
  /** The campaign `campaignId` names when the list leaves it out and it is archived. */
  heldArchived: AgencyCampaign | null;
  /** Any campaign by id, from the list or, once read, the archived ones. */
  campaignNamed: (id: string | null) => AgencyCampaign | null;
}

/**
 * The campaigns a report page's picker offers (Compare agents, Team performance), and the one
 * the URL holds. A campaign the list leaves out may be archived since: only then are the archived
 * ones read, so the picker can name it "(archived)", as every other picker names one, rather than
 * by its name alone.
 */
export function useHeldCampaigns(tenantId: string, accountId: string, campaignId: string | null): HeldCampaigns {
  const scope = `${tenantId}/${accountId}`;
  const listRead = useCompareRead(scope, () => listAgencyCampaigns(tenantId, accountId));
  const failed = listRead.status === 'error';
  const campaigns = failed ? [] : listRead.data;
  const campaign = campaigns?.find((c) => c.id === campaignId) ?? null;
  const heldMissing = campaigns !== null && campaignId !== null && campaign === null;
  const archived = useCompareRead(heldMissing ? scope : null, () => listArchivedAgencyCampaigns(tenantId, accountId));
  const heldArchived = heldMissing ? (archived.data?.find((c) => c.id === campaignId) ?? null) : null;
  const campaignNamed = (id: string | null) =>
    campaigns?.find((c) => c.id === id) ?? archived.data?.find((c) => c.id === id) ?? null;
  return { campaigns, failed, campaign, heldArchived, campaignNamed };
}
