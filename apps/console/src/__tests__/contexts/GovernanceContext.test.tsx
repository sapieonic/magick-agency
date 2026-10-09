import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AgencyAccountSettings } from '@magick-agency/contracts/api/platform/settings';

/**
 * GovernanceContext — the end-user gating source.
 *
 * There is no governance read: the map is derived from the session's
 * per-account settings (`useAuth().settings[accountId]`). Four properties are
 * pinned over that source — re-gating on an account switch
 * without re-login, fail-open on an absent key, fail-open when the source is
 * missing (no settings row), an explicit false
 * hides — and two further cases pin what the derivation adds: the section-level
 * `agency` gate is always on, and `loading` is the session's.
 */
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));

import { GovernanceProvider, useGovernance } from '../../contexts/GovernanceContext';

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

function Probe() {
  const { isEnabled, loading } = useGovernance();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="agency">{String(isEnabled('agency'))}</span>
      <span data-testid="recording">{String(isEnabled('agency.recording'))}</span>
      <span data-testid="analytics">{String(isEnabled('agency.analytics'))}</span>
      <span data-testid="unknown">{String(isEnabled('messaging.telegram'))}</span>
    </div>
  );
}

function auth(settings: Record<string, AgencyAccountSettings>, loading = false) {
  return { user: { id: 'u1' }, settings, loading, refreshSession: vi.fn() };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('GovernanceContext', () => {
  beforeEach(() => {
    mocks.useAuth.mockReturnValue(auth({ a1: row('a1'), a2: row('a2', { allow_recording: false }) }));
  });

  it('UI-1a: re-gates on account switch WITHOUT re-login (and without a request)', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    const { rerender } = render(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('recording').textContent).toBe('true');

    // Switch account → a2's row has recording off; the gate flips live.
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a2' });
    rerender(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('recording').textContent).toBe('false');
  });

  it('UI-2: isEnabled is fail-open — a missing key resolves to enabled', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    render(<GovernanceProvider><Probe /></GovernanceProvider>);
    // 'messaging.telegram' is absent from the map ⇒ enabled (only explicit false hides).
    expect(screen.getByTestId('unknown').textContent).toBe('true');
  });

  it('fail-open when the active account has no settings row: no throw, gates stay enabled', () => {
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a-created-after-sign-in' });
    render(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('recording').textContent).toBe('true');
    expect(screen.getByTestId('analytics').textContent).toBe('true');
  });

  it('an explicit false hides the capability', () => {
    mocks.useAuth.mockReturnValue(auth({ a1: row('a1', { analyze_calls: false }) }));
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    render(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('analytics').textContent).toBe('false');
    expect(screen.getByTestId('recording').textContent).toBe('true');
  });

  it('the section-level `agency` gate is always on — even with every per-field toggle off, or no row', () => {
    mocks.useAuth.mockReturnValue(
      auth({ a1: row('a1', { allow_recording: false, analyze_calls: false }) }),
    );
    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
    const { rerender } = render(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('agency').textContent).toBe('true');

    mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: null });
    rerender(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('agency').textContent).toBe('true');
  });

  it('`loading` is the session’s own, so a guard waits for sign-in rather than for a fetch', () => {
    mocks.useAuth.mockReturnValue(auth({}, true));
    mocks.useTenant.mockReturnValue({ tenantId: null, accountId: null });
    render(<GovernanceProvider><Probe /></GovernanceProvider>);
    expect(screen.getByTestId('loading').textContent).toBe('true');
  });
});
