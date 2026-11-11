import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * A page naming itself in the top bar's breadcrumb (`components/layout/PageCrumbs`): the
 * campaign screens say "Campaigns / <name> / <tab>" where the URL alone gives only
 * "Campaigns / Campaign". The crumbs are held against the path they were set for, so a page
 * that has been left never names the next one.
 */

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' }),
}));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));
vi.mock('../../components/agency/customers/CustomerSearchPopover', () => ({ CustomerSearchPopover: () => null }));

import { ConsoleTopBar } from '../../components/layout/ConsoleTopBar';
import { PageCrumbsProvider } from '../../components/layout/PageCrumbs';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';

function CampaignPage({ name }: { name: string | null }) {
  useCampaignCrumbs('camp-1', name, [{ label: 'Settings' }]);
  return <Link to="/agency/campaigns/camp-2/overview">Another campaign</Link>;
}

function SilentPage() {
  return <p>No crumbs supplied</p>;
}

function renderAt(name: string | null, withProvider = true) {
  const routes = (
    <>
      <ConsoleTopBar />
      <Routes>
        <Route path="/agency/campaigns/camp-1/settings" element={<CampaignPage name={name} />} />
        <Route path="/agency/campaigns/camp-2/overview" element={<SilentPage />} />
      </Routes>
    </>
  );
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
      {withProvider ? <PageCrumbsProvider>{routes}</PageCrumbsProvider> : routes}
    </MemoryRouter>,
  );
}

const crumbs = () => within(screen.getByTestId('console-breadcrumb')).getAllByRole('listitem')
  .map((item) => item.textContent)
  .filter((text) => text !== '/');

afterEach(cleanup);

describe('the breadcrumb a page supplies', () => {
  it('names the campaign and the tab, linking back to the campaign', async () => {
    renderAt('Q3 Renewals');
    await act(async () => {});

    expect(crumbs()).toEqual(['Campaigns', 'Q3 Renewals', 'Settings']);
    const bar = within(screen.getByTestId('console-breadcrumb'));
    expect(bar.getByRole('link', { name: 'Q3 Renewals' }).getAttribute('href')).toBe('/agency/campaigns/camp-1');
    expect(bar.getByRole('link', { name: 'Campaigns' }).getAttribute('href')).toBe('/agency/campaigns');
    expect(bar.getByText('Settings').getAttribute('aria-current')).toBe('page');
  });

  it('keeps the generic crumb until the campaign’s name is known', async () => {
    renderAt(null);
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Campaign']);
  });

  it('drops a page’s crumbs once it has been left', async () => {
    renderAt('Q3 Renewals');
    await act(async () => {});
    fireEvent.click(screen.getByRole('link', { name: 'Another campaign' }));
    await act(async () => {});

    expect(screen.getByText('No crumbs supplied')).toBeTruthy();
    expect(crumbs()).toEqual(['Campaigns', 'Campaign']);
  });

  it('does nothing outside the console layout', async () => {
    renderAt('Q3 Renewals', false);
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Campaign']);
  });
});
