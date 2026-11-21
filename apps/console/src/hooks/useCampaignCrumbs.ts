import { usePageCrumbs } from '../components/layout/PageCrumbs';
import type { Crumb } from '../utils/consoleNav';
import { CAMPAIGN_TABS, campaignTabHref, type CampaignTabId } from '../utils/agencyCampaignTabs';
import { useRememberCampaignVisit } from './useRememberCampaignVisit';

/** What the breadcrumb needs of a campaign: the id it was read for, and its name. */
export interface CrumbCampaign {
  id: string;
  name: string;
  /** Set on an archived campaign (AR1–AR7): its trail goes through Archived campaigns. */
  archived_at?: string | null;
}

/**
 * A campaign screen's breadcrumb in the top bar: "Campaigns / <name> / <tab> / <subTrail…>". The
 * tab's label comes from `CAMPAIGN_TABS`; it links to the tab only when a sub-page follows it.
 * The name links to the campaign (which lands each role on its first tab), except on that tab
 * itself, where `breadcrumbFor` leaves it a plain name.
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
  tab: CampaignTabId,
  subTrail: Crumb[] = [],
): void {
  usePageCrumbs(campaignCrumbs(campaignId, campaign, tab, subTrail));
  useRememberCampaignVisit(campaignId, campaign);
}

/** The crumbs {@link useCampaignCrumbs} supplies: the campaign's name (or "Campaign"), the tab, then `subTrail`. */
export function campaignCrumbs(
  campaignId: string | null | undefined,
  campaign: CrumbCampaign | null | undefined,
  tab: CampaignTabId,
  subTrail: Crumb[] = [],
): Crumb[] | null {
  if (!campaignId) return null;
  const current = campaign?.id === campaignId ? campaign : null;
  const name = current?.name || 'Campaign';
  const label = CAMPAIGN_TABS.find((t) => t.id === tab)!.label;
  const tabCrumb: Crumb = subTrail.length > 0 ? { label, to: campaignTabHref(tab, campaignId) } : { label };
  // An archived campaign is not on the Campaigns page, so its trail (and the phone's back arrow)
  // goes through Archived campaigns, where it is listed (AR1–AR7).
  const archived = current?.archived_at
    ? [{ label: 'Archived campaigns', to: '/agency/campaigns/archived' }]
    : [];
  return [...archived, { label: name, to: `/agency/campaigns/${campaignId}` }, tabCrumb, ...subTrail];
}
