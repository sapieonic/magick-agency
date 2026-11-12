import { describe, expect, it } from 'vitest';
import { campaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { CAMPAIGN_TABS } from '../../utils/agencyCampaignTabs';

const diwali = { id: 'c-1', name: 'Diwali renewals' };

describe('campaignCrumbs', () => {
  it('names each tab as the campaign table does, unlinked when it is the page', () => {
    for (const tab of CAMPAIGN_TABS) {
      expect(campaignCrumbs('c-1', diwali, tab.id)).toEqual([
        { label: 'Diwali renewals', to: '/agency/campaigns/c-1' },
        { label: tab.label },
      ]);
    }
  });

  it('links the tab to its screen when a sub-page follows it', () => {
    expect(campaignCrumbs('c-1', diwali, 'attempts', [{ label: 'Attempt 4' }])).toEqual([
      { label: 'Diwali renewals', to: '/agency/campaigns/c-1' },
      { label: 'Call log', to: '/agency/campaigns/c-1/attempts' },
      { label: 'Attempt 4' },
    ]);
  });

  it('says "Campaign" until the campaign in state is the URL’s, and nothing without an id', () => {
    expect(campaignCrumbs('c-2', diwali, 'settings')?.[0]).toEqual({ label: 'Campaign', to: '/agency/campaigns/c-2' });
    expect(campaignCrumbs('c-1', null, 'settings')?.[0]).toEqual({ label: 'Campaign', to: '/agency/campaigns/c-1' });
    expect(campaignCrumbs(undefined, diwali, 'settings')).toBeNull();
  });
});
