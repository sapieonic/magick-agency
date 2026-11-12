import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { UrlScopeProvider } from '../../contexts/UrlScopeContext';
import { ScopedRouter } from '../../components/routing/ScopedRouter';
import { useCampaignCrumbs, type CrumbCampaign } from '../../hooks/useCampaignCrumbs';
import { readRecentCampaigns } from '../../utils/recentCampaigns';

/**
 * A campaign screen remembers its campaign for ⌘K's recent campaigns through its breadcrumb hook,
 * under the URL's account, and only once the campaign it holds is the one the URL names.
 */

function wrapper({ children }: { children: ReactNode }) {
  return (
    <UrlScopeProvider>
      <ScopedRouter>{children}</ScopedRouter>
    </UrlScopeProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/t/t1/a/a1/agency/campaigns/c-2/overview');
});
afterEach(cleanup);

describe('a campaign screen', () => {
  it('remembers the campaign it shows, under the URL’s account', () => {
    renderHook(() => useCampaignCrumbs('c-2', { id: 'c-2', name: 'Q4 collections' }, 'overview'), { wrapper });
    expect(readRecentCampaigns('t1', 'a1')).toEqual([{ id: 'c-2', name: 'Q4 collections' }]);
  });

  it('remembers nothing while it still holds the previous campaign, or none', () => {
    const { rerender } = renderHook(
      ({ campaign }: { campaign: CrumbCampaign | null }) => useCampaignCrumbs('c-2', campaign, 'overview'),
      { wrapper, initialProps: { campaign: { id: 'c-1', name: 'Diwali renewals' } as CrumbCampaign | null } },
    );
    rerender({ campaign: null });
    expect(readRecentCampaigns('t1', 'a1')).toEqual([]);
    rerender({ campaign: { id: 'c-2', name: 'Q4 collections' } });
    expect(readRecentCampaigns('t1', 'a1')).toEqual([{ id: 'c-2', name: 'Q4 collections' }]);
  });
});
