import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * NEW in magick-agency (no cusui source): the per-account settings panel
 * (plan §3.2), role change and revoke (plan §3.4), and the account-scoped
 * add-user form.
 */
const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  reload: vi.fn(),
  getAccounts: vi.fn(),
  getAccountSettings: vi.fn(),
  updateAccountSettings: vi.fn(),
  addUserToTenant: vi.fn(),
  changeMembershipRole: vi.fn(),
  revokeMembership: vi.fn(),
}));

vi.mock('../../hooks/useSuperAdminTenant', () => ({ useSuperAdminTenant: mocks.useTenant }));
vi.mock('../../api/super-admin', () => ({
  getTenantAccounts: mocks.getAccounts,
  getTenantPhoneNumbers: vi.fn().mockResolvedValue([]),
  getFeatureFlagCatalog: vi.fn().mockResolvedValue({ flags: [] }),
  resolveFeatureFlags: vi.fn(),
  addUserToTenant: mocks.addUserToTenant,
  assignPhoneNumber: vi.fn(), unassignPhoneNumber: vi.fn(), listPhoneNumbers: vi.fn(),
  updateAccountConcurrency: vi.fn(), getAccountConcurrency: vi.fn(), listTelephonyProviders: vi.fn().mockResolvedValue([]), updateProviderConcurrency: vi.fn(),
  getAccountSettings: mocks.getAccountSettings,
  updateAccountSettings: mocks.updateAccountSettings,
  changeMembershipRole: mocks.changeMembershipRole,
  revokeMembership: mocks.revokeMembership,
  putFeatureFlagOverride: vi.fn(), deleteFeatureFlagOverride: vi.fn(),
}));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));

import SATenantDetailPage from '../../pages/super-admin/SATenantDetailPage';

const SETTINGS = {
  tenant_id: 't-1', account_id: 'a-1', allow_recording: false, analyze_calls: false,
  max_concurrent_calls: 5, webrtc_max_duration_seconds: 1800, updated_at: '2026-10-08T00:00:00.000Z',
};

const MEMBER = {
  id: 'm-1', user_id: 'u-1', tenant_id: 't-1', role: 'operator', status: 'active',
  email: 'op@acme.com', phone_number: '0000000000', display_name: 'Op', avatar_url: null,
  user_status: 'active', created_at: '2026-10-01T00:00:00.000Z',
};

function renderPage(entry: string) {
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
  mocks.reload.mockResolvedValue(undefined);
  mocks.useTenant.mockReturnValue({
    data: {
      tenant: { id: 't-1', name: 'Acme', slug: 'acme', status: 'active', settings: {} },
      members: [MEMBER],
    },
    loading: false, error: null, refreshError: null, reload: mocks.reload,
  });
  mocks.getAccounts.mockResolvedValue([
    { id: 'a-1', name: 'Sales', slug: 'sales', status: 'active', max_concurrent_calls: 5 },
    { id: 'a-2', name: 'Support', slug: 'support', status: 'active', max_concurrent_calls: 7 },
  ]);
  mocks.getAccountSettings.mockResolvedValue({ settings: SETTINGS });
  mocks.updateAccountSettings.mockResolvedValue({ settings: { ...SETTINGS, allow_recording: true } });
});
afterEach(() => cleanup());

async function openSettings() {
  renderPage('/tenants/t-1?tab=service');
  await screen.findByLabelText('Max call duration (seconds)');
  await waitFor(() => expect(mocks.getAccountSettings).toHaveBeenCalledWith('t-1', 'a-1'));
}

describe('SATenantDetailPage — account settings', () => {
  it('loads the effective settings and shows the concurrency limit read-only', async () => {
    await openSettings();
    expect((screen.getByLabelText('Max call duration (seconds)') as HTMLInputElement).value).toBe('1800');
    const limit = screen.getByLabelText('Max concurrent calls') as HTMLInputElement;
    expect(limit.value).toBe('5');
    expect(limit.readOnly).toBe(true);
  });

  it('sends only the fields that changed', async () => {
    await openSettings();
    fireEvent.click(screen.getByLabelText('Allow recording'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledWith('t-1', 'a-1', { allow_recording: true }));
    await screen.findByText('Account settings saved.');
  });

  it('adds the reason, trimmed, and the new duration', async () => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Max call duration (seconds)'), { target: { value: '3600' } });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: '  pilot  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledWith('t-1', 'a-1', {
      webrtc_max_duration_seconds: 3600, reason: 'pilot',
    }));
  });

  it('keeps Save disabled until something changes', async () => {
    await openSettings();
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each(['59', '14401', '60.5', 'abc', '1e3', ''])('refuses a max call duration of %j without calling the API', async (value) => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Max call duration (seconds)'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText(/between 60 and 14400/);
    expect(mocks.updateAccountSettings).not.toHaveBeenCalled();
  });

  it.each(['60', '14400'])('accepts the boundary value %s', async (value) => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Max call duration (seconds)'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(mocks.updateAccountSettings).toHaveBeenCalledWith('t-1', 'a-1', {
      webrtc_max_duration_seconds: Number(value),
    }));
  });

  it('surfaces a server refusal', async () => {
    mocks.updateAccountSettings.mockRejectedValue(new Error('Account not found'));
    await openSettings();
    fireEvent.click(screen.getByLabelText('Analyze calls'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Account not found');
  });

  it('loads the settings of whichever account is picked', async () => {
    await openSettings();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'a-2' } });
    await waitFor(() => expect(mocks.getAccountSettings).toHaveBeenCalledWith('t-1', 'a-2'));
  });
});

describe('SATenantDetailPage — members', () => {
  it('adds a user to the whole tenant when no account is picked', async () => {
    mocks.addUserToTenant.mockResolvedValue({});
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: /add user/i }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@acme.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
    await waitFor(() => expect(mocks.addUserToTenant).toHaveBeenCalledWith('t-1', {
      email: 'new@acme.com', role: 'operator', name: undefined,
    }));
  });

  it('adds a user to one account, and offers the agent role', async () => {
    mocks.addUserToTenant.mockResolvedValue({});
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: /add user/i }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Support' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Agent' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ag@acme.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'agent' } });
    fireEvent.change(screen.getByLabelText('Account (optional)'), { target: { value: 'a-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
    await waitFor(() => expect(mocks.addUserToTenant).toHaveBeenCalledWith('t-1', {
      email: 'ag@acme.com', role: 'agent', name: undefined, account_id: 'a-2',
    }));
  });

  it('changes a role by membership id, with the reason, then refetches silently', async () => {
    mocks.changeMembershipRole.mockResolvedValue({ membership: {} });
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Change role for op@acme.com' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'viewer' } });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'moved teams' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(mocks.changeMembershipRole).toHaveBeenCalledWith('t-1', 'm-1', {
      role: 'viewer', reason: 'moved teams',
    }));
    await screen.findByText('op@acme.com is now Viewer.');
    expect(mocks.reload).toHaveBeenCalledWith({ silent: true });
  });

  it('shows a role-change refusal in the dialog and does not claim success', async () => {
    mocks.changeMembershipRole.mockRejectedValue(new Error('Cannot demote the last owner'));
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Change role for op@acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await screen.findByText('Cannot demote the last owner');
    expect(screen.queryByText(/is now/)).toBeNull();
  });

  it('revokes only after confirmation and reports the closed assignments', async () => {
    mocks.revokeMembership.mockResolvedValue({ membership: {}, staffing_closed: 2 });
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke op@acme.com' }));
    expect(mocks.revokeMembership).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(mocks.revokeMembership).toHaveBeenCalledWith('t-1', 'm-1'));
    await screen.findByText('Revoked op@acme.com. 2 campaign assignments closed.');
    expect(mocks.reload).toHaveBeenCalledWith({ silent: true });
  });

  it('says "assignment" for exactly one', async () => {
    mocks.revokeMembership.mockResolvedValue({ membership: {}, staffing_closed: 1 });
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke op@acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await screen.findByText('Revoked op@acme.com. 1 campaign assignment closed.');
  });

  it('reports a failed revoke as an alert, not a success note', async () => {
    mocks.revokeMembership.mockRejectedValue(new Error('Cannot revoke the last owner'));
    renderPage('/tenants/t-1?tab=members');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke op@acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Cannot revoke the last owner'));
    expect(screen.queryByText(/Revoked op@acme.com/)).toBeNull();
  });
});
