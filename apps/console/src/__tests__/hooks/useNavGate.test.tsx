import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * The navigation gate input (`hooks/useNavGate.ts`): one memoised value for every gate the shell
 * reads, failing closed with no flag or capability provider, and reading the Missed-calls rule only
 * when asked, with the dialer on and an account chosen.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  accountId: 'a-1' as string | null,
  noFlagProvider: false,
  caps: true,
  missed: vi.fn((_: { enabled?: boolean } = {}) => ({ available: true, inboundOn: true, count: null, settled: true })),
}));

const isFlagEnabled = () => true;
const isCapabilityEnabled = () => mocks.caps;

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, accountId: mocks.accountId }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => {
    if (mocks.noFlagProvider) throw new Error('no provider');
    return { isEnabled: isFlagEnabled };
  },
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: isCapabilityEnabled }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: (opts: { enabled?: boolean } = {}) => {
    const access = mocks.missed(opts);
    return { ...access, available: opts.enabled !== false && access.available };
  },
}));

import { useNavGate } from '../../hooks/useNavGate';

beforeEach(() => {
  mocks.role = 'account_admin';
  mocks.accountId = 'a-1';
  mocks.noFlagProvider = false;
  mocks.caps = true;
  mocks.missed.mockClear();
});

describe('useNavGate', () => {
  it('keeps its identity while nothing it reads changes', () => {
    const { result, rerender } = renderHook(() => useNavGate({ missed: true }));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(first.role).toBe('account_admin');
    expect(first.isFlagEnabled('agency_dialer_enabled')).toBe(true);
    expect(first.missedAvailable).toBe(true);
  });

  it('fails closed with no flag provider', () => {
    mocks.noFlagProvider = true;
    const { result } = renderHook(() => useNavGate({ missed: true }));
    expect(result.current.isFlagEnabled('agency_dialer_enabled')).toBe(false);
    expect(result.current.missedAvailable).toBe(false);
  });

  it('reads the Missed-calls rule only when asked, with the dialer on and an account', () => {
    expect(renderHook(() => useNavGate()).result.current.missedAvailable).toBe(false);
    expect(mocks.missed).toHaveBeenLastCalledWith({ enabled: false });

    mocks.caps = false;
    expect(renderHook(() => useNavGate({ missed: true })).result.current.missedAvailable).toBe(false);
    expect(mocks.missed).toHaveBeenLastCalledWith({ enabled: false });

    mocks.caps = true;
    mocks.accountId = null;
    expect(renderHook(() => useNavGate({ missed: true })).result.current.missedAvailable).toBe(false);
    expect(mocks.missed).toHaveBeenLastCalledWith({ enabled: false });

    mocks.accountId = 'a-1';
    expect(renderHook(() => useNavGate({ missed: true })).result.current.missedAvailable).toBe(true);
    expect(mocks.missed).toHaveBeenLastCalledWith({ enabled: true });
  });
});
