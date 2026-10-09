import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  hasToken: vi.fn(),
  getSuperAdminMe: vi.fn(),
  superAdminLogin: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock('../api/super-admin', () => ({
  hasToken: mocks.hasToken,
  getSuperAdminMe: mocks.getSuperAdminMe,
  superAdminLogin: mocks.superAdminLogin,
  setToken: mocks.setToken,
  clearToken: mocks.clearToken,
  listTenants: mocks.listTenants,
  changePassword: vi.fn(),
}));

import { App } from '../App';

const ADMIN = {
  id: 'a-1', email: 'root@example.com', name: 'Root', status: 'active' as const,
  is_system: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTenants.mockResolvedValue({ tenants: [] });
});

/**
 * The routes sit at the root (`/tenants`, not `/super-admin/tenants`)
 * so the dev proxy and a static host never mistake a page load for an API call.
 */
describe('App routing', () => {
  it('sends an unauthenticated visitor to /login and shows the admin sign-in', async () => {
    mocks.hasToken.mockReturnValue(false);
    window.history.pushState({}, '', '/tenants');
    render(<App />);
    await screen.findByText('Platform Administration');
    expect(window.location.pathname).toBe('/login');
    expect(screen.getByRole('button', { name: 'Sign In as Admin' })).toBeTruthy();
  });

  it('signs in with email and password, then lands on the tenants list', async () => {
    mocks.hasToken.mockReturnValue(false);
    mocks.superAdminLogin.mockResolvedValue({ token: 'jwt', admin: { id: 'a-1', email: ADMIN.email, name: 'Root' } });
    mocks.getSuperAdminMe.mockResolvedValue({ admin: ADMIN });
    window.history.pushState({}, '', '/login');
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: ADMIN.email } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In as Admin' }));
    await waitFor(() => expect(mocks.superAdminLogin).toHaveBeenCalledWith(ADMIN.email, 'secret-pass'));
    expect(mocks.setToken).toHaveBeenCalledWith('jwt');
    await waitFor(() => expect(window.location.pathname).toBe('/tenants'));
    await screen.findByRole('heading', { name: 'Tenants' });
  });

  it('offers exactly the surfaces plan 3.4 keeps, and none of the deleted ones', async () => {
    mocks.hasToken.mockReturnValue(true);
    mocks.getSuperAdminMe.mockResolvedValue({ admin: ADMIN });
    window.history.pushState({}, '', '/');
    render(<App />);
    await screen.findByRole('heading', { name: 'Tenants' });
    const nav = screen.getAllByRole('link').map((a) => a.textContent?.trim());
    expect(nav).toEqual(['Tenants', 'Users', 'Admins', 'Phone Numbers', 'Feature Flags', 'Usage', 'Audit Log']);
  });

  it('shows the signed-in admin and unknown paths fall back to the tenants list', async () => {
    mocks.hasToken.mockReturnValue(true);
    mocks.getSuperAdminMe.mockResolvedValue({ admin: ADMIN });
    window.history.pushState({}, '', '/super-admin/providers');
    render(<App />);
    await screen.findByRole('heading', { name: 'Tenants' });
    expect(screen.getByText('Root')).toBeTruthy();
    expect(window.location.pathname).toBe('/tenants');
  });
});
