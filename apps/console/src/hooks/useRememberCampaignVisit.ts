import { useEffect } from 'react';
import { useUrlScope } from '../contexts/UrlScopeContext';
import { rememberCampaignVisit } from '../utils/recentCampaigns';
import type { CrumbCampaign } from './useCampaignCrumbs';

/**
 * Remember that this campaign was opened, for ⌘K's recent campaigns (`utils/recentCampaigns.ts`),
 * once the page holds the campaign the URL names (`campaignId`), under the URL's account. Outside
 * a scoped URL (a unit test's memory router) nothing is remembered.
 */
export function useRememberCampaignVisit(
  campaignId: string | null | undefined,
  campaign: CrumbCampaign | null | undefined,
): void {
  const { scope } = useUrlScope();
  const name = campaign && campaignId && campaign.id === campaignId ? campaign.name : null;
  useEffect(() => {
    if (scope && campaignId && name) rememberCampaignVisit(scope.tenantId, scope.accountId, campaignId, name);
  }, [scope, campaignId, name]);
}
