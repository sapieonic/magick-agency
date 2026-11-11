import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { Link, MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

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
  useCampaignCrumbs('camp-1', name === null ? null : { id: 'camp-1', name }, [{ label: 'Settings' }]);
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

const NAMES: Record<string, string> = { 'camp-1': 'Q3 Renewals', 'camp-2': 'Diwali' };

/** A campaign page as the real ones are: the URL's id, and whatever campaign state holds. */
function LoadingCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<{ id: string; name: string } | null>({ id: 'camp-1', name: NAMES['camp-1']! });
  useCampaignCrumbs(id, campaign, [{ label: 'Settings' }]);
  return (
    <>
      <Link to="/agency/campaigns/camp-2/settings">Go to camp-2</Link>
      <button type="button" onClick={() => setCampaign({ id: id!, name: NAMES[id!]! })}>Load</button>
    </>
  );
}

function renderStale() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
      <PageCrumbsProvider>
        <ConsoleTopBar />
        <Routes>
          <Route path="/agency/campaigns/:id/settings" element={<LoadingCampaignPage />} />
        </Routes>
      </PageCrumbsProvider>
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

  it('holds the campaign’s slot until its name is known', async () => {
    renderAt(null);
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Campaign', 'Settings']);
    expect(within(screen.getByTestId('console-breadcrumb')).getByRole('link', { name: 'Campaign' })
      .getAttribute('href')).toBe('/agency/campaigns/camp-1');
  });

  it('never names the previous campaign while the next one loads', async () => {
    renderStale();
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Q3 Renewals', 'Settings']);

    // Same route, another campaign: the page stays mounted with the first one in state.
    fireEvent.click(screen.getByRole('link', { name: 'Go to camp-2' }));
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Campaign', 'Settings']);

    // Its own name once it has loaded.
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await act(async () => {});
    expect(crumbs()).toEqual(['Campaigns', 'Diwali', 'Settings']);
    expect(within(screen.getByTestId('console-breadcrumb')).getByRole('link', { name: 'Diwali' })
      .getAttribute('href')).toBe('/agency/campaigns/camp-2');
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
