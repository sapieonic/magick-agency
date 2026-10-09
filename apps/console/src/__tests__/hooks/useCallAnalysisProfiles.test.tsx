import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CallAnalysisProfile, CallAnalysisProfilesListResponse } from '../../types/call-analysis-profile';

const mocks = vi.hoisted(() => ({
  listCallAnalysisProfiles: vi.fn(),
  deleteCallAnalysisProfile: vi.fn(),
  useTenant: vi.fn(),
}));

vi.mock('../../api/call-analysis-profiles', () => ({
  listCallAnalysisProfiles: mocks.listCallAnalysisProfiles,
  deleteCallAnalysisProfile: mocks.deleteCallAnalysisProfile,
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: mocks.useTenant,
}));

import { useCallAnalysisProfiles } from '../../hooks/useCallAnalysisProfiles';

function makeProfile(overrides: Partial<CallAnalysisProfile> = {}): CallAnalysisProfile {
  return {
    id: 'profile-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    name: 'Collections quality',
    description: null,
    context: null,
    custom_dimensions: [],
    language_hint: null,
    is_default: false,
    is_active: true,
    version: 1,
    created_at: '2026-07-28T00:00:00.000Z',
    updated_at: '2026-07-28T00:00:00.000Z',
    ...overrides,
  };
}

function response(profiles: CallAnalysisProfile[] = [makeProfile()]): CallAnalysisProfilesListResponse {
  return { profiles, total: profiles.length, limit: 100, offset: 0 };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.listCallAnalysisProfiles.mockResolvedValue(response());
  mocks.deleteCallAnalysisProfile.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useCallAnalysisProfiles', () => {
  it('starts loading, then exposes profiles, total, and the default profile from the resolved response', async () => {
    const pending = deferred<CallAnalysisProfilesListResponse>();
    const defaultProfile = makeProfile({ id: 'profile-default', is_default: true });
    mocks.listCallAnalysisProfiles.mockReturnValue(pending.promise);

    const { result } = renderHook(() => useCallAnalysisProfiles());

    expect(result.current.loading).toBe(true);
    expect(result.current.profiles).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(mocks.listCallAnalysisProfiles).toHaveBeenCalledWith('tenant-1', 100, 0, 'account-1');

    await act(async () => {
      pending.resolve(response([makeProfile(), defaultProfile]));
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.profiles).toEqual([makeProfile(), defaultProfile]);
    expect(result.current.total).toBe(2);
    expect(result.current.defaultProfile).toEqual(defaultProfile);
    expect(result.current.error).toBeNull();
  });

  it('sets the Error message and clears loading when loading fails', async () => {
    mocks.listCallAnalysisProfiles.mockRejectedValue(new Error('403 Forbidden'));

    const { result } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles).toEqual([]);
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBe('403 Forbidden');
  });

  it('uses the generic error message for a non-Error rejection', async () => {
    mocks.listCallAnalysisProfiles.mockRejectedValue('network unavailable');

    const { result } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('Failed to load analysis profiles');
  });

  it('reload() invokes the API again and replaces the previous data', async () => {
    mocks.listCallAnalysisProfiles
      .mockResolvedValueOnce(response([makeProfile({ id: 'profile-old' })]))
      .mockResolvedValueOnce(response([makeProfile({ id: 'profile-new', is_default: true })]));

    const { result } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles[0]?.id).toBe('profile-old');

    act(() => { result.current.reload(); });

    await waitFor(() => expect(mocks.listCallAnalysisProfiles).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profiles[0]?.id).toBe('profile-new');
    expect(result.current.defaultProfile?.id).toBe('profile-new');
  });

  it('remove() deletes with the current tenant/account and reloads the list', async () => {
    const { result } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.remove('profile-1');
    });

    expect(mocks.deleteCallAnalysisProfile).toHaveBeenCalledWith('tenant-1', 'profile-1', 'account-1');
    expect(mocks.listCallAnalysisProfiles).toHaveBeenCalledTimes(2);
  });

  it('remove() rejects rather than no-opping when the tenant/account is unresolved', async () => {
    /**
     * A silent `return` here is indistinguishable from a successful delete at the
     * call site: `AnalysisProfilesPage` closes the dialog, says nothing, and
     * leaves the row in the table — the exact symptom the delete-refusal fix
     * removed, reached from a different cause. So the caller has to be able to
     * tell, and `handleDeleteConfirm`'s catch is what puts it on screen.
     */
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: null });
    const { result } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(result.current.loading).toBe(false));
    await expect(result.current.remove('profile-1')).rejects.toThrow(/no workspace/i);
    // And it did not quietly pretend to delete anything on the way.
    expect(mocks.deleteCallAnalysisProfile).not.toHaveBeenCalled();
  });

  it('does not load and clears loading when disabled or tenant/account context is incomplete', async () => {
    const { result: disabled } = renderHook(() => useCallAnalysisProfiles({ enabled: false }));

    await waitFor(() => expect(disabled.current.loading).toBe(false));
    expect(mocks.listCallAnalysisProfiles).not.toHaveBeenCalled();

    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: null });
    const { result: missingAccount } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(missingAccount.current.loading).toBe(false));
    expect(mocks.listCallAnalysisProfiles).not.toHaveBeenCalled();
  });

  it('reloads with the new tenant and account when context changes', async () => {
    const { rerender } = renderHook(() => useCallAnalysisProfiles());

    await waitFor(() => expect(mocks.listCallAnalysisProfiles).toHaveBeenCalledTimes(1));
    expect(mocks.listCallAnalysisProfiles).toHaveBeenLastCalledWith('tenant-1', 100, 0, 'account-1');

    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-2', accountId: 'account-2' });
    rerender();

    await waitFor(() => expect(mocks.listCallAnalysisProfiles).toHaveBeenCalledTimes(2));
    expect(mocks.listCallAnalysisProfiles).toHaveBeenLastCalledWith('tenant-2', 100, 0, 'account-2');
  });

  it('cancels an in-flight request on unmount, causing no state update after unmount', async () => {
    const pending = deferred<CallAnalysisProfilesListResponse>();
    mocks.listCallAnalysisProfiles.mockReturnValue(pending.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useCallAnalysisProfiles());
    expect(result.current.loading).toBe(true);

    unmount();
    await act(async () => {
      pending.resolve(response([makeProfile({ id: 'profile-late' })]));
      await Promise.resolve();
    });

    // The cancelled settlement cannot mutate the final mounted state snapshot.
    expect(result.current.profiles).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
