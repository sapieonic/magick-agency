import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SuperAdminTenant, SuperAdminUser } from '@magick-agency/contracts/api/platform/super-admin';

const mocks = vi.hoisted(() => ({
  listAllUsers: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock('../../api/super-admin', () => ({
  listAllUsers: mocks.listAllUsers,
  listTenants: mocks.listTenants,
}));

import SAUsersPage from '../../pages/super-admin/SAUsersPage';

function tenant(id: string, name: string, slug: string): SuperAdminTenant {
  return {
    id, name, slug,
    status: 'active',
    settings: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    member_count: 1,
  };
}

function user(
  id: string,
  email: string,
  memberships: SuperAdminUser['memberships'],
): SuperAdminUser {
  return {
    id,
    email,
    phone_number: '0000000000',
    display_name: null,
    avatar_url: null,
    status: 'active',
    firebase_uid: `fb-${id}`,
    is_pending: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    memberships,
  };
}

const TENANTS = [
  tenant('t-1', 'Pacific Trading', 'pacific-trading'),
  tenant('t-2', 'Acme Corporation', 'acme-corp'),
  tenant('t-3', 'Globex', 'globex'),
];

const USERS = [
  user('u-1', 'alice@pacific.com', [{ tenant_id: 't-1', tenant_name: 'Pacific Trading', role: 'tenant_owner', membership_status: 'active' }]),
  user('u-2', 'bob@acme.com', [{ tenant_id: 't-2', tenant_name: 'Acme Corporation', role: 'operator', membership_status: 'active' }]),
  user('u-3', 'carol@nowhere.com', []),
  user('u-4', 'dana@multi.com', [
    { tenant_id: 't-1', tenant_name: 'Pacific Trading', role: 'operator', membership_status: 'active' },
    { tenant_id: 't-3', tenant_name: 'Globex', role: 'viewer', membership_status: 'active' },
  ]),
];

function renderPage(initialPath = '/super-admin/users') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SAUsersPage />
    </MemoryRouter>,
  );
}

describe('SAUsersPage tenant filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAllUsers.mockResolvedValue({ users: USERS });
    mocks.listTenants.mockResolvedValue({ tenants: TENANTS });
  });
  afterEach(() => { cleanup(); });

  it('offers a searchable tenant field alongside the text search', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');
    const comboboxes = screen.getAllByRole('combobox');
    expect(comboboxes).toHaveLength(1);

    fireEvent.focus(comboboxes[0]!);
    fireEvent.change(comboboxes[0]!, { target: { value: 'glob' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Globex');
  });

  it('filters the user list down to members of the selected tenant', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');

    const tenantInput = screen.getByRole('combobox');
    fireEvent.focus(tenantInput);
    fireEvent.change(tenantInput, { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('option', { name: /Acme Corporation/ }));

    await waitFor(() => {
      expect(screen.queryByText('alice@pacific.com')).toBeNull();
    });
    expect(screen.getByText('bob@acme.com')).toBeTruthy();
    expect(screen.queryByText('carol@nowhere.com')).toBeNull();
  });

  it('combines the tenant filter with the text search', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');

    const tenantInput = screen.getByRole('combobox');
    fireEvent.focus(tenantInput);
    fireEvent.change(tenantInput, { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('option', { name: /Acme Corporation/ }));
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'carol' } });
    await waitFor(() => {
      expect(screen.getByText('No users found')).toBeTruthy();
    });
  });

  it('hydrates the tenant filter from a ?tenant= deep link', async () => {
    renderPage('/super-admin/users?tenant=t-1');
    await waitFor(() => {
      expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('Pacific Trading');
    });
    expect(screen.getByText('alice@pacific.com')).toBeTruthy();
    expect(screen.queryByText('bob@acme.com')).toBeNull();
  });

  it('clearing the tenant filter restores the full list', async () => {
    renderPage('/super-admin/users?tenant=t-2');
    await waitFor(() => expect(screen.getByText('bob@acme.com')).toBeTruthy());
    expect(screen.queryByText('alice@pacific.com')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear tenant filter' }));
    await waitFor(() => {
      expect(screen.getByText('alice@pacific.com')).toBeTruthy();
    });
    expect(screen.getByText('carol@nowhere.com')).toBeTruthy();
    expect(screen.getByText('dana@multi.com')).toBeTruthy();
  });

  it('shows a user under either of their tenants when they belong to more than one', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');

    const tenantInput = screen.getByRole('combobox');
    fireEvent.focus(tenantInput);
    fireEvent.change(tenantInput, { target: { value: 'pacific' } });
    fireEvent.click(screen.getByRole('option', { name: /Pacific Trading/ }));
    await waitFor(() => expect(screen.getByText('dana@multi.com')).toBeTruthy());
    expect(screen.getByText('alice@pacific.com')).toBeTruthy();
    expect(screen.queryByText('bob@acme.com')).toBeNull();

    fireEvent.focus(tenantInput);
    fireEvent.change(tenantInput, { target: { value: 'globex' } });
    fireEvent.click(screen.getByRole('option', { name: /Globex/ }));
    await waitFor(() => {
      expect(screen.queryByText('alice@pacific.com')).toBeNull();
    });
    expect(screen.getByText('dana@multi.com')).toBeTruthy();
  });

  it('keeps the text search applied after the tenant filter is cleared on its own', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');

    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: 'dana' } });
    await waitFor(() => expect(screen.queryByText('alice@pacific.com')).toBeNull());
    expect(screen.getByText('dana@multi.com')).toBeTruthy();

    const tenantInput = screen.getByRole('combobox');
    fireEvent.focus(tenantInput);
    fireEvent.change(tenantInput, { target: { value: 'pacific' } });
    fireEvent.click(screen.getByRole('option', { name: /Pacific Trading/ }));
    await waitFor(() => expect(screen.getByText('dana@multi.com')).toBeTruthy());

    // Clearing only the tenant filter should leave the "dana" text search in force.
    fireEvent.click(screen.getByRole('button', { name: 'Clear tenant filter' }));
    await waitFor(() => {
      expect(screen.getByText('dana@multi.com')).toBeTruthy();
    });
    expect(screen.queryByText('alice@pacific.com')).toBeNull();
    expect(screen.queryByText('bob@acme.com')).toBeNull();
    expect((screen.getByLabelText('Search users') as HTMLInputElement).value).toBe('dana');
  });

  it('shows the tenant picker as loading and disabled until tenants resolve', async () => {
    let resolveTenants: (value: { tenants: SuperAdminTenant[] }) => void = () => {};
    mocks.listTenants.mockReturnValue(new Promise((resolve) => { resolveTenants = resolve; }));

    renderPage();
    await screen.findByText('alice@pacific.com');

    const tenantInput = screen.getByRole('combobox') as HTMLInputElement;
    expect(tenantInput.placeholder).toBe('Loading tenants…');
    expect(tenantInput.disabled).toBe(true);

    resolveTenants({ tenants: TENANTS });
    await waitFor(() => expect(tenantInput.disabled).toBe(false));
    expect(tenantInput.placeholder).toBe('Filter by tenant…');
  });

  it('gives the tenant filter an accessible name since it has no visible <label>', async () => {
    renderPage();
    await screen.findByText('alice@pacific.com');
    expect(screen.getByRole('combobox', { name: 'Filter by tenant' })).toBeTruthy();
  });
});
