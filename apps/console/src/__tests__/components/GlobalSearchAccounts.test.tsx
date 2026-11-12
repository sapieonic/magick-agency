import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Accounts entry in the command palette is gated like its Settings entry
 * (`account.create`: tenant admin and owner). Before the palette took a permission,
 * every role found it, including roles the page has nothing to offer.
 *
 * Since B28's search the palette reads the Settings hub's own gates (`SETTINGS_ENTRIES`), so
 * Team follows its hub entry too (`user.invite`): a viewer no longer finds a page the hub does
 * not offer them.
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
      <GlobalSearch open onOpenChange={() => {}} />
    </MemoryRouter>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Search' });
  fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: query } });
  return dialog;
}

const option = (dialog: HTMLElement, name: string) => within(dialog).queryByRole('option', { name: new RegExp(`^${name}`) });

describe('the Accounts entry', () => {
  it.each(['tenant_admin', 'tenant_owner'])('is found by %s', (role) => {
    for (const query of ['accounts', 'new account']) {
      cleanup();
      const dialog = searchAs(role, query);
      expect(option(dialog, 'Accounts'), query).not.toBeNull();
    }
  });

  it.each(['account_admin', 'operator', 'viewer'])('is not offered to %s', (role) => {
    const dialog = searchAs(role, 'accounts');
    expect(option(dialog, 'Accounts')).toBeNull();
  });
});

describe('the Team entry', () => {
  it('is found by a role that can invite', () => {
    const dialog = searchAs('account_admin', 'invite');
    expect(option(dialog, 'Team')).not.toBeNull();
  });

  it('is not offered to a viewer, whom the Settings hub does not offer it either', () => {
    const dialog = searchAs('viewer', 'team');
    expect(option(dialog, 'Team')).toBeNull();
  });
});
