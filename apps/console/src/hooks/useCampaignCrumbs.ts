import { usePageCrumbs } from '../components/layout/PageCrumbs';
import type { Crumb } from '../utils/consoleNav';

/** What the breadcrumb needs of a campaign: the id it was read for, and its name. */
export interface CrumbCampaign {
  id: string;
  name: string;
}

/**
 * A campaign screen's breadcrumb in the top bar: "Campaigns / <name> / <trail…>". The name links
 * to the campaign (which lands each role on its first tab).
 *
 * `campaignId` is the id in the URL and `campaign` whatever the page holds in state. React-router
 * keeps a page mounted when the URL moves to another campaign, so for a moment the state is
 * still the previous campaign: the name is used only when the two ids agree. Until then (and
 * when the campaign cannot be read) the slot says "Campaign", so the rest of the trail is there
 * from the start and does not shift when the name lands.
 */
export function useCampaignCrumbs(
  campaignId: string | null | undefined,
  campaign: CrumbCampaign | null | undefined,
  trail: Crumb[],
): void {
  const name = campaignId && campaign && campaign.id === campaignId && campaign.name ? campaign.name : 'Campaign';
  usePageCrumbs(campaignId ? [{ label: name, to: `/agency/campaigns/${campaignId}` }, ...trail] : null);
}
