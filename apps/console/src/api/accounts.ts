import { ENDPOINTS } from '../config';
import type { Account, TenantAccount } from '../types/auth';
import { apiFetch } from './client';

export async function listAccounts(tenantId: string): Promise<Account[]> {
  const res = await apiFetch<{ accounts: Account[] }>(ENDPOINTS.accounts.base, {}, tenantId);
  return res.accounts;
}

/**
 * The accounts the signed-in user is a member of.
 *
 * **The only account-resolution route an `agent` can call.** `listAccounts` above
 * floors at `account.read` = `viewer` (10) and the Agency Dialer's `agent` role is
 * 5, so an agent 403s there and — before this existed — had no way to learn which
 * account to activate at all: `TenantContext` swallowed the 403, never set an
 * active account, and every account-scoped context downstream waited forever.
 * Lowering `account.read` was rejected on purpose (a test pins that agents lack
 * it), so this is a second, narrower route rather than a widened permission.
 *
 * Returns `{id, name, tenant_id}` only. That is the whole response and not a
 * projection applied here — the route skips the permission check precisely
 * because it never reveals more about an account than the caller's own membership
 * already implies.
 */
export async function listMyAccounts(tenantId: string): Promise<TenantAccount[]> {
  const res = await apiFetch<{ accounts: TenantAccount[] }>(
    ENDPOINTS.accounts.mine,
    {},
    tenantId,
  );
  return res.accounts;
}

// There is no `createAccount`, `updateAccount` or
// `deleteAccount` (`POST|PUT|DELETE /accounts`): account administration is a super-admin act in agency, and the
// contract has no `account.create|update|delete` permission.
