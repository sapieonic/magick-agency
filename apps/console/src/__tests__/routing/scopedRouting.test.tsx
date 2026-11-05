import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import type { Account, Membership, Tenant } from '../../types/auth';

/**
 * The tenant/account-scoped URL, end to end: the real `UrlScopeProvider`, the real
 * `TenantProvider`, `ScopedRouter` and a `ScopeGate` layout route, with only the
 * session (`useAuth`) and the accounts API mocked. Each test starts from a URL put
 * in place with `window.history.replaceState` before mount and reads the address
 * bar (`window.location`) afterwards — the address bar is what a copied link is.
 */

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listAccounts: vi.fn(),
  listMyAccounts: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('../../api/accounts', () => ({
  listAccounts: mocks.listAccounts,
  listMyAccounts: mocks.listMyAccounts,
}));

import { UrlScopeProvider } from '../../contexts/UrlScopeContext';
import { TenantProvider, useTenant } from '../../contexts/TenantContext';
import { ScopedRouter } from '../../components/routing/ScopedRouter';
import { ScopeGate } from '../../components/routing/ScopeGate';
import RequireAuth from '../../components/auth/RequireAuth';
import { RETURN_PATH_PARAM } from '../../utils/returnPath';

// ─── fixtures ────────────────────────────────────────────────────────────────

function tenant(id: string): Tenant {
  return { id, name: id, slug: id, settings: {}, status: 'active', created_at: '', updated_at: '' };
}
function account(id: string, tenantId: string): Account {
  return { id, tenant_id: tenantId, name: id, slug: id, settings: {}, status: 'active', created_at: '', updated_at: '' };
}
function membership(id: string, tenantId: string): Membership {
  return {
    id, user_id: 'u1', tenant_id: tenantId, account_id: null, role: 'tenant_owner', status: 'active',
    invited_by: null, created_at: '', updated_at: '',
  };
}

const TENANTS = [tenant('t-a'), tenant('t-b')];
const MEMBERSHIPS = [membership('m-a', 't-a'), membership('m-b', 't-b')];
const ACCOUNTS: Record<string, Account[]> = {
  't-a': [account('acct-1', 't-a'), account('acct-2', 't-a')],
  't-b': [account('acct-b1', 't-b'), account('acct-b2', 't-b')],
};
const STORAGE_KEY = 'magick-active-tenant';

/** One stable session object, so `tenants` keeps its identity across renders. */
function signIn() {
  mocks.useAuth.mockReturnValue({
    user: { id: 'u1', email: 'u1@example.com' },
    loading: false,
    pendingEmailVerification: false,
    tenants: TENANTS,
    memberships: MEMBERSHIPS,
    defaultAccount: null,
    logout: mocks.logout,
  });
}
function sessionLoading() {
  mocks.useAuth.mockReturnValue({
    user: null,
    loading: true,
    pendingEmailVerification: false,
    tenants: [],
    memberships: [],
    defaultAccount: null,
    logout: mocks.logout,
  });
}
function signOut() {
  mocks.useAuth.mockReturnValue({
    user: null,
    loading: false,
    pendingEmailVerification: false,
    tenants: [],
    memberships: [],
    defaultAccount: null,
    logout: mocks.logout,
  });
}

// ─── the app under test ─────────────────────────────────────────────────────

/** What a page sees: its app path and the context's ids, plus the switchers. */
function Page({ name }: { name: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { tenantId, accountId, setActiveAccountId, setActiveTenantId, reloadAccounts } = useTenant();
  return (
    <div>
      <h1>{name}</h1>
      <p data-testid="app-path">{location.pathname}</p>
      <p data-testid="ids">{`${tenantId}/${accountId}`}</p>
      <Link to="/agency/dnc">DNC link</Link>
      <button type="button" onClick={() => setActiveAccountId('acct-2')}>Switch to acct-2</button>
      <button type="button" onClick={() => setActiveTenantId('t-b')}>Switch to t-b</button>
      <button type="button" onClick={() => navigate('/login')}>Go to login</button>
      <button type="button" onClick={reloadAccounts}>Reload accounts</button>
    </div>
  );
}

function SignInPage({ name }: { name: string }) {
  const location = useLocation();
  return (
    <div>
      <h1>{name}</h1>
      <p data-testid="signin-search">{location.search}</p>
    </div>
  );
}

function TestApp() {
  return (
    <UrlScopeProvider>
      <TenantProvider>
        <ScopedRouter>
          <Routes>
            <Route path="/login" element={<SignInPage name="login page" />} />
            <Route path="/agency/login" element={<SignInPage name="agency login page" />} />
            <Route element={<ScopeGate />}>
              <Route path="/" element={<RequireAuth><Page name="home" /></RequireAuth>} />
              <Route path="/agency/campaigns" element={<RequireAuth><Page name="campaigns" /></RequireAuth>} />
              <Route path="/agency/dnc" element={<RequireAuth><Page name="dnc" /></RequireAuth>} />
              <Route path="/app/settings" element={<RequireAuth><Page name="settings" /></RequireAuth>} />
            </Route>
          </Routes>
        </ScopedRouter>
      </TenantProvider>
    </UrlScopeProvider>
  );
}

function openAt(url: string) {
  window.history.replaceState(null, '', url);
  return render(<TestApp />);
}

const address = () => `${window.location.pathname}${window.location.search}`;
const ids = () => screen.getByTestId('ids').textContent;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.listAccounts.mockImplementation(async (tenantId: string) => ACCOUNTS[tenantId] ?? []);
  mocks.listMyAccounts.mockResolvedValue([]);
  signIn();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  localStorage.clear();
});

// ─── entering a scope ───────────────────────────────────────────────────────

describe('an unscoped URL', () => {
  it('is replaced by the same app path under the active tenant and its first account', async () => {
    openAt('/agency/campaigns');

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/campaigns');
    expect(ids()).toBe('t-a/acct-1');
  });

  it('is replaced, not pushed, so back does not land on the unscoped URL', async () => {
    const before = window.history.length;
    openAt('/agency/campaigns');

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(window.history.length).toBe(before);
  });

  it('keeps the query string when it is scoped', async () => {
    openAt('/agency/campaigns?tab=2');

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(address()).toBe('/t/t-a/a/acct-1/agency/campaigns?tab=2');
  });

  it('scopes the root to the bare prefix', async () => {
    openAt('/');

    await screen.findByRole('heading', { name: 'home' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1');
    expect(screen.getByTestId('app-path').textContent).toBe('/');
  });
});

describe('a scoped URL', () => {
  it('opens the account it names, even when this browser last had another', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-a', accountId: 'acct-1' }));

    openAt('/t/t-a/a/acct-2/agency/campaigns');

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/acct-2');
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/campaigns');
  });

  it('opens a tenant other than the stored one when the URL names it', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-a', accountId: 'acct-1' }));

    openAt('/t/t-b/a/acct-b2/agency/campaigns');

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-b/acct-b2');
    expect(mocks.listAccounts).not.toHaveBeenCalledWith('t-a');
  });
});

describe('a scoped URL opened before the session has loaded', () => {
  it('still opens the tenant and account it names once the session arrives', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: 't-a', accountId: 'acct-1' }));
    sessionLoading();

    const { rerender } = openAt('/t/t-b/a/acct-b2/agency/campaigns');
    expect(screen.queryByRole('heading', { name: 'campaigns' })).toBeNull();
    expect(mocks.listAccounts).not.toHaveBeenCalled();

    signIn();
    rerender(<TestApp />);

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-b/acct-b2');
    expect(window.location.pathname).toBe('/t/t-b/a/acct-b2/agency/campaigns');
  });
});

// ─── moving inside a scope ──────────────────────────────────────────────────

describe('inside a scope', () => {
  it('a <Link> to an app path stays in the scope', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    const link = screen.getByRole('link', { name: 'DNC link' });
    expect(link.getAttribute('href')).toBe('/t/t-a/a/acct-2/agency/dnc');
    fireEvent.click(link);

    await screen.findByRole('heading', { name: 'dnc' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/dnc');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/dnc');
    expect(ids()).toBe('t-a/acct-2');
  });

  it('switching account pushes the new scope, keeping the app path; back restores the old one', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/acct-1');
    const before = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-2' }));

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns'));
    expect(window.history.length).toBe(before + 1);
    expect(ids()).toBe('t-a/acct-2');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/campaigns');

    act(() => window.history.back());

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-1'));
    expect(screen.getByRole('heading', { name: 'campaigns' })).toBeTruthy();
  });

  it('switching tenant lands on the new tenant’s first account at the same app path', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to t-b' }));

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-b/a/acct-b1/agency/campaigns'));
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-b/acct-b1');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/campaigns');
  });

  it('back after a tenant switch returns to the previous tenant and account', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to t-b' }));
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-b/a/acct-b1/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-b/acct-b1'));

    act(() => window.history.back());

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));
    expect(screen.getByRole('heading', { name: 'campaigns' })).toBeTruthy();
  });

  it('reloading accounts after the open one went away re-points the URL at the replacement', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/acct-2');
    const before = window.history.length;
    mocks.listAccounts.mockImplementation(async (tenantId: string) =>
      (ACCOUNTS[tenantId] ?? []).filter((a) => a.id !== 'acct-2'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reload accounts' }));

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-1'));
    // Replaced: back must not return to a link to an account that no longer exists.
    expect(window.history.length).toBe(before);
    expect(screen.queryByText('You can’t open this account')).toBeNull();
  });

  it('navigate("/login") ends on the bare /login, not a scoped one', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Go to login' }));

    await screen.findByRole('heading', { name: 'login page' });
    expect(window.location.pathname).toBe('/login');
  });
});

// ─── links this person cannot open ──────────────────────────────────────────

describe('a scope this person cannot open', () => {
  it('a tenant not in the session is refused, without asking for its accounts', async () => {
    openAt('/t/t-zzz/a/acct-1/agency/campaigns');

    await screen.findByText('You can’t open this workspace');
    expect(screen.queryByRole('heading', { name: 'campaigns' })).toBeNull();
    // The address bar still names what was asked for: nothing was quietly opened.
    expect(window.location.pathname).toBe('/t/t-zzz/a/acct-1/agency/campaigns');
    expect(mocks.listAccounts).not.toHaveBeenCalledWith('t-zzz');
    expect(mocks.listMyAccounts).not.toHaveBeenCalledWith('t-zzz');
  });

  it('"Go to my workspace" lands in a scope the person can open', async () => {
    openAt('/t/t-zzz/a/acct-1/agency/campaigns');
    await screen.findByText('You can’t open this workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Go to my workspace' }));

    await screen.findByRole('heading', { name: 'home' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1');
    expect(ids()).toBe('t-a/acct-1');
  });

  it('an account not in the tenant is refused', async () => {
    openAt('/t/t-a/a/acct-zzz/agency/campaigns');

    await screen.findByText('You can’t open this account');
    expect(screen.queryByRole('heading', { name: 'campaigns' })).toBeNull();
    expect(window.location.pathname).toBe('/t/t-a/a/acct-zzz/agency/campaigns');
  });
});

// ─── signed out ─────────────────────────────────────────────────────────────

describe('signed out on a scoped URL', () => {
  it('goes to the unscoped agency door, carrying the full scoped path in next', async () => {
    signOut();

    openAt('/t/t-a/a/acct-2/agency/campaigns?tab=2');

    await screen.findByRole('heading', { name: 'agency login page' });
    expect(window.location.pathname).toBe('/agency/login');
    const next = new URLSearchParams(window.location.search).get(RETURN_PATH_PARAM);
    expect(next).toBe('/t/t-a/a/acct-2/agency/campaigns?tab=2');
  });

  it('goes to the unscoped primary door for a platform page', async () => {
    signOut();

    openAt('/t/t-a/a/acct-2/app/settings');

    await screen.findByRole('heading', { name: 'login page' });
    expect(window.location.pathname).toBe('/login');
    const next = new URLSearchParams(window.location.search).get(RETURN_PATH_PARAM);
    expect(next).toBe('/t/t-a/a/acct-2/app/settings');
    expect(mocks.listAccounts).not.toHaveBeenCalled();
  });
});
