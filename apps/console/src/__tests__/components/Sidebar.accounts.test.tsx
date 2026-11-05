import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Accounts entry is shown to the roles that can create accounts
 * (`account.create`: tenant admin and owner) and to nobody else. An account admin
 * runs one account; the switcher is all they need.
 */
const mocks = vi.hoisted(() => ({
  useGovernance: vi.fn(),
  useTenant: vi.fn(),
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import { Sidebar } from '../../components/layout/Sidebar';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderAs(role: string) {
  mocks.useTenant.mockReturnValue({ role });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, flags: {}, status: 'ready' as const, reload: vi.fn() });
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() });
  return render(
    <MemoryRouter initialEntries={['/app/team']}>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar Accounts entry', () => {
  it.each(['tenant_admin', 'tenant_owner'])('links %s to /app/accounts', (role) => {
    renderAs(role);
    expect(screen.getByRole('link', { name: /^Accounts$/i }).getAttribute('href')).toBe('/app/accounts');
  });

  it.each(['account_admin', 'operator', 'viewer'])('is not shown to %s', (role) => {
    renderAs(role);
    expect(screen.queryByRole('link', { name: /^Accounts$/i })).toBeNull();
  });
});
