import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { telephonyProviderAlias } from '../../config/telephonyProviders';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAccounts: vi.fn(),
  getPhones: vi.fn(),
  getCatalog: vi.fn(),
  resolve: vi.fn(),
  getAccountConcurrency: vi.fn(),
  listProviders: vi.fn(),
  updateProviderConcurrency: vi.fn(),
  getAccountSettings: vi.fn(),
}));

vi.mock('../../hooks/useSuperAdminTenant', () => ({ useSuperAdminTenant: mocks.useTenant }));

vi.mock('../../api/super-admin', () => ({
  getTenantAccounts: mocks.getAccounts,
  getTenantPhoneNumbers: mocks.getPhones,
  getFeatureFlagCatalog: mocks.getCatalog,
  resolveFeatureFlags: mocks.resolve,
  // Referenced by handlers but not invoked on mount — stubs keep the import graph happy.
  addUserToTenant: vi.fn(), assignPhoneNumber: vi.fn(),
  unassignPhoneNumber: vi.fn(), listPhoneNumbers: vi.fn(), updateAccountConcurrency: vi.fn(),
  getAccountConcurrency: mocks.getAccountConcurrency,
  listTelephonyProviders: mocks.listProviders,
  updateProviderConcurrency: mocks.updateProviderConcurrency,
  getAccountSettings: mocks.getAccountSettings,
  updateAccountSettings: vi.fn(), changeMembershipRole: vi.fn(), revokeMembership: vi.fn(),
  putFeatureFlagOverride: vi.fn(), deleteFeatureFlagOverride: vi.fn(),
}));

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));

import SATenantDetailPage from '../../pages/super-admin/SATenantDetailPage';

function renderPage(entry = '/tenants/t-1') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/tenants/:id" element={<SATenantDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const provider = (name: string, status: 'active' | 'inactive' = 'active') => ({
  id: `prov-${name}`, name, display_name: name, status,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    data: {
      tenant: { id: 't-1', name: 'Acme', slug: 'acme', status: 'active', settings: {} },
      members: [],
    },
    loading: false,
    error: null,
    reload: vi.fn(),
  });
  mocks.getAccounts.mockResolvedValue([]);
  mocks.getPhones.mockResolvedValue([]);
  mocks.getCatalog.mockResolvedValue({ flags: [] });
  mocks.resolve.mockResolvedValue({
    tenant_id: 't-1', account_id: null, effective: {}, source: {}, defaults: {}, overrides: [],
  });
  mocks.listProviders.mockResolvedValue([provider('vobiz'), provider('voicelink')]);
  mocks.updateProviderConcurrency.mockResolvedValue({});
  mocks.getAccountSettings.mockResolvedValue({ settings: {
    tenant_id: 't-1', account_id: 'a-1', allow_recording: false, analyze_calls: false,
    max_concurrent_calls: 5, webrtc_max_duration_seconds: 1800, updated_at: '2026-10-08T00:00:00.000Z',
  } });
});
afterEach(() => cleanup());

describe('SATenantDetailPage — tabs', () => {
  it('defaults to Overview and only mounts Feature Flags when its tab is selected', async () => {
    renderPage();
    // Tenant name now appears in both the breadcrumb and the page header,
    // so scope to the header heading to keep the query unambiguous.
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));

    // Flags content not mounted on the default tab.
    expect(screen.queryByText(/Roll capabilities out to this tenant/i)).toBeNull();
    expect(mocks.getCatalog).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: /feature flags/i }));

    await waitFor(() => expect(screen.getByText(/Roll capabilities out to this tenant/i)).toBeTruthy());
    // The flags tab resolves flags for this tenant.
    await waitFor(() => expect(mocks.resolve).toHaveBeenCalledWith('t-1', undefined));
    expect(mocks.getCatalog).toHaveBeenCalled();
  });

  it('marks the active tab aria-selected and updates it on click', async () => {
    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /members/i }).getAttribute('aria-selected')).toBe('false');

    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    expect(screen.getByRole('tab', { name: /members/i }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected')).toBe('false');
  });

  it('routes each tab to its own content', async () => {
    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));

    // Overview shows the phone numbers.
    expect(screen.getByRole('heading', { name: /^phone numbers/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    expect(screen.getByRole('heading', { name: /account settings/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /account concurrency/i })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /members/i }));
    // Anchor to the section heading ("Members (N)") — the empty-state heading
    // ("No members…") also contains the word "members".
    expect(screen.getByRole('heading', { name: /^members/i })).toBeTruthy();
    // Leaving overview unmounts the phone numbers.
    expect(screen.queryByRole('heading', { name: /^phone numbers/i })).toBeNull();
  });

  it('deep-links straight to the Feature Flags tab from the URL', async () => {
    renderPage('/tenants/t-1?tab=flags');
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    expect(screen.getByRole('tab', { name: /feature flags/i }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(screen.getByText(/Roll capabilities out to this tenant/i)).toBeTruthy());
  });

  it('falls back to Overview for an unknown ?tab value', async () => {
    renderPage('/tenants/t-1?tab=bogus');
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('SATenantDetailPage — provider concurrency', () => {
  it('loads, displays, and saves a versioned provider allocation', async () => {
    mocks.getAccounts.mockResolvedValue([{
      id: 'a-1', name: 'Sales', slug: 'sales', status: 'active',
      max_concurrent_calls: 50,
      concurrency: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'provider_breakdown',
        version: 3, total_concurrency: 50,
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
      },
    }]);
    mocks.getAccountConcurrency.mockResolvedValue({
      allocation: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'provider_breakdown',
        version: 3, total_concurrency: 50,
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
      },
      utilization: {
        status: 'available', observed_at: '2026-08-08T00:00:00.000Z',
        mode: 'provider_breakdown', version: 3,
        total: { allocated: 50, in_use: 12, available: 38 },
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 30, allocated: 30, in_use: 10, available: 20, saturated: false },
          { provider: 'voicelink', max_concurrent_calls: 20, allocated: 20, in_use: 2, available: 18, saturated: false },
        ],
      },
    });

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getByRole('button', { name: /manage providers/i }));

    await waitFor(() => expect(screen.getByText(/Total user concurrency/i)).toBeTruthy());
    expect((screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('vobiz')}`) as HTMLInputElement).value).toBe('30');
    expect((screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('voicelink')}`) as HTMLInputElement).value).toBe('20');
    fireEvent.change(screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('vobiz')}`), {
      target: { value: '35' },
    });
    fireEvent.change(screen.getByLabelText('Change reason'), {
      target: { value: 'Purchased additional VoBiz capacity' },
    });
    fireEvent.click(screen.getByLabelText(/I reviewed active usage/i));
    fireEvent.click(screen.getByRole('button', { name: /save provider allocation/i }));

    await waitFor(() => expect(mocks.updateProviderConcurrency).toHaveBeenCalledWith(
      't-1',
      'a-1',
      {
        mode: 'provider_breakdown',
        version: 3,
        providers: [
          { provider: 'vobiz', max_concurrent_calls: 35 },
          { provider: 'voicelink', max_concurrent_calls: 20 },
        ],
        change_reason: 'Purchased additional VoBiz capacity',
      },
    ));
  });

  it('ignores an older account response after the operator opens another account', async () => {
    mocks.getAccounts.mockResolvedValue([
      { id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 30 },
      { id: 'a-2', name: 'Support', slug: 'support', status: 'active', max_concurrent_calls: 7 },
    ]);
    let resolveSales!: (value: unknown) => void;
    let resolveSupport!: (value: unknown) => void;
    const sales = new Promise(resolve => { resolveSales = resolve; });
    const support = new Promise(resolve => { resolveSupport = resolve; });
    mocks.getAccountConcurrency.mockImplementation((_tenantId: string, accountId: string) => (
      accountId === 'a-1' ? sales : support
    ));
    const detail = (accountId: string, allocated: number) => ({
      allocation: {
        tenant_id: 't-1', account_id: accountId, mode: 'provider_breakdown',
        version: 1, total_concurrency: allocated,
        providers: [{ provider: 'vobiz', max_concurrent_calls: allocated }],
      },
      utilization: {
        status: 'available', observed_at: '2026-08-08T00:00:00.000Z',
        mode: 'provider_breakdown', version: 1,
        total: { allocated, in_use: 0, available: allocated },
        providers: [{ provider: 'vobiz', allocated, max_concurrent_calls: allocated, in_use: 0, available: allocated, saturated: false }],
      },
    });

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getAllByRole('button', { name: /manage providers/i })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getAllByRole('button', { name: /manage providers/i })[1]!);

    resolveSupport(detail('a-2', 7));
    await waitFor(() => expect((
      screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('vobiz')}`) as HTMLInputElement
    ).value).toBe('7'));
    resolveSales(detail('a-1', 30));
    await Promise.resolve();

    expect((screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('vobiz')}`) as HTMLInputElement).value).toBe('7');
  });

  it('renders unavailable provider utilization as unknown, never zero', async () => {
    mocks.listProviders.mockResolvedValue([provider('vobiz')]);
    mocks.getAccounts.mockResolvedValue([{
      id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 30,
    }]);
    mocks.getAccountConcurrency.mockResolvedValue({
      allocation: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'provider_breakdown',
        version: 2, total_concurrency: 30,
        providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
      },
      utilization: {
        status: 'unavailable', observed_at: '2026-08-08T00:00:00.000Z',
        mode: 'provider_breakdown', version: 2,
        total: { allocated: 30, in_use: null, available: null },
        providers: [{
          provider: 'vobiz', allocated: 30, max_concurrent_calls: 30,
          in_use: null, available: null, over_limit: null, saturated: null, draining: false,
        }],
      },
    });

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getByRole('button', { name: /manage providers/i }));

    await waitFor(() => expect(screen.getByText(/Live utilization is unavailable/i)).toBeTruthy());
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
  });

  it('re-fetches on a structured 409 without depending on error text', async () => {
    mocks.getAccounts.mockResolvedValue([{
      id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 30,
    }]);
    const detail = {
      allocation: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'provider_breakdown',
        version: 2, total_concurrency: 30,
        providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
      },
      utilization: null,
    };
    mocks.getAccountConcurrency.mockResolvedValue(detail);
    mocks.updateProviderConcurrency.mockRejectedValue(Object.assign(
      new Error('Allocation changed elsewhere'),
      { statusCode: 409, details: { error: 'Version mismatch' } },
    ));

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getByRole('button', { name: /manage providers/i }));
    await waitFor(() => screen.getByLabelText('Change reason'));
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'Updated purchase' } });
    fireEvent.click(screen.getByLabelText(/I reviewed active usage/i));
    fireEvent.click(screen.getByRole('button', { name: /save provider allocation/i }));

    await waitFor(() => expect(mocks.getAccountConcurrency).toHaveBeenCalledTimes(2));
  });

  it('requires renewed impact confirmation and sends an explicit force migration after an active-call conflict', async () => {
    mocks.listProviders.mockResolvedValue([provider('voicelink')]);
    mocks.getAccounts.mockResolvedValue([{
      id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 5,
    }]);
    mocks.getAccountConcurrency.mockResolvedValue({
      allocation: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'legacy_total',
        version: 1, total_concurrency: 5, providers: [],
      },
      utilization: null,
    });
    mocks.updateProviderConcurrency
      .mockRejectedValueOnce(Object.assign(new Error('Active calls prevent migration'), {
        statusCode: 409,
        details: { error: 'Active Calls', active_calls: 3 },
      }))
      .mockResolvedValueOnce({});

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getByRole('button', { name: /manage providers/i }));
    await waitFor(() => screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('voicelink')}`));
    fireEvent.change(screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias('voicelink')}`), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Change reason'), { target: { value: 'Purchased capacity' } });
    const confirmation = screen.getByLabelText(/I reviewed active usage/i);
    fireEvent.click(confirmation);
    fireEvent.click(screen.getByRole('button', { name: /save provider allocation/i }));

    const forceButton = await screen.findByRole('button', { name: /force migration with active calls/i });
    expect((forceButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirmation);
    expect((forceButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmation);
    fireEvent.click(forceButton);

    await waitFor(() => expect(mocks.updateProviderConcurrency).toHaveBeenLastCalledWith(
      't-1',
      'a-1',
      {
        mode: 'provider_breakdown',
        version: 1,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 30 }],
        change_reason: 'Purchased capacity',
        force_migration: true,
      },
    ));
  });
  /*
   * PORT NOTE (magick-agency): cusui got the catalog inside the concurrency detail;
   * here it comes from `GET /telephony-providers`. Same seeding: active providers at 0,
   * the allocation's own rows laid over them, inactive providers only when allocated.
   */
  it('seeds a row per ACTIVE provider at 0 and overlays the allocation, keeping an allocated inactive provider', async () => {
    mocks.listProviders.mockResolvedValue([
      provider('voicelink'), provider('vobiz'), provider('old-carrier', 'inactive'), provider('spare-inactive', 'inactive'),
    ]);
    mocks.getAccounts.mockResolvedValue([{
      id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 7,
    }]);
    mocks.getAccountConcurrency.mockResolvedValue({
      // The snapshot switchToLegacy keeps: a legacy account that still carries rows.
      allocation: {
        tenant_id: 't-1', account_id: 'a-1', mode: 'legacy_total', version: 4, total_concurrency: 7,
        providers: [{ provider: 'old-carrier', max_concurrent_calls: 7 }],
      },
      utilization: null,
    });

    renderPage();
    await waitFor(() => screen.getByRole('heading', { name: 'Acme' }));
    fireEvent.click(screen.getByRole('tab', { name: /service/i }));
    await screen.findByRole('cell', { name: 'Sales' });
    fireEvent.click(screen.getByRole('button', { name: /manage providers/i }));

    const input = (name: string) => screen.getByLabelText(`Concurrency allocated to ${telephonyProviderAlias(name, name)}`) as HTMLInputElement;
    await waitFor(() => input('voicelink'));
    expect(input('voicelink').value).toBe('0');
    expect(input('vobiz').value).toBe('0');
    expect(input('old-carrier').value).toBe('7');
    expect(screen.queryByLabelText(`Concurrency allocated to ${telephonyProviderAlias('spare-inactive', 'spare-inactive')}`)).toBeNull();
    expect(mocks.listProviders).toHaveBeenCalled();
  });
});

