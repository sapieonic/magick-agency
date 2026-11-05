import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Accounts entry in the command palette is gated like its sidebar entry
 * (`account.create`: tenant admin and owner). Before the palette took a permission,
 * every role found it, including roles the page has nothing to offer.
 */
const mocks = vi.hoisted(() => ({ role: 'tenant_admin' as string }));

vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, flags: {}, status: 'ready' as const, reload: vi.fn() }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: () => {} }),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => ({ role: mocks.role }) }));

import { GlobalSearch } from '../../components/common/GlobalSearch';

afterEach(() => {
  cleanup();
});

function searchAs(role: string, query: string) {
  mocks.role = role;
  render(
    <MemoryRouter>
      <GlobalSearch />
    </MemoryRouter>,
  );
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  const dialog = screen.getByRole('dialog', { name: /Quick navigation/i });
  fireEvent.change(within(dialog).getByLabelText('Search pages'), { target: { value: query } });
  return dialog;
}

describe('the Accounts entry', () => {
  it.each(['tenant_admin', 'tenant_owner'])('is found by %s', (role) => {
    for (const query of ['accounts', 'new account']) {
      cleanup();
      const dialog = searchAs(role, query);
      expect(within(dialog).getByText('Accounts'), query).toBeTruthy();
    }
  });

  it.each(['account_admin', 'operator', 'viewer'])('is not offered to %s', (role) => {
    const dialog = searchAs(role, 'accounts');
    expect(within(dialog).queryByText('Accounts')).toBeNull();
  });

  it('leaves ungated entries alone: Team is still found by a viewer', () => {
    const dialog = searchAs('viewer', 'team');
    expect(within(dialog).getByText('Team')).toBeTruthy();
  });
});
