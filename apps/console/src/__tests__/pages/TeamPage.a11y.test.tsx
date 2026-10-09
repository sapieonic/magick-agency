import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/** TeamPage — Invite Team Member dialog accessible naming (86d3nxc9j). */
const mocks = vi.hoisted(() => ({
  useTeam: vi.fn(),
  useAccounts: vi.fn(),
  usePermission: vi.fn(),
  useTenant: vi.fn(),
  inviteUser: vi.fn(),
}));

vi.mock('../../hooks/useTeam', () => ({ useTeam: mocks.useTeam }));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: mocks.useAccounts }));
vi.mock('../../hooks/usePermission', () => ({ usePermission: mocks.usePermission }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/users', () => ({
  inviteUser: mocks.inviteUser,
  updateUserRole: vi.fn(),
  removeUserMembership: vi.fn(),
}));
vi.mock('../../analytics/events', () => ({ trackSetupEvent: vi.fn() }));

import TeamPage from '../../pages/team/TeamPage';

beforeEach(() => {
  mocks.useTeam.mockReturnValue({ members: [], loading: false, error: null, reload: vi.fn() });
  mocks.useAccounts.mockReturnValue({ accounts: [] });
  mocks.usePermission.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', role: 'tenant_admin' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('TeamPage — Invite Team Member dialog accessible naming (86d3nxc9j)', () => {
  it('names the dialog by its visible heading and gives the close button an accessible name', () => {
    render(<MemoryRouter><TeamPage /></MemoryRouter>);
    fireEvent.click(screen.getAllByText('Invite Member')[0]!);

    const dialog = screen.getByRole('dialog', { name: 'Invite Team Member' });
    const heading = screen.getByRole('heading', { name: 'Invite Team Member' });
    expect(dialog.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.id).toBeTruthy();

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn.getAttribute('aria-label')).toBe('Close');
  });
});
