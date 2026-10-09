import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyAccountSettings } from '@magick-agency/contracts/api/platform/settings';

/**
 * NEW (magick-agency): `RequireCapability` over the REAL settings-derived map.
 *
 * `GovernanceGating.test.tsx` drives the guard with a mocked `useGovernance`;
 * this one mounts the real `GovernanceProvider`, so what is under test is the
 * whole chain plan replaced governance with: the session's per-account
 * settings row → the derived capability → the guard. Recording or analysis
 * switched off on the ACTIVE account refuses the gated surface; the same switch
 * on a sibling account does not; `agency` itself is never refused.
 */
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../analytics/events', () => ({ trackFeatureGateUnavailable: vi.fn() }));

import { GovernanceProvider } from '../../contexts/GovernanceContext';
import RequireCapability from '../../components/auth/RequireCapability';

function row(accountId: string, over: Partial<AgencyAccountSettings> = {}): AgencyAccountSettings {
  return {
    tenant_id: 't1',
    account_id: accountId,
    allow_recording: true,
    analyze_calls: true,
    max_concurrent_calls: 10,
    webrtc_max_duration_seconds: 1800,
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function renderGate(capability: string, settings: Record<string, AgencyAccountSettings>, accountId = 'a1') {
  mocks.useAuth.mockReturnValue({ settings, loading: false, refreshSession: vi.fn() });
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId });
  return render(
    <MemoryRouter>
      <GovernanceProvider>
        <RequireCapability capability={capability}><div>GATED</div></RequireCapability>
      </GovernanceProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('RequireCapability over the session settings map', () => {
  it('refuses a recording-gated surface when the active account has recording off', () => {
    renderGate('agency.recording', { a1: row('a1', { allow_recording: false }) });
    expect(screen.queryByText('GATED')).toBeNull();
    expect(screen.getByText(/Not available for your account/i)).toBeTruthy();
  });

  it('refuses an analysis-gated surface when the active account has analysis off', () => {
    renderGate('agency.analytics', { a1: row('a1', { analyze_calls: false }) });
    expect(screen.queryByText('GATED')).toBeNull();
  });

  it('admits both when the active account has them on — a SIBLING account’s off does not leak', () => {
    const settings = {
      a1: row('a1'),
      a2: row('a2', { allow_recording: false, analyze_calls: false }),
    };
    renderGate('agency.recording', settings);
    expect(screen.getByText('GATED')).toBeTruthy();
    cleanup();
    renderGate('agency.analytics', settings);
    expect(screen.getByText('GATED')).toBeTruthy();
  });

  it('never refuses the section-level `agency` gate, whatever the toggles', () => {
    renderGate('agency', { a1: row('a1', { allow_recording: false, analyze_calls: false }) });
    expect(screen.getByText('GATED')).toBeTruthy();
  });
});
