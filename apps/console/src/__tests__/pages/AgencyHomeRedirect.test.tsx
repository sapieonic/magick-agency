import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * Where `/agency` goes.
 *
 * The defect this closes: the index used to be a fixed
 * `<Navigate to="/agency/campaigns">`, and that list floors at
 * `agency.campaigns.read` (`viewer`, 10). An `agent` is level 5, so the one
 * role the dialer was built for opened the dialer's own workspace and got a
 * permission error.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn() }));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));

import { AgencyHomeRedirect } from '../../pages/agency/AgencyHomeRedirect';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function renderIndex() {
  return render(
    <MemoryRouter initialEntries={['/agency']}>
      <Routes>
        <Route path="/agency" element={<AgencyHomeRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'account_admin' });
});

afterEach(() => cleanup());

describe('AgencyHomeRedirect', () => {
  it.each(['account_admin', 'tenant_admin', 'tenant_owner'] as const)(
    'sends %s to the campaign list — setting campaigns up is the job',
    async (role) => {
      mocks.useTenant.mockReturnValue({ role });

      renderIndex();

      await waitFor(() =>
        expect(screen.getByTestId('where').textContent).toBe('/agency/campaigns'),
      );
    },
  );

  it.each(['agent', 'operator', 'viewer'] as const)(
    'sends %s to /dialer rather than a list they cannot read',
    async (role) => {
      mocks.useTenant.mockReturnValue({ role });

      renderIndex();

      await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dialer'));
    },
  );

  it('waits rather than redirecting while the role is unresolved', () => {
    /**
     * `role` is `undefined` for the moment `TenantContext` takes to resolve a
     * membership. Redirecting on that would send every agent to the supervisor's
     * campaign list for one frame and then bounce them — two navigations and a
     * flash of a 403.
     */
    mocks.useTenant.mockReturnValue({ role: undefined });

    renderIndex();

    expect(screen.queryByTestId('where')).toBeNull();
  });
});
