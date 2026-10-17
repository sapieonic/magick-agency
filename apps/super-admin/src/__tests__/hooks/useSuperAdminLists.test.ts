import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listTenants: vi.fn(),
  listAllUsers: vi.fn(),
  listAdmins: vi.fn(),
}));

vi.mock('../../api/super-admin', () => mocks);

import { useSuperAdminTenants } from '../../hooks/useSuperAdminTenants';
import { useSuperAdminUsers } from '../../hooks/useSuperAdminUsers';
import { useSuperAdminAdmins } from '../../hooks/useSuperAdminAdmins';

/**
 * The three list hooks are thin wrappers over `useAsyncResource` (whose
 * ordering and unmount guarantees are pinned in packages/web-ui): these pin
 * what each one unwraps and the error text it falls back to.
 */

beforeEach(() => vi.clearAllMocks());

type ListHook = () => { loading: boolean; error: string | null };
const tenantsHook: ListHook = () => useSuperAdminTenants();
const usersHook: ListHook = () => useSuperAdminUsers();
const adminsHook: ListHook = () => useSuperAdminAdmins();

describe('super-admin list hooks', () => {
  it.each([
    ['useSuperAdminTenants', tenantsHook, mocks.listTenants, { tenants: [{ id: 't-1' }] }, 'tenants'],
    ['useSuperAdminUsers', usersHook, mocks.listAllUsers, { users: [{ id: 'u-1' }] }, 'users'],
    ['useSuperAdminAdmins', adminsHook, mocks.listAdmins, { admins: [{ id: 'sa-1' }] }, 'admins'],
  ])('%s unwraps its list', async (_name, hook, api, response, field) => {
    api.mockResolvedValue(response);
    const { result } = renderHook(hook);

    expect(result.current.loading).toBe(true);
    expect((result.current as unknown as Record<string, unknown>)[field]).toEqual([]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect((result.current as unknown as Record<string, unknown>)[field]).toEqual(
      (response as unknown as Record<string, unknown>)[field],
    );
    expect(result.current.error).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['useSuperAdminTenants', tenantsHook, mocks.listTenants, 'Failed to load tenants'],
    ['useSuperAdminUsers', usersHook, mocks.listAllUsers, 'Failed to load users'],
    ['useSuperAdminAdmins', adminsHook, mocks.listAdmins, 'Failed to load admins'],
  ])('%s reports a failure, with its own fallback text', async (_name, hook, api, fallback) => {
    api.mockRejectedValueOnce(new Error('server said no'));
    const first = renderHook(hook);
    await waitFor(() => expect(first.result.current.error).toBe('server said no'));
    first.unmount();

    api.mockRejectedValueOnce('no message');
    const second = renderHook(hook);
    await waitFor(() => expect(second.result.current.error).toBe(fallback));
  });
});
