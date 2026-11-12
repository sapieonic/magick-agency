import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The phone's back arrow in the top bar (B28): at phone width the breadcrumb shows only the
 * current page, so a back arrow goes to the crumb above it. Pages leave their own breadcrumbs
 * out and rely on it, so it must be there wherever there is somewhere to go back to.
 */

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' }),
}));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));

import { ConsoleTopBar } from '../../components/layout/ConsoleTopBar';
import { PageCrumbsProvider, usePageCrumbs } from '../../components/layout/PageCrumbs';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import type { CampaignTabId } from '../../utils/agencyCampaignTabs';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function CampaignSettings() {
  usePageCrumbs([{ label: 'Diwali renewals', to: '/agency/campaigns/c-1/overview' }, { label: 'Settings' }]);
  return <Where />;
}

/** A campaign tab, naming the campaign as the real pages do. */
function CampaignTab({ tab }: { tab: CampaignTabId }) {
  useCampaignCrumbs('c-1', { id: 'c-1', name: 'Diwali renewals' }, tab);
  return <Where />;
}

function renderAt(path: string, phone: boolean) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PageCrumbsProvider>
        <ConsoleTopBar phone={phone} />
        <Routes>
          <Route path="/agency/campaigns/c-1/settings" element={<CampaignSettings />} />
          <Route path="/agency/campaigns/c-1/overview" element={<CampaignTab tab="overview" />} />
          <Route path="/agency/campaigns/c-1/health" element={<CampaignTab tab="health" />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </PageCrumbsProvider>
    </MemoryRouter>,
  );
}

const back = () => screen.queryByTestId('console-back');

afterEach(() => cleanup());

describe('the phone’s back arrow', () => {
  it('goes to the crumb above the page, named for a screen reader', () => {
    renderAt('/agency/reports/run-1', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Exports');
    expect(back()!.getAttribute('href')).toBe('/agency/reports');
    fireEvent.click(back()!);
    expect(screen.getByTestId('where').textContent).toBe('/agency/reports');
  });

  it('goes to the campaign a page names in its crumbs', () => {
    renderAt('/agency/campaigns/c-1/settings', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Diwali renewals');
    expect(back()!.getAttribute('href')).toBe('/agency/campaigns/c-1/overview');
  });

  it('goes from a tab to its section’s first page, and from an inbound route to the routes', () => {
    renderAt('/agency/inbound/summary', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Inbound');
    cleanup();
    renderAt('/settings/inbound/r-1', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Inbound routing');
  });

  it('goes from a campaign’s Overview up to the Campaigns list, never to the Overview it is on', () => {
    renderAt('/agency/campaigns/c-1/overview', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Campaigns');
    expect(back()!.getAttribute('href')).toBe('/agency/campaigns');
  });

  it('goes from another campaign tab to the campaign', () => {
    renderAt('/agency/campaigns/c-1/health', true);
    expect(back()!.getAttribute('aria-label')).toBe('Back to Diwali renewals');
    expect(back()!.getAttribute('href')).toBe('/agency/campaigns/c-1');
  });

  it('is not there on Analytics, the first page of Reports, whose crumb is not a link either', () => {
    renderAt('/agency/analytics', true);
    expect(back()).toBeNull();
    cleanup();
    renderAt('/agency/analytics', false);
    expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull();
    expect(screen.getByTestId('console-breadcrumb').textContent).toContain('Reports');
  });

  it('leaves the campaign’s name a plain name on its Overview, on a wider screen too', () => {
    renderAt('/agency/campaigns/c-1/overview', false);
    expect(screen.queryByRole('link', { name: 'Diwali renewals' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Campaigns' }).getAttribute('href')).toBe('/agency/campaigns');
  });

  it('is not there with nothing above the page', () => {
    for (const path of ['/agency/campaigns', '/agency/inbound/missed', '/settings/team', '/agency/customers']) {
      renderAt(path, true);
      expect(back(), path).toBeNull();
      cleanup();
    }
  });

  it('is not there on a wider screen, where the whole breadcrumb shows', () => {
    renderAt('/agency/reports/run-1', false);
    expect(back()).toBeNull();
    expect(screen.getByRole('link', { name: 'Exports' }).getAttribute('href')).toBe('/agency/reports');
  });

  it('is a 44px target', () => {
    const css = readFileSync(resolve(__dirname, '../../components/layout/ConsoleTopBar.module.css'), 'utf-8');
    const rule = css.slice(css.indexOf('.back {'), css.indexOf('}', css.indexOf('.back {')));
    expect(rule).toMatch(/width: 44px;/);
    expect(rule).toMatch(/height: 44px;/);
  });
});
