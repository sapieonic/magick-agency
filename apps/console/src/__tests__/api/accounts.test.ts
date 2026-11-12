import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `createAccount` — what reaches the wire. The one thing it must not do is send
 * the active account: with `X-Account-Id` the server prefers a membership scoped
 * to that account over the caller's tenant-wide seat, and only the tenant-wide
 * seat may create (`tenant_wide_membership_required`). `apiFetch` sets that header
 * from its fourth argument, so the call is pinned to three.
 */

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  apiFetch: mocks.apiFetch,
}));

import { createAccount } from '../../api/accounts';
import { ENDPOINTS } from '../../config';

describe('createAccount', () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
  });

  it('POSTs the name to /accounts for the tenant and returns the account', async () => {
    const account = { id: 'acct-9', tenant_id: 'tenant-1', name: 'Renewals', slug: 'renewals' };
    mocks.apiFetch.mockResolvedValue({ account });

    const result = await createAccount('tenant-1', 'Renewals');

    expect(result).toBe(account);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [url, init, tenantId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toBe(ENDPOINTS.accounts.base);
    expect(init).toEqual({ method: 'POST', body: JSON.stringify({ name: 'Renewals' }) });
    expect(tenantId).toBe('tenant-1');
  });

  it('never passes an account id, so X-Account-Id is not sent', async () => {
    mocks.apiFetch.mockResolvedValue({ account: {} });

    await createAccount('tenant-1', 'Renewals');

    expect(mocks.apiFetch.mock.calls[0]).toHaveLength(3);
  });

  it('lets a refusal through unchanged for the modal to show', async () => {
    const refusal = new Error('There is already an account called "Renewals" in this organisation.');
    mocks.apiFetch.mockRejectedValue(refusal);

    await expect(createAccount('tenant-1', 'Renewals')).rejects.toBe(refusal);
  });
});
