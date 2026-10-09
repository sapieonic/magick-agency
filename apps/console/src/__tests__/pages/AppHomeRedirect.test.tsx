import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * `/app`'s index. It lands the platform zone on a real page, and — the property
 * that matters most — never redirects into `/agency`, which would bounce the
 * workspace's own exit straight back in.
 */
const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useGovernance: vi.fn(),
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));

import { AppHomeRedirect } from '../../pages/AppHomeRedirect';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderIndex() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<AppHomeRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const landsOn = () => screen.queryByTestId('where')?.textContent ?? null;

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ role: 'tenant_admin', accountResolution: 'ready' });
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: false });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'ready' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppHomeRedirect', () => {
  it('sends someone who can manage the team to Team', () => {
    renderIndex();
    expect(landsOn()).toBe('/app/team');
  });

  it('sends everyone else to Notifications, the page every role has', () => {
    mocks.useTenant.mockReturnValue({ role: 'viewer', accountResolution: 'ready' });
    renderIndex();
    expect(landsOn()).toBe('/app/notifications');
  });

  it('never redirects into /agency, even with the dialer on — that would bounce the workspace exit', () => {
    for (const role of ['tenant_owner', 'account_admin', 'operator', 'viewer'] as const) {
      cleanup();
      mocks.useTenant.mockReturnValue({ role, accountResolution: 'ready' });
      renderIndex();
      expect(landsOn()?.startsWith('/agency')).toBe(false);
    }
  });

  it('tells a dedicated agent the dialer is off, rather than an empty platform page', () => {
    mocks.useTenant.mockReturnValue({ role: 'agent', accountResolution: 'ready' });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'ready' });
    renderIndex();
    expect(screen.getByText(/The dialer isn’t switched on yet/)).toBeTruthy();
    expect(landsOn()).toBeNull();
  });

  it('waits rather than deciding while the role is unresolved', () => {
    mocks.useTenant.mockReturnValue({ role: undefined, accountResolution: 'loading' });
    renderIndex();
    expect(landsOn()).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('waits for an agent’s gates before choosing the notice', () => {
    mocks.useTenant.mockReturnValue({ role: 'agent', accountResolution: 'ready' });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'loading' });
    renderIndex();
    expect(screen.queryByText(/switched on/)).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
