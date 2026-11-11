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
 * still the previous campaign: the name is used only when the two ids agree, and until then
 * the bar keeps its generic "Campaigns / Campaign" rather than naming the wrong one.
 */
export function useCampaignCrumbs(
  campaignId: string | null | undefined,
  campaign: CrumbCampaign | null | undefined,
  trail: Crumb[],
): void {
  const current = campaignId && campaign && campaign.id === campaignId && campaign.name ? campaign : null;
  usePageCrumbs(
    current ? [{ label: current.name, to: `/agency/campaigns/${current.id}` }, ...trail] : null,
  );
}
