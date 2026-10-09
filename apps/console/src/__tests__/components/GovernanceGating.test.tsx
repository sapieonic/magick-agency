import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The capability map is derived from the session's per-account settings
 * (`GovernanceContext`). The RequireCapability cases drive `agency.recording`,
 * and the two Sidebar cases drive the one capability-gated entry the console's
 * Sidebar has — Call Summaries, on `agency.analytics`.
 *
 * End-user governance gating — RequireCapability (in-place CapabilityUnavailable,
 * no redirect) + the Sidebar's capability-gated entry hidden. useGovernance/useTenant/
 * useFeatureFlags are mocked so each test drives the capability map directly
 * (mirrors WebRtcNavGating.test.tsx).
 */
const mocks = vi.hoisted(() => ({
  useGovernance: vi.fn(),
  useTenant: vi.fn(),
  useFeatureFlags: vi.fn(),
  trackFeatureGateUnavailable: vi.fn(),
}));

vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../analytics/events', () => ({
  trackFeatureGateUnavailable: mocks.trackFeatureGateUnavailable,
}));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import RequireCapability from '../../components/auth/RequireCapability';
import { Sidebar } from '../../components/layout/Sidebar';

function gov(isEnabled: (k: string) => boolean, loading = false) {
  return { isEnabled, map: {}, loading, refresh: vi.fn() };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RequireCapability', () => {
  function renderGuard(capability = 'agency.recording') {
    return render(
      <MemoryRouter initialEntries={['/agency/campaigns']}>
        <RequireCapability capability={capability}><div>MESSAGING PAGE</div></RequireCapability>
      </MemoryRouter>,
    );
  }

  it('renders CapabilityUnavailable IN PLACE when the capability is off (no children)', () => {
    mocks.useGovernance.mockReturnValue(gov(() => false));
    renderGuard();
    // Neutral in-place screen — not the page, not a redirect.
    expect(screen.getByText(/Not available for your account/i)).toBeTruthy();
    expect(screen.queryByText('MESSAGING PAGE')).toBeNull();
    expect(mocks.trackFeatureGateUnavailable).toHaveBeenCalledWith({
      gate_type: 'capability',
      gate: 'agency.recording',
    });
  });

  it('renders children when the capability is enabled', () => {
    mocks.useGovernance.mockReturnValue(gov(() => true));
    renderGuard();
    expect(screen.getByText('MESSAGING PAGE')).toBeTruthy();
    expect(screen.queryByText(/Not available/i)).toBeNull();
  });

  it('shows a spinner while loading — never the unavailable screen (no flash-then-flip)', () => {
    mocks.useGovernance.mockReturnValue(gov(() => false, true));
    renderGuard();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByText(/Not available/i)).toBeNull();
    expect(screen.queryByText('MESSAGING PAGE')).toBeNull();
  });

  it('does not emit a feature-gate event for unknown capability ids', () => {
    mocks.useGovernance.mockReturnValue(gov(() => false));
    renderGuard('unknown_capability');
    expect(mocks.trackFeatureGateUnavailable).not.toHaveBeenCalled();
  });
});

describe('Sidebar — Call Summaries capability gating', () => {
  function renderSidebar({ role = 'account_admin' as string, analytics = true } = {}) {
    mocks.useTenant.mockReturnValue({ role });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, flags: {}, status: 'ready' as const, reload: vi.fn() });
    mocks.useGovernance.mockReturnValue(gov((k) => (k === 'agency.analytics' ? analytics : true)));
    // Start on an admin path so the (collapsible) ADMIN section is expanded —
    // otherwise its items aren't rendered regardless of gating.
    return render(
      <MemoryRouter initialEntries={['/app/team']}>
        <Sidebar />
      </MemoryRouter>,
    );
  }

  it('shows Call Summaries when the agency.analytics capability is ON', () => {
    renderSidebar({ analytics: true });
    expect(screen.getByRole('link', { name: /Call Summaries/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Team/i })).toBeTruthy();
  });

  it('hides Call Summaries when the agency.analytics capability is OFF', () => {
    renderSidebar({ analytics: false });
    expect(screen.queryByRole('link', { name: /Call Summaries/i })).toBeNull();
    // A non-gated item still renders — the gate is capability-scoped, not global.
    expect(screen.getByRole('link', { name: /Team/i })).toBeTruthy();
  });
});
