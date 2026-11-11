import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * `AgencyArea`, the `/agency` route's element inside the console shell (decision B28): the
 * section's tab bar above a grouped page, gated per tab, and the no-account notice, whose
 * "Create an account" now opens the Accounts page in Settings.
 */

const mocks = vi.hoisted(() => ({
  tenant: {} as Record<string, unknown>,
  memberships: [] as Array<{ tenant_id: string; account_id: string | null; role: string; status: string }>,
  flags: new Set<string>(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => mocks.tenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ memberships: mocks.memberships }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flags.has(f), status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('../../api/inbound', () => ({
  getMissedInboundCount: vi.fn().mockResolvedValue({ open: 0, open_capped: false, has_rows: true }),
}));

import { AgencyArea } from '../../components/layout/AgencyArea';
import { resetMissedCallsCountForTests } from '../../hooks/useMissedCallsCount';

async function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agency" element={<AgencyArea />}>
          <Route path="*" element={<div data-testid="page">page</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const tabLabels = () => screen.queryAllByTestId(/^section-tab-/).map((t) => t.textContent);

beforeEach(() => {
  resetMissedCallsCountForTests();
  mocks.tenant = { role: 'account_admin', tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1' }], accountResolution: 'ready' };
  mocks.memberships = [];
  mocks.flags = new Set(['agency_dialer_enabled', 'agency_softphone_enabled', 'agency_reports_enabled', 'agency_inbound_enabled']);
});
afterEach(() => cleanup());

describe('the section tab bar', () => {
  it('links Campaigns and Soft-phone calls for a supervisor, marking the page it is on', async () => {
    await renderAt('/agency/softphone');
    expect(tabLabels()).toEqual(['Campaigns', 'Soft-phone calls']);
    expect(screen.getByTestId('section-tab-campaigns').getAttribute('href')).toBe('/agency/campaigns');
    expect(screen.getByTestId('section-tab-softphone').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('page')).toBeTruthy();
  });

  it('groups Missed calls with Summary, and Analytics with Reports', async () => {
    await renderAt('/agency/inbound/missed');
    expect(tabLabels()).toEqual(['Missed calls', 'Summary']);
    cleanup();
    await renderAt('/agency/reports');
    expect(tabLabels()).toEqual(['Analytics', 'Reports']);
  });

  it('shows no bar when only one tab is left, or on a page inside the section', async () => {
    mocks.tenant = { ...mocks.tenant, role: 'viewer' };
    await renderAt('/agency/campaigns');
    expect(screen.queryByTestId('section-tabs')).toBeNull();
    cleanup();
    mocks.tenant = { ...mocks.tenant, role: 'account_admin' };
    await renderAt('/agency/campaigns/c-1/overview');
    expect(screen.queryByTestId('section-tabs')).toBeNull();
    expect(screen.getByTestId('page')).toBeTruthy();
  });
});

describe('with no account', () => {
  it('links to the Accounts page in Settings for someone who can create one', async () => {
    mocks.tenant = { tenantId: 't-1', accountId: null, accounts: [], accountResolution: 'ready' };
    mocks.memberships = [{ tenant_id: 't-1', account_id: null, role: 'tenant_admin', status: 'active' }];
    await renderAt('/agency/campaigns');
    expect(screen.getByTestId('agency-create-account-link').getAttribute('href')).toBe('/settings/accounts');
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('offers no such link to someone who cannot', async () => {
    mocks.tenant = { tenantId: 't-1', accountId: null, accounts: [], accountResolution: 'ready' };
    mocks.memberships = [{ tenant_id: 't-1', account_id: null, role: 'account_admin', status: 'active' }];
    await renderAt('/agency/campaigns');
    expect(screen.queryByTestId('agency-create-account-link')).toBeNull();
    expect(screen.getByText(/no accounts yet/)).toBeTruthy();
  });

  it('says nothing while the account is still resolving', async () => {
    mocks.tenant = { tenantId: 't-1', accountId: null, accounts: [], accountResolution: 'loading' };
    await renderAt('/agency/campaigns');
    expect(screen.queryByText(/Select an account/)).toBeNull();
  });
});
