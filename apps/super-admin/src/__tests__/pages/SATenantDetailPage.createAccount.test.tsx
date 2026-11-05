import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * "New account" on the tenant detail page (`POST /super-admin/tenants/:id/accounts`):
 * offered from every tab, refuses a blank name, reloads the tenant's accounts on
 * success, and keeps the modal open with the server's sentence on a refusal.
 */
const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAccounts: vi.fn(),
  createTenantAccount: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../hooks/useSuperAdminTenant', () => ({ useSuperAdminTenant: mocks.useTenant }));
vi.mock('../../api/super-admin', () => ({
  getTenantAccounts: mocks.getAccounts,
  createTenantAccount: mocks.createTenantAccount,
  getTenantPhoneNumbers: vi.fn().mockResolvedValue([]),
  getFeatureFlagCatalog: vi.fn().mockResolvedValue({ flags: [] }),
  resolveFeatureFlags: vi.fn(),
  addUserToTenant: vi.fn(),
  assignPhoneNumber: vi.fn(), unassignPhoneNumber: vi.fn(), listPhoneNumbers: vi.fn(),
  updateAccountConcurrency: vi.fn(), getAccountConcurrency: vi.fn(), listTelephonyProviders: vi.fn().mockResolvedValue([]), updateProviderConcurrency: vi.fn(),
  getAccountSettings: vi.fn().mockResolvedValue({ settings: null }), updateAccountSettings: vi.fn(),
  changeMembershipRole: vi.fn(), revokeMembership: vi.fn(),
  putFeatureFlagOverride: vi.fn(), deleteFeatureFlagOverride: vi.fn(),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    data: { tenant: { id: 't-1', name: 'Acme', slug: 'acme', status: 'active', settings: {} }, members: [] },
    loading: false, error: null, refreshError: null, reload: vi.fn(),
  });
  mocks.getAccounts.mockResolvedValue([
    { id: 'a-1', name: 'Default', slug: 'default', status: 'active', max_concurrent_calls: 5 },
  ]);
});
afterEach(() => cleanup());

async function openModal() {
  fireEvent.click(screen.getByRole('button', { name: /New account/i }));
  return screen.findByRole('dialog');
}

describe('SATenantDetailPage — New account', () => {
  it.each(['overview', 'service', 'flags', 'members'])('is offered on the %s tab', (tab) => {
    renderPage(`/tenants/t-1?tab=${tab}`);
    expect(screen.getByRole('button', { name: /New account/i })).toBeTruthy();
  });

  it('cannot submit a blank name', async () => {
    renderPage();
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: '  ' } });
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates the account with the trimmed name and reloads the accounts', async () => {
    mocks.createTenantAccount.mockResolvedValue({ id: 'a-2', name: 'Outbound', slug: 'outbound' });
    renderPage();
    await waitFor(() => expect(mocks.getAccounts).toHaveBeenCalledTimes(1));
    const dialog = await openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: ' Outbound ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Account "Outbound" created', 'success'));
    expect(mocks.createTenantAccount).toHaveBeenCalledWith('t-1', 'Outbound');
    await waitFor(() => expect(mocks.getAccounts).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a typed, unsaved concurrency total on the Service tab when an account is created', async () => {
    mocks.createTenantAccount.mockResolvedValue({ id: 'a-2', name: 'Outbound', slug: 'outbound' });
    renderPage('/tenants/t-1?tab=service');
    const input = await screen.findByLabelText('Legacy max concurrent calls for Default') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });

    mocks.getAccounts.mockResolvedValue([
      { id: 'a-1', name: 'Default', slug: 'default', status: 'active', max_concurrent_calls: 5 },
      { id: 'a-2', name: 'Outbound', slug: 'outbound', status: 'active', max_concurrent_calls: 5 },
    ]);
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'Outbound' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    const outbound = await screen.findByLabelText('Legacy max concurrent calls for Outbound') as HTMLInputElement;
    expect(outbound.value).toBe('5');
    expect((screen.getByLabelText('Legacy max concurrent calls for Default') as HTMLInputElement).value).toBe('12');
  });

  it('announces a refusal to screen readers', async () => {
    mocks.createTenantAccount.mockRejectedValue(new Error('There is already an account called "Default" in this tenant.'));
    renderPage();
    const dialog = await openModal();
    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect((await screen.findByRole('alert')).textContent).toContain('already an account');
    expect(within(dialog).getByLabelText('Account name').getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the modal open with the server\'s sentence on a refusal', async () => {
    mocks.createTenantAccount.mockRejectedValue(new Error('There is already an account called "Default" in this tenant.'));
    renderPage();
    const dialog = await openModal();

    fireEvent.change(within(dialog).getByLabelText('Account name'), { target: { value: 'default' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect((await screen.findByTestId('sa-create-account-error')).textContent).toContain('already an account called "Default"');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
