import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import type { Account, Membership, Tenant } from '../../types/auth';

/**
 * The tenant/account-scoped URL, end to end: the real `UrlScopeProvider`, the real
 * `TenantProvider`, `ScopedRouter` and a `ScopeGate` layout route, with only the
 * session (`useAuth`) and the accounts API mocked. Each test starts from a URL put
 * in place with `window.history.replaceState` before mount and reads the address
 * bar (`window.location`) afterwards — the address bar is what a copied link is.
 *
 * A tenant or account switch on an app page is a full page load (`utils/pageLoad`),
 * which jsdom-style environments cannot perform: it is mocked, and the URL it was
 * asked to load is what those tests read.
 */

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  listAccounts: vi.fn(),
  listMyAccounts: vi.fn(),
  logout: vi.fn(),
  loadPage: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: mocks.useAuth,
}));

vi.mock('../../api/accounts', () => ({
  listAccounts: mocks.listAccounts,
  listMyAccounts: mocks.listMyAccounts,
}));

vi.mock('../../utils/pageLoad', () => ({
  loadPage: mocks.loadPage,
}));

import { UrlScopeProvider, useUrlScope } from '../../contexts/UrlScopeContext';
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

/**
 * How many times each page has MOUNTED. A page torn down and built again (the gate
 * swapping it for a spinner for a render) counts twice; a page that only
 * re-renders counts once.
 */
const mounts = new Map<string, number>();

/** What a page sees: its app path and the context's ids, plus the switchers. */
function Page({ name }: { name: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const { go } = useUrlScope();
  const { tenantId, accountId, setActiveAccountId, setActiveTenantId, reloadAccounts } = useTenant();
  useEffect(() => {
    mounts.set(name, (mounts.get(name) ?? 0) + 1);
  }, [name]);
  return (
    <div>
      <h1>{name}</h1>
      <p data-testid="app-path">{location.pathname}</p>
      <p data-testid="ids">{`${tenantId}/${accountId}`}</p>
      <Link to="/agency/dnc">DNC link</Link>
      <button type="button" onClick={() => setActiveAccountId('acct-1')}>Switch to acct-1</button>
      <button type="button" onClick={() => setActiveAccountId('acct-2')}>Switch to acct-2</button>
      {/* A switch that names where it lands, as the soft phone's "Go to station"
          does for a session in a sibling account. */}
      <button type="button" onClick={() => setActiveAccountId('acct-1', { path: '/agency/dnc' })}>
        Switch to acct-1 at DNC
      </button>
      <button type="button" onClick={() => setActiveAccountId('acct-2', { path: '/agency/dnc' })}>
        Switch to acct-2 at DNC
      </button>
      <button type="button" onClick={() => setActiveTenantId('t-a')}>Switch to t-a</button>
      <button type="button" onClick={() => setActiveTenantId('t-b')}>Switch to t-b</button>
      {/* An in-app scope move and a navigation in ONE handler: the router's
          basename is stale for the navigate(). */}
      <button
        type="button"
        onClick={() => {
          go({ tenantId: 't-a', accountId: 'acct-2' });
          navigate('/agency/dnc');
        }}
      >
        Move to acct-2 and open DNC
      </button>
      <button type="button" onClick={() => navigate('/login')}>Go to login</button>
      <button type="button" onClick={reloadAccounts}>Reload accounts</button>
    </div>
  );
}

/**
 * An invite landing (`/join/:token`, unscoped): a claim records the tenant it
 * joined, then navigates into the app — what `useInviteClaim` does.
 */
function JoinStub() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { tenantId, setActiveTenantId } = useTenant();
  return (
    <div>
      <h1>join page</h1>
      <p data-testid="join-token">{token}</p>
      <p data-testid="join-tenant">{tenantId}</p>
      <button
        type="button"
        onClick={() => {
          setActiveTenantId('t-b');
          navigate('/agency/dnc', { replace: true });
        }}
      >
        Claim t-b and open DNC
      </button>
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

function TestApp({ strict = false }: { strict?: boolean }) {
  const app = (
    <UrlScopeProvider>
      <TenantProvider>
        <ScopedRouter>
          <Routes>
            <Route path="/login" element={<SignInPage name="login page" />} />
            <Route path="/agency/login" element={<SignInPage name="agency login page" />} />
            <Route path="/join/:token" element={<JoinStub />} />
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
  return strict ? <StrictMode>{app}</StrictMode> : app;
}

function openAt(url: string, { strict = false }: { strict?: boolean } = {}) {
  window.history.replaceState(null, '', url);
  return render(<TestApp strict={strict} />);
}

const address = () => `${window.location.pathname}${window.location.search}`;
const ids = () => screen.getByTestId('ids').textContent;

/**
 * The browser moving to `url` on its own — a back/forward entry, or another tab's
 * link — as a POP the app did not push.
 */
function popTo(url: string) {
  act(() => {
    window.history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

/** What `setActiveTenantId` records as this browser's choice. */
const storedTenant = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as unknown;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mounts.clear();
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

  it('switching account loads the new account’s home, not the page the user was on', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/acct-1');
    const before = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-2' }));

    // A campaign of acct-1 is not one of acct-2's: the load is at its home.
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledWith('/t/t-a/a/acct-2');
    // Nothing moves in place: the load replaces the document.
    await act(async () => {});
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(window.history.length).toBe(before);
    expect(ids()).toBe('t-a/acct-1');
    expect(screen.getByTestId('app-path').textContent).toBe('/agency/campaigns');
  });

  it('switching account with a path loads that path under the new account', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-2 at DNC' }));

    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledWith('/t/t-a/a/acct-2/agency/dnc');
    await act(async () => {});
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(ids()).toBe('t-a/acct-1');
  });

  it('choosing the account already open is not a switch: nothing loads, and a path is followed in place', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    const before = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-1' }));
    await act(async () => {});
    expect(mocks.loadPage).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(window.history.length).toBe(before);

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-1 at DNC' }));

    await screen.findByRole('heading', { name: 'dnc' });
    expect(mocks.loadPage).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/dnc');
    // Pushed, like any in-app move: back returns to the campaigns page.
    expect(window.history.length).toBe(before + 1);
    expect(ids()).toBe('t-a/acct-1');
  });

  it('switching tenant records it and loads the root, which opens it at its home', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    const before = window.history.length;

    fireEvent.click(screen.getByRole('button', { name: 'Switch to t-b' }));

    expect(storedTenant()).toEqual({ tenantId: 't-b' });
    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledWith('/');
    // Nothing moves in place, and nothing overwrites the recorded choice before the load.
    await act(async () => {});
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(window.history.length).toBe(before);
    expect(ids()).toBe('t-a/acct-2');
    expect(storedTenant()).toEqual({ tenantId: 't-b' });
  });

  it('choosing the tenant already open is not a switch', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to t-a' }));
    await act(async () => {});

    expect(mocks.loadPage).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(ids()).toBe('t-a/acct-2');
  });

  it('a back/forward entry naming another tenant is adopted in place', async () => {
    openAt('/t/t-a/a/acct-2/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    popTo('/t/t-b/a/acct-b1/agency/campaigns');
    await waitFor(() => expect(ids()).toBe('t-b/acct-b1'));

    act(() => window.history.back());

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));
    expect(screen.getByRole('heading', { name: 'campaigns' })).toBeTruthy();
    expect(mocks.loadPage).not.toHaveBeenCalled();
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

// ─── review fixes (9068451): state and URL must not drift apart ──────────────

/** A failure that is NOT a permission refusal: the narrowed list is `'degraded'`. */
function outage(): Error {
  return Object.assign(new Error('Bad gateway'), { statusCode: 502 });
}

describe('a scope move and a navigate() in one handler', () => {
  it('go() to another account then navigate lands on that account at the new path', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Move to acct-2 and open DNC' }));

    // Without the rescoping navigator the navigate() joins the STALE basename and
    // pushes `/t/t-a/a/acct-1/agency/dnc`, back in the account just left.
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/dnc'));
    await screen.findByRole('heading', { name: 'dnc' });
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    expect(ids()).toBe('t-a/acct-2');
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });
});

describe('a tenant switch on an unscoped page (the invite claim)', () => {
  it('only records the tenant, and the next app page is scoped under it', async () => {
    openAt('/join/tok-1');
    await screen.findByRole('heading', { name: 'join page' });
    expect(screen.getByTestId('join-tenant').textContent).toBe('t-a');

    fireEvent.click(screen.getByRole('button', { name: 'Claim t-b and open DNC' }));

    await screen.findByRole('heading', { name: 'dnc' });
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-b/a/acct-b1/agency/dnc'));
    expect(ids()).toBe('t-b/acct-b1');
    // No reload: the claim's own navigation carries the user into the app.
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });
});

describe('a retry opens the account the link names', () => {
  it('"Try again" on a narrowed list that lacked the account opens it once the full list loads', async () => {
    mocks.listAccounts.mockRejectedValue(outage());
    mocks.listMyAccounts.mockImplementation(async (tenantId: string) =>
      (ACCOUNTS[tenantId] ?? []).filter((a) => a.id === 'acct-1'),
    );
    openAt('/t/t-a/a/acct-2/agency/campaigns');

    await screen.findByText('You can’t open this account');
    const retry = screen.getByRole('button', { name: 'Try again' });

    mocks.listAccounts.mockImplementation(async (tenantId: string) => ACCOUNTS[tenantId] ?? []);
    fireEvent.click(retry);

    // Before the fix the context stayed on acct-1 and the gate waited forever.
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/acct-2');
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(screen.queryByText('You can’t open this account')).toBeNull();
  });

  it('a retry after an outage keeps the linked account rather than opening the first', async () => {
    mocks.listAccounts.mockRejectedValue(outage());
    mocks.listMyAccounts.mockRejectedValue(outage());
    openAt('/t/t-a/a/acct-2/agency/campaigns');

    // Resolution 'error': the gate renders the page, which owns the retry.
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(ids()).toBe('t-a/null');

    mocks.listAccounts.mockImplementation(async (tenantId: string) => ACCOUNTS[tenantId] ?? []);
    mocks.listMyAccounts.mockImplementation(async (tenantId: string) => ACCOUNTS[tenantId] ?? []);
    fireEvent.click(screen.getByRole('button', { name: 'Reload accounts' }));

    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(screen.getByRole('heading', { name: 'campaigns' })).toBeTruthy();
  });
});

describe('a cold load of a scoped sign-in URL', () => {
  it.each([
    ['without StrictMode', false],
    ['under StrictMode', true],
  ])('lands on the bare sign-in page, not a blank one (%s)', async (_label, strict) => {
    signOut();

    openAt('/t/x/a/y/login?next=%2Fdialer', { strict });

    await screen.findByRole('heading', { name: 'login page' });
    expect(address()).toBe('/login?next=%2Fdialer');
    expect(screen.getByTestId('signin-search').textContent).toBe('?next=%2Fdialer');
  });
});

describe('back/forward between accounts', () => {
  /**
   * "No tear-down" is asserted as the page's MOUNT count. The page sits under the
   * gate's `<Outlet />`; react-router keeps the same element at the same position
   * across a basename change, so the only way the page can mount a second time is
   * the gate replacing it with its spinner for a render (which unmounts it) and then
   * rendering it again. A count of 1 after the round trip therefore means the gate
   * never swapped it out, which is the defect: before the fix the URL moved on POP
   * one render ahead of the context, the gate waited, and every page was rebuilt.
   */
  it('does not tear the page down', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns');
    await screen.findByRole('heading', { name: 'campaigns' });
    expect(mounts.get('campaigns')).toBe(1);

    // A switch reloads, so an entry for another account arrives by POP.
    popTo('/t/t-a/a/acct-2/agency/campaigns');
    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));
    expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns');
    expect(mounts.get('campaigns')).toBe(1);

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-1'));

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));

    expect(mounts.get('campaigns')).toBe(1);
    expect(mocks.loadPage).not.toHaveBeenCalled();
  });
});

describe('under StrictMode', () => {
  it('an unscoped URL is scoped to the active account', async () => {
    openAt('/agency/campaigns', { strict: true });

    await screen.findByRole('heading', { name: 'campaigns' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(ids()).toBe('t-a/acct-1');
  });

  it('an account switch loads the new account’s home, once, and moves nothing in place', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns', { strict: true });
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to acct-2' }));

    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledWith('/t/t-a/a/acct-2');
    await act(async () => {});
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
    expect(ids()).toBe('t-a/acct-1');
  });

  it('a tenant switch records it and loads the root, once', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns', { strict: true });
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Switch to t-b' }));

    expect(mocks.loadPage).toHaveBeenCalledTimes(1);
    expect(mocks.loadPage).toHaveBeenCalledWith('/');
    await act(async () => {});
    expect(storedTenant()).toEqual({ tenantId: 't-b' });
    expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns');
  });

  it('back/forward to another account is adopted without tearing the page down', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns', { strict: true });
    await screen.findByRole('heading', { name: 'campaigns' });
    const mounted = mounts.get('campaigns');

    popTo('/t/t-a/a/acct-2/agency/campaigns');
    await waitFor(() => expect(ids()).toBe('t-a/acct-2'));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-1/agency/campaigns'));
    await waitFor(() => expect(ids()).toBe('t-a/acct-1'));
    expect(screen.getByRole('heading', { name: 'campaigns' })).toBeTruthy();
    // StrictMode mounts twice up front; no further mount means no tear-down.
    expect(mounts.get('campaigns')).toBe(mounted);
  });

  it('go() to another account then navigate in one handler lands on that account', async () => {
    openAt('/t/t-a/a/acct-1/agency/campaigns', { strict: true });
    await screen.findByRole('heading', { name: 'campaigns' });

    fireEvent.click(screen.getByRole('button', { name: 'Move to acct-2 and open DNC' }));

    await waitFor(() => expect(window.location.pathname).toBe('/t/t-a/a/acct-2/agency/dnc'));
    await screen.findByRole('heading', { name: 'dnc' });
    expect(ids()).toBe('t-a/acct-2');
  });
});
