import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * `/app`'s index, the console's home decision (decision B28): `/agency` with the dialer on,
 * Settings with it off, and a dedicated agent's dialer-off notice. It never goes to `/` or
 * back to `/app`, so it cannot loop with `HomeRedirect`.
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
  it('sends anyone with the dialer on to /agency, whose index picks the page by persona', () => {
    for (const role of ['tenant_owner', 'account_admin', 'operator', 'viewer'] as const) {
      cleanup();
      mocks.useTenant.mockReturnValue({ role, accountResolution: 'ready' });
      renderIndex();
      expect(landsOn()).toBe('/agency');
    }
  });

  it('sends anyone else to Settings when the dialer is off, not into a refusal', () => {
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'ready' });
    renderIndex();
    expect(landsOn()).toBe('/settings');
    cleanup();
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'ready' });
    mocks.useGovernance.mockReturnValue({ isEnabled: (c: string) => c !== 'agency', loading: false });
    renderIndex();
    expect(landsOn()).toBe('/settings');
  });

  it('tells a dedicated agent the dialer is off, rather than an empty page', () => {
    mocks.useTenant.mockReturnValue({ role: 'agent', accountResolution: 'ready' });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'ready' });
    renderIndex();
    expect(screen.getByText(/The dialler isn’t switched on yet/)).toBeTruthy();
    expect(landsOn()).toBeNull();
  });

  it('waits rather than deciding while the role is unresolved', () => {
    mocks.useTenant.mockReturnValue({ role: undefined, accountResolution: 'loading' });
    renderIndex();
    expect(landsOn()).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('waits for the gates before choosing', () => {
    mocks.useTenant.mockReturnValue({ role: 'agent', accountResolution: 'ready' });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'loading' });
    renderIndex();
    expect(screen.queryByText(/switched on/)).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    cleanup();
    mocks.useTenant.mockReturnValue({ role: 'tenant_admin', accountResolution: 'ready' });
    mocks.useGovernance.mockReturnValue({ isEnabled: () => true, loading: true });
    renderIndex();
    expect(landsOn()).toBeNull();
  });
});
