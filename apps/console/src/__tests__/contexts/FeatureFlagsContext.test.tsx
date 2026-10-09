import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { FeatureFlagMap } from '../../types/feature-flags';

vi.mock('../../contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: vi.fn() }));
vi.mock('../../api/feature-flags', () => ({ fetchFeatureFlags: vi.fn() }));

import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { fetchFeatureFlags } from '../../api/feature-flags';
import { FeatureFlagsProvider, useFeatureFlags } from '../../contexts/FeatureFlagsContext';

function mockAuthAndTenant(
  user: { id: string } | null = { id: 'u1' },
  tenantId: string | null = 't1',
  accountId: string | null = 'a1',
  /**
   * How account resolution went. Defaults to `'loading'` because that is what
   * every pre-existing case here means by "no account yet" — a resolution still
   * in flight, which is the one situation where waiting is honest.
   */
  accountResolution: 'loading' | 'ready' | 'degraded' | 'error' = 'loading',
) {
  vi.mocked(useAuth).mockReturnValue({ user } as ReturnType<typeof useAuth>);
  vi.mocked(useTenant).mockReturnValue({
    tenantId,
    accountId,
    accountResolution,
  } as ReturnType<typeof useTenant>);
}

function wrapper({ children }: { children: ReactNode }) {
  return <FeatureFlagsProvider>{children}</FeatureFlagsProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useFeatureFlags', () => {
  it('throws when used outside FeatureFlagsProvider', () => {
    mockAuthAndTenant();
    expect(() => renderHook(() => useFeatureFlags())).toThrow(
      'useFeatureFlags must be used within FeatureFlagsProvider',
    );
  });
});

describe('resolution + anti-flicker status contract', () => {
  it('fetches with tenantId AND accountId when both present', async () => {
    mockAuthAndTenant({ id: 'u1' }, 't1', 'a1');
    vi.mocked(fetchFeatureFlags).mockResolvedValue({ whatsapp_personal: true });

    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(fetchFeatureFlags).toHaveBeenCalledWith('t1', 'a1');
    expect(result.current.flags).toEqual({ whatsapp_personal: true });
  });

  it('starts in loading; isEnabled is false while loading (no default-true)', () => {
    mockAuthAndTenant();
    vi.mocked(fetchFeatureFlags).mockImplementation(() => new Promise<FeatureFlagMap>(() => {}));

    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    expect(result.current.status).toBe('loading');
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('isEnabled true only when ready AND flag === true', async () => {
    mockAuthAndTenant();
    vi.mocked(fetchFeatureFlags).mockResolvedValue({ whatsapp_personal: true });

    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isEnabled('whatsapp_personal')).toBe(true);
    expect(result.current.isEnabled('unknown_flag')).toBe(false);
  });

  it('fails closed on error — status error, every gate false', async () => {
    mockAuthAndTenant();
    vi.mocked(fetchFeatureFlags).mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.flags).toEqual({});
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('a flag resolved to false is not enabled', async () => {
    mockAuthAndTenant();
    vi.mocked(fetchFeatureFlags).mockResolvedValue({ whatsapp_personal: false });

    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('does not fetch when user is null', () => {
    mockAuthAndTenant(null, 't1', 'a1');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(fetchFeatureFlags).not.toHaveBeenCalled();
    expect(result.current.status).toBe('loading');
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('does not fetch when tenantId is null', () => {
    mockAuthAndTenant({ id: 'u1' }, null, null);
    renderHook(() => useFeatureFlags(), { wrapper });
    expect(fetchFeatureFlags).not.toHaveBeenCalled();
  });

  it('does NOT fetch when accountId is missing (flags are account-scoped) — stays loading', () => {
    // tenant resolved but active account not yet — firing here would 400 at
    // core ("Missing required header: x-mgkvc-account") and hide every gate.
    mockAuthAndTenant({ id: 'u1' }, 't1', null);
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(fetchFeatureFlags).not.toHaveBeenCalled();
    expect(result.current.status).toBe('loading');
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('terminates instead of waiting forever when the account cannot be resolved', () => {
    /**
     * The infinite spinner, at its source.
     *
     * With no `accountId` this context never fires a request — correctly, since
     * core 400s without `x-mgkvc-account`. But it also reported `'loading'`
     * unconditionally, and when `TenantContext` has *failed* to resolve an account
     * there is nothing left to load: the wait never ends, and `RequireFlag` draws
     * a spinner for the life of the session. An `agent` (role level 5, below
     * `account.read`'s `viewer` floor) hit exactly this on every sign-in.
     *
     * `'error'` is the pre-existing fail-safe-closed terminal state, so gates stay
     * off either way — the difference is that a guard can render a sentence for
     * this one, and cannot for a spinner.
     */
    mockAuthAndTenant({ id: 'u1' }, 't1', null, 'error');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    expect(result.current.status).toBe('error');
    expect(fetchFeatureFlags).not.toHaveBeenCalled();
    // Still closed: a terminal state must not become an open gate.
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it.each([
    ['a tenant with genuinely zero accounts', 'ready' as const],
    ['a degraded fallback whose narrowed list is also empty', 'degraded' as const],
  ])('terminates for %s', (_label, resolution) => {
    /**
     * The two settled-but-accountless states the narrower `=== 'error'` check missed.
     *
     * In both, `TenantContext`'s `accountsLoadedForTenant` is already set, so its
     * effect will never fire again and nothing will ever produce an `accountId`.
     * There is nothing left to wait for — yet this context reported `'loading'`, and
     * `RequireFlag` draws a spinner for `'loading'`. Same permanent spinner as the
     * `agent` 403, reached from a different direction.
     */
    mockAuthAndTenant({ id: 'u1' }, 't1', null, resolution);
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    expect(result.current.status).toBe('error');
    expect(fetchFeatureFlags).not.toHaveBeenCalled();
    expect(result.current.isEnabled('whatsapp_personal')).toBe(false);
  });

  it('still waits while resolution is genuinely in flight', () => {
    // `'loading'` now means what the word means: an account may yet arrive. This is
    // the case that must NOT terminate, or the guard flashes an error screen on
    // every sign-in before the account lands.
    mockAuthAndTenant({ id: 'u1' }, 't1', null, 'loading');
    const { result } = renderHook(() => useFeatureFlags(), { wrapper });

    expect(result.current.status).toBe('loading');
  });

  it('stale-response guard: a superseded (tenant, account) response is ignored', async () => {
    // First context (t1/a1) resolves slowly; before it lands we switch to t1/a2
    // whose response arrives first. The stale a1 response must not clobber a2.
    let resolveA1!: (v: FeatureFlagMap) => void;
    const a1Promise = new Promise<FeatureFlagMap>((res) => { resolveA1 = res; });
    vi.mocked(fetchFeatureFlags).mockReturnValueOnce(a1Promise);

    mockAuthAndTenant({ id: 'u1' }, 't1', 'a1');
    const { result, rerender } = renderHook(() => useFeatureFlags(), { wrapper });
    expect(fetchFeatureFlags).toHaveBeenCalledWith('t1', 'a1');

    // Switch to a2 — its response resolves immediately with the real flags.
    vi.mocked(fetchFeatureFlags).mockResolvedValueOnce({ whatsapp_personal: true });
    mockAuthAndTenant({ id: 'u1' }, 't1', 'a2');
    rerender();
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.flags).toEqual({ whatsapp_personal: true });

    // The stale a1 promise now resolves with different flags — must be dropped.
    resolveA1({ whatsapp_personal: false });
    await a1Promise;
    expect(result.current.flags).toEqual({ whatsapp_personal: true });
    expect(result.current.isEnabled('whatsapp_personal')).toBe(true);
  });
});
