import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Tenant, Membership, Account } from '../../types/auth';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listAccounts: vi.fn(),
  listMyAccounts: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('../../api/accounts', () => ({
  listAccounts: mocks.listAccounts,
  listMyAccounts: mocks.listMyAccounts,
}));

import { TenantProvider, useTenant } from '../../contexts/TenantContext';
import { ApiError } from '../../api/client';

/**
 * The refusal the server actually sends for a role below `account.read`'s
 * `viewer` floor, thrown the way `apiFetch` actually throws it.
 *
 * A real `ApiError` and not `new Error('Forbidden')`, because the **status is now
 * load-bearing**: a 403 is a legitimate narrowing (the caller genuinely has fewer
 * accounts) and anything else is a degraded view of someone who should see more.
 * A hand-built `Error` carries no `statusCode`, so it classifies as degraded —
 * which is the correct treatment of an unknown failure and the wrong fixture for
 * this case.
 */
function forbidden(): ApiError {
  return new ApiError(403, { error: 'Forbidden', message: 'Missing permission: account.read' });
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const TENANT_A: Tenant = {
  id: 't-a', name: 'Tenant A', slug: 'tenant-a',
  settings: {}, status: 'active', created_at: '', updated_at: '',
};
const TENANT_B: Tenant = {
  id: 't-b', name: 'Tenant B', slug: 'tenant-b',
  settings: {}, status: 'active', created_at: '', updated_at: '',
};

function mem(overrides: Partial<Membership> & Pick<Membership, 'id' | 'tenant_id' | 'role'>): Membership {
  return {
    user_id: 'u1', account_id: null, status: 'active',
    invited_by: null, created_at: '', updated_at: '',
    ...overrides,
  };
}

const TENANT_MEMBERSHIP = mem({ id: 'm1', tenant_id: 't-a', role: 'tenant_owner', account_id: null });
const ACCOUNT_MEMBERSHIP = mem({ id: 'm2', tenant_id: 't-a', role: 'operator', account_id: 'acct-1' });
const INACTIVE_MEMBERSHIP = mem({ id: 'm3', tenant_id: 't-a', role: 'tenant_admin', status: 'revoked' });

const ACCOUNT_DEFAULT: Account = {
  id: 'acct-1', tenant_id: 't-a', name: 'Default', slug: 'default',
  settings: {}, status: 'active', created_at: '', updated_at: '',
};

const FAKE_USER = { id: 'u1', email: 'test@example.com' };

// ─── helpers ─────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'magick-active-tenant';

function setupAuth(tenants: Tenant[], memberships: Membership[] = [], accounts: Account[] = [ACCOUNT_DEFAULT]) {
  mocks.useAuth.mockReturnValue({ tenants, memberships, user: FAKE_USER, defaultAccount: null } as any);
  mocks.listAccounts.mockResolvedValue(accounts);
  // Never reached on the happy path — a test that expects the fallback overrides
  // `listAccounts` to reject. Given a resolved value so that an accidental call
  // shows up as a wrong *account*, not as an unhandled rejection.
  mocks.listMyAccounts.mockResolvedValue([]);
}

function wrapper({ children }: { children: ReactNode }) {
  return <TenantProvider>{children}</TenantProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

// ─── hook guard ──────────────────────────────────────────────────────────────

describe('useTenant', () => {
  it('throws when used outside TenantProvider', () => {
    setupAuth([]);
    expect(() => renderHook(() => useTenant())).toThrow(
      'useTenant must be used within TenantProvider',
    );
  });
});

// ─── auto-selection ──────────────────────────────────────────────────────────

describe('auto-selection', () => {
  it('auto-selects first tenant when none stored', async () => {
    setupAuth([TENANT_A, TENANT_B], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));
    expect(result.current.activeTenant).toEqual(TENANT_A);
  });

  it('keeps stored tenant if it is valid', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-b', accountId: null }));
    setupAuth([TENANT_A, TENANT_B], [mem({ id: 'm-b', tenant_id: 't-b', role: 'viewer' })]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.tenantId).toBe('t-b'));
    expect(result.current.activeTenant).toEqual(TENANT_B);
  });

  it('resets to first tenant when stored tenant is invalid', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 'gone' }));
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));
  });

  it('handles corrupt localStorage JSON gracefully', async () => {
    localStorage.setItem(STORAGE_KEY, 'not-json');
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));
  });

  it('when there are no tenants, activeTenant is null', () => {
    setupAuth([], []);

    const { result } = renderHook(() => useTenant(), { wrapper });

    expect(result.current.activeTenant).toBeNull();
    expect(result.current.tenantId).toBeNull();
  });
});

// ─── localStorage persistence ────────────────────────────────────────────────

describe('localStorage persistence', () => {
  it('persists tenant and account selection', async () => {
    setupAuth([TENANT_A, TENANT_B], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));
    await waitFor(() => expect(result.current.accountId).toBe('acct-1'));

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.tenantId).toBe('t-a');
    expect(stored.accountId).toBe('acct-1');
  });

  it('updates localStorage when account changes', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveAccountId('acct-1');
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.accountId).toBe('acct-1');
  });

  it('restores accountId from localStorage', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-a', accountId: 'acct-1' }));
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.accountId).toBe('acct-1'));
  });
});

// ─── setActiveTenantId / setActiveAccountId ──────────────────────────────────

describe('setActiveTenantId', () => {
  it('switches to a different tenant', async () => {
    setupAuth([TENANT_A, TENANT_B], [
      TENANT_MEMBERSHIP,
      mem({ id: 'm-b', tenant_id: 't-b', role: 'viewer' }),
    ]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveTenantId('t-b');
    });

    expect(result.current.tenantId).toBe('t-b');
    expect(result.current.activeTenant).toEqual(TENANT_B);
  });

  it('clears accountId when tenant changes', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-a', accountId: 'acct-1' }));
    setupAuth([TENANT_A, TENANT_B], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.accountId).toBe('acct-1'));

    act(() => {
      result.current.setActiveTenantId('t-b');
    });

    // accountId is null immediately after switching (before new accounts load)
    expect(result.current.accountId).toBeNull();
    expect(result.current.accounts).toEqual([]);
  });
});

describe('setActiveAccountId', () => {
  it('sets the account id', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveAccountId('acct-1');
    });

    expect(result.current.accountId).toBe('acct-1');
  });

  it('can be set and cleared', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.accountId).toBe('acct-1'));

    act(() => {
      result.current.setActiveAccountId(null);
    });

    expect(result.current.accountId).toBeNull();
  });
});

// ─── account resolution ──────────────────────────────────────────────────────

/**
 * The Agency Dialer's `agent` role is level **5**, deliberately below
 * `account.read`'s `viewer` floor of 10 — so `GET /accounts` 403s for every agent
 * on every sign-in. This context swallowed that rejection and "proceeded with
 * empty accounts", which is not proceeding: `accountId` stayed null, every
 * account-scoped hook kept its `if (!accountId) return` guard, and
 * `FeatureFlagsContext` held `loading` forever behind a spinner with no error and
 * nothing in the console.
 *
 * Two fixes, tested separately because they fix different things: the
 * `/accounts/mine` fallback removes the *cause*, and the terminal `'error'` state
 * removes the *class* — any remaining failure now lands somewhere a screen can
 * render a sentence.
 */
describe('account resolution', () => {
  const MINE = [{ id: 'acct-9', tenant_id: 't-a', name: 'Ops' }];

  it('falls back to /accounts/mine when the permissioned list is refused', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
    mocks.listAccounts.mockRejectedValue(forbidden());
    mocks.listMyAccounts.mockResolvedValue(MINE);

    const { result } = renderHook(() => useTenant(), { wrapper });

    // The point of the whole exercise: an agent ends up WITH an active account.
    await waitFor(() => expect(result.current.accountId).toBe('acct-9'));
    // `'ready'`, not `'degraded'` — a 403 is the correct answer for this role, so
    // `/accounts/mine` IS the complete list and there is nothing to warn about.
    // Warning here would cry wolf at every agent on every sign-in.
    expect(result.current.accountResolution).toBe('ready');
    expect(result.current.accountError).toBeNull();
    expect(result.current.accounts).toEqual(MINE);
  });

  it('does not call the fallback when the permissioned list answers', async () => {
    /**
     * The regression guard for everyone who is not an agent. `/accounts/mine`
     * returns `{id, name, tenant_id}` and nothing else, so quietly preferring it
     * would strip `slug`/`settings`/`status` from the switcher for every role that
     * can see them today — fixing a break for the few by breaking the many.
     */
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.accountId).toBe('acct-1'));
    expect(mocks.listMyAccounts).not.toHaveBeenCalled();
    expect(result.current.accounts[0]!.slug).toBe('default');
  });

  it('reaches a TERMINAL error state when neither route answers', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
    mocks.listAccounts.mockRejectedValue(forbidden());
    mocks.listMyAccounts.mockRejectedValue(new Error('Network down'));

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.accountResolution).toBe('error'));
    // The message is the whole point — the failure mode this replaces was silent.
    expect(result.current.accountError).toBe('Network down');
    expect(result.current.accountId).toBeNull();
  });

  it('treats an empty account list as resolved, not as a failure', async () => {
    // A tenant can genuinely have no accounts, and `AgencyLayout` already has copy
    // for it. Reporting it as an error would put a Retry button in front of a
    // state that retrying cannot change.
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP], []);

    const { result } = renderHook(() => useTenant(), { wrapper });

    await waitFor(() => expect(result.current.accountResolution).toBe('ready'));
    expect(result.current.accountError).toBeNull();
    expect(result.current.accountId).toBeNull();
  });

  it('recovers through reloadAccounts, which is the retry behind the error screen', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
    mocks.listAccounts.mockRejectedValue(forbidden());
    mocks.listMyAccounts.mockRejectedValue(new Error('Network down'));

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.accountResolution).toBe('error'));

    mocks.listMyAccounts.mockResolvedValue(MINE);
    await act(async () => {
      result.current.reloadAccounts();
    });

    // Selecting an account — not merely refreshing the list — is what makes this a
    // recovery: after a failed first resolution there is nothing to preserve, and
    // a reload that left `accountId` null would land straight back on the error.
    await waitFor(() => expect(result.current.accountId).toBe('acct-9'));
    expect(result.current.accountResolution).toBe('ready');
    expect(result.current.accountError).toBeNull();
  });

  describe('a transient failure must not silently narrow an account_admin', () => {
    /**
     * **The gap between "you are allowed less" and "we are broken."**
     *
     * The fallback fires on any rejection — deliberately, so recovery never depends
     * on a status code the server might mask. What was missing is that it reported
     * `'ready'` either way. An `account_admin` signing in during a server restart
     * got `/accounts/mine`: their own memberships only, no `slug`/`settings`/
     * `status`, no warning, no retry offered, the narrowed pick written to
     * `localStorage`, and `accountsLoadedForTenant` set so the effect never fired
     * again. The only escapes were a tenant switch or a reload — neither of which a
     * user tries when nothing has told them anything is wrong.
     */
    it('reports degraded when the failure was NOT a permission refusal', async () => {
      setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
      mocks.listAccounts.mockRejectedValue(new ApiError(502, { error: 'Bad Gateway' }));
      mocks.listMyAccounts.mockResolvedValue(MINE);

      const { result } = renderHook(() => useTenant(), { wrapper });

      // Usable — they get an account and can work. That is why this is not `'error'`:
      // blocking the app behind `AccountUnavailable` over a list that is merely short
      // would be a worse outcome than the narrowing it reports.
      await waitFor(() => expect(result.current.accountId).toBe('acct-9'));
      expect(result.current.accountResolution).toBe('degraded');
      expect(result.current.accountError).toBeTruthy();
    });

    it('treats an unrecognisable failure as degraded, not as legitimate narrowing', async () => {
      /**
       * The masking trade-off, pinned. The server replaces error *bodies*, so a status
       * code is a weaker signal than it looks — and this is the direction the design
       * has to fail in. An unknown failure warns an agent who may not have needed it;
       * the opposite default silently narrows an admin, which is the defect.
       */
      setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
      mocks.listAccounts.mockRejectedValue(new Error('socket hang up'));
      mocks.listMyAccounts.mockResolvedValue(MINE);

      const { result } = renderHook(() => useTenant(), { wrapper });

      await waitFor(() => expect(result.current.accountResolution).toBe('degraded'));
    });

    it('does not persist a selection made from a list it does not trust', async () => {
      // A five-second outage would otherwise pin the user to one account across
      // reloads: the restore path only checks that the stored id is present in
      // whatever list comes back, and by then the evidence of why is long gone.
      setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
      mocks.listAccounts.mockRejectedValue(new ApiError(502, { error: 'Bad Gateway' }));
      mocks.listMyAccounts.mockResolvedValue(MINE);

      const { result } = renderHook(() => useTenant(), { wrapper });
      await waitFor(() => expect(result.current.accountId).toBe('acct-9'));

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears degraded once the authoritative list answers on retry', async () => {
      setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
      mocks.listAccounts.mockRejectedValue(new ApiError(502, { error: 'Bad Gateway' }));
      mocks.listMyAccounts.mockResolvedValue(MINE);

      const { result } = renderHook(() => useTenant(), { wrapper });
      await waitFor(() => expect(result.current.accountResolution).toBe('degraded'));

      mocks.listAccounts.mockResolvedValue([ACCOUNT_DEFAULT]);
      await act(async () => {
        result.current.reloadAccounts();
      });

      await waitFor(() => expect(result.current.accountResolution).toBe('ready'));
      expect(result.current.accountError).toBeNull();
      // The full row is back, `slug` and all — which is what was silently lost.
      expect(result.current.accounts[0]!.slug).toBe('default');
    });

    it('stays degraded when a retry succeeds only through the fallback again', async () => {
      // The retry must not become a way of dismissing the warning over a list that
      // is just as narrow as the one the user asked us to re-check.
      setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);
      mocks.listAccounts.mockRejectedValue(new ApiError(502, { error: 'Bad Gateway' }));
      mocks.listMyAccounts.mockResolvedValue(MINE);

      const { result } = renderHook(() => useTenant(), { wrapper });
      await waitFor(() => expect(result.current.accountResolution).toBe('degraded'));

      await act(async () => {
        result.current.reloadAccounts();
      });

      expect(result.current.accountResolution).toBe('degraded');
    });
  });

  it('does not carry a failure across a tenant switch', async () => {
    setupAuth([TENANT_A, TENANT_B], [TENANT_MEMBERSHIP, mem({ id: 'm-b', tenant_id: 't-b', role: 'viewer' })]);
    mocks.listAccounts.mockRejectedValue(forbidden());
    mocks.listMyAccounts.mockRejectedValue(new Error('Network down'));

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.accountResolution).toBe('error'));

    mocks.listAccounts.mockResolvedValue([ACCOUNT_DEFAULT]);
    act(() => {
      result.current.setActiveTenantId('t-b');
    });

    // An error about the tenant we just left, shown over the new one's screens, is
    // the stale-stated-reason defect.
    await waitFor(() => expect(result.current.accountResolution).toBe('ready'));
    expect(result.current.accountError).toBeNull();
  });
});

// ─── membership resolution ───────────────────────────────────────────────────

describe('membership', () => {
  it('finds active membership for current tenant', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    expect(result.current.membership).toEqual(TENANT_MEMBERSHIP);
  });

  it('returns null when no active membership exists', async () => {
    setupAuth([TENANT_A], [INACTIVE_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    expect(result.current.membership).toBeNull();
  });

  it('when accountId is set, prefers matching account or tenant-level membership', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveAccountId('acct-1');
    });

    // find() returns the first match — tenant-level (account_id: null) or account-level
    expect(result.current.membership).not.toBeNull();
    expect(result.current.membership!.tenant_id).toBe('t-a');
  });
});

// ─── role resolution ─────────────────────────────────────────────────────────

describe('role resolution', () => {
  it('uses tenant-level membership role when present', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    expect(result.current.role).toBe('tenant_owner');
  });

  it('falls back to account-level membership role when no tenant-level exists', async () => {
    setupAuth([TENANT_A], [ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveAccountId('acct-1');
    });

    expect(result.current.role).toBe('operator');
  });

  it('prefers tenant-level role over account-level role', async () => {
    setupAuth([TENANT_A], [TENANT_MEMBERSHIP, ACCOUNT_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    act(() => {
      result.current.setActiveAccountId('acct-1');
    });

    // tenant_owner (tenant-level) takes precedence over operator (account-level)
    expect(result.current.role).toBe('tenant_owner');
  });

  it('is undefined when no matching membership exists', async () => {
    setupAuth([TENANT_A], []);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    expect(result.current.role).toBeUndefined();
  });

  it('ignores inactive memberships for role resolution', async () => {
    setupAuth([TENANT_A], [INACTIVE_MEMBERSHIP]);

    const { result } = renderHook(() => useTenant(), { wrapper });
    await waitFor(() => expect(result.current.tenantId).toBe('t-a'));

    expect(result.current.role).toBeUndefined();
  });
});
