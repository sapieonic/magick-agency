import { usePageCrumbs } from '../components/layout/PageCrumbs';
import type { Crumb } from '../utils/consoleNav';

/**
 * A campaign screen's breadcrumb in the top bar: "Campaigns / <name> / <trail…>". The name links
 * to the campaign (which lands each role on its first tab). Until the campaign has loaded the bar
 * keeps its generic "Campaigns / Campaign" rather than guessing.
 */
export function useCampaignCrumbs(
  campaignId: string | null | undefined,
  name: string | null | undefined,
  trail: Crumb[],
): void {
  usePageCrumbs(
    campaignId && name ? [{ label: name, to: `/agency/campaigns/${campaignId}` }, ...trail] : null,
  );
}
