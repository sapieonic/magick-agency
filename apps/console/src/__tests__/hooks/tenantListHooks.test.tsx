import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';

/**
 * `useTeam`, `useAccounts` and `usePhoneNumbers` sit on `useAsyncResource`.
 * These pin the two things each hook adds on top of it: no request before the
 * tenant (and account) resolve — `loading` stays true, as before — and, for
 * `useTeam`, a `loaded` flag a page can use to keep its table during a reload.
 * The stale-response guard itself is `useAsyncResource`'s and tested there.
 */
const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  listTenantMembers: vi.fn(),
  listAccounts: vi.fn(),
  listMyPhoneNumbers: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));
vi.mock('../../api/accounts', () => ({ listAccounts: mocks.listAccounts }));
vi.mock('../../api/phone-numbers', () => ({ listMyPhoneNumbers: mocks.listMyPhoneNumbers }));

import { useTeam } from '../../hooks/useTeam';
import { useAccounts } from '../../hooks/useAccounts';
import { usePhoneNumbers } from '../../hooks/usePhoneNumbers';

beforeEach(() => {
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'acct-1' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useTeam', () => {
  it('waits for a tenant without requesting, then loads', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: null });
    mocks.listTenantMembers.mockResolvedValue([{ membership: { id: 'm1' } }]);
    const { result, rerender } = renderHook(() => useTeam());

    expect(result.current.loading).toBe(true);
    expect(result.current.loaded).toBe(false);
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
    // A reload while waiting settles at once (no request) and leaves it loading.
    await act(async () => { await result.current.reload(); });
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(true);

    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1' });
    rerender();
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(mocks.listTenantMembers).toHaveBeenCalledWith('tenant-1');
    expect(result.current.members).toHaveLength(1);
    expect(result.current.loading).toBe(false);
  });

  it('keeps the list and `loaded` during a reload', async () => {
    mocks.listTenantMembers.mockResolvedValueOnce([{ membership: { id: 'm1' } }]);
    const { result } = renderHook(() => useTeam());
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let resolve!: (v: unknown) => void;
    mocks.listTenantMembers.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    act(() => { void result.current.reload(); });
    expect(result.current.loading).toBe(true);
    expect(result.current.loaded).toBe(true);
    expect(result.current.members).toHaveLength(1);

    await act(async () => { resolve([]); });
    expect(result.current.members).toHaveLength(0);
  });

  it('reports the request’s message on failure', async () => {
    mocks.listTenantMembers.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useTeam());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loaded).toBe(false);
  });
});

describe('useAccounts', () => {
  it('loads the tenant’s accounts', async () => {
    mocks.listAccounts.mockResolvedValue([{ id: 'a1' }]);
    const { result } = renderHook(() => useAccounts());
    await waitFor(() => expect(result.current.accounts).toHaveLength(1));
    expect(mocks.listAccounts).toHaveBeenCalledWith('tenant-1');
  });
});

describe('usePhoneNumbers', () => {
  it('waits for an account, and derives the default number', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: null });
    mocks.listMyPhoneNumbers.mockResolvedValue([
      { phone_number: '+911', is_default: false },
      { phone_number: '+912', is_default: true },
    ]);
    const { result, rerender } = renderHook(() => usePhoneNumbers());
    expect(result.current.loading).toBe(true);
    expect(mocks.listMyPhoneNumbers).not.toHaveBeenCalled();

    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'acct-1' });
    rerender();
    await waitFor(() => expect(result.current.defaultNumber).toBe('+912'));
    expect(mocks.listMyPhoneNumbers).toHaveBeenCalledWith('tenant-1', 'acct-1');
  });
});
