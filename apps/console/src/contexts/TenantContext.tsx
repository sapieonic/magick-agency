import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useUrlScope } from './UrlScopeContext';
import { listAccounts, listMyAccounts } from '../api/accounts';
import type { Tenant, TenantAccount, Membership, Role } from '../types/auth';

const STORAGE_KEY = 'magick-active-tenant';

/**
 * How account resolution went. **`'error'` is the state this context did not have
 * and needed most.**
 *
 * Every account-scoped context downstream (`FeatureFlagsContext`,
 * `GovernanceContext`) waits on `accountId`, and waiting is indistinguishable
 * from "still loading" — so a resolution that failed produced a spinner that
 * never resolved, with no error, no console message and nothing for the user to
 * act on. An `agent` (role level 5, below `account.read`'s `viewer` floor) hit
 * that on every single sign-in: 403 from `GET /accounts`, swallowed here, spinner
 * forever.
 *
 * The fallback route below fixes that one cause. This status fixes the *class* —
 * any failure to resolve now terminates somewhere a screen can render a sentence.
 */
export type AccountResolution = 'loading' | 'ready' | 'degraded' | 'error';

/**
 * Whether a failed `GET /accounts` means "you are allowed less" or "we are
 * broken", and therefore whether the narrower fallback result can be trusted as
 * the whole truth.
 *
 * **This is a trust classification, not a routing decision.** The fallback runs on
 * *any* rejection and deliberately still does — see `resolveAccounts` — because
 * recovery must not depend on a status code. What the code buys is the ability to
 * tell the user afterwards whether the list they are looking at is complete.
 *
 * ── Why 403 specifically, and why it is safe to lean on it here ──────────────
 * A 403 from `requirePermission('account.read')` is a *correct* refusal for a role
 * below `viewer`, and `/accounts/mine` is then the right and complete answer for
 * that user — nothing is missing and there is nothing to warn about. Any other
 * failure (502, 504, a dropped connection during a server restart, a masked 500)
 * says nothing about the caller's permissions, so the narrower list is a
 * *degraded* view of someone who should see more.
 *
 * The trade-off the reviewer is owed explicitly: the server masks internal error
 * detail, so a status code is a weaker signal than it looks. This design is built
 * to survive that being wrong in the direction that matters. Masking replaces the
 * *body*, not the status (`@magick-agency/web-ui/errors`), and an RBAC 403 is one of the "our
 * own business 4xx" the mask passes through intact — but even if a status arrives
 * unrecognisable, `unknown` falls to **degraded**, i.e. the visible, retryable
 * state. The failure mode of a misread is therefore an extra warning banner for an
 * agent who did not need one, never a silently narrowed admin. Defaulting the
 * other way — treating anything unrecognised as a legitimate narrowing — is the
 * bug this whole item is about.
 */
function isPermissionRefusal(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const status = (err as { statusCode?: unknown }).statusCode;
  return status === 403;
}

interface TenantContextValue {
  activeTenant: Tenant | null;
  tenantId: string | null;
  accountId: string | null;
  accounts: TenantAccount[];
  membership: Membership | null;
  role: Role | undefined;
  /**
   * `'ready'` means an authoritative account list came back — **including an empty
   * one**, which is a legitimate answer for a tenant with no accounts and must not
   * be reported as a failure. `'degraded'` means we are showing the caller's own
   * memberships because `GET /accounts` failed for a reason that was **not** a
   * permission refusal, so the list may be incomplete and is worth retrying.
   * `'error'` means neither route answered.
   */
  accountResolution: AccountResolution;
  /** What to tell the user when `accountResolution` is `'error'` or `'degraded'`. */
  accountError: string | null;
  setActiveTenantId: (id: string) => void;
  setActiveAccountId: (id: string | null) => void;
  reloadAccounts: () => void;
}

const TenantContext = createContext<TenantContextValue | null>(null);

/**
 * ── The URL is the source of truth for the active tenant and account ────────
 * A signed-in page's URL is scoped, `/t/:tenantId/a/:accountId/…` (see
 * `utils/urlScope`), so a link copied from the address bar opens the same tenant
 * and account for whoever it is sent to. This provider follows that scope:
 *
 *  - **URL → state.** A scope in the URL is adopted, on load and whenever it
 *    changes (a pasted link, the back button). An account the URL names is
 *    preferred over the one this browser last used.
 *  - **state → URL.** `setActiveTenantId` and `setActiveAccountId` (the switchers)
 *    move the URL as well as the state, so the address bar never names an
 *    account other than the one on screen. A tenant switch leaves the scope
 *    (the new tenant's account is not known until its accounts load) and
 *    `ScopeGate` re-enters it once one is picked.
 *
 * `localStorage` is still written and read, as the fallback for a URL that names
 * no scope (an old `/dialer` bookmark, `/` after sign-in) or one this person
 * cannot open.
 *
 * A URL naming a tenant or account the caller cannot open is NOT adopted — the
 * fallback below picks one they can — and `ScopeGate` says so instead of quietly
 * showing another account's data under a link that promised something else.
 */
export function TenantProvider({ children }: { children: ReactNode }) {
  const { tenants, memberships, user } = useAuth();
  const { scope: urlScope, go } = useUrlScope();
  /** The URL's scope NOW, for async work and callbacks that must not re-run on it. */
  const urlScopeRef = useRef(urlScope);
  urlScopeRef.current = urlScope;

  const [activeTenantId, setActiveTenantIdState] = useState<string | null>(() => {
    if (urlScope) return urlScope.tenantId;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as { tenantId?: string };
        return parsed.tenantId ?? null;
      } catch { return null; }
    }
    return null;
  });

  /** The account chosen in state: by the switchers, the restore, or the fallback. */
  const [selectedAccountId, setActiveAccountIdState] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<TenantAccount[]>([]);
  const [accountResolution, setAccountResolution] = useState<AccountResolution>('loading');
  const [accountError, setAccountError] = useState<string | null>(null);
  const accountsLoadedForTenant = useRef<string | null>(null);
  /** The tenant active NOW, for async work that started under another one. */
  const activeTenantRef = useRef<string | null>(activeTenantId);
  useEffect(() => { activeTenantRef.current = activeTenantId; }, [activeTenantId]);

  /**
   * The active account is DERIVED, in render, from the URL whenever the URL names
   * a listed account of the active tenant, and only otherwise from state.
   *
   * It used to be copied from the URL into state by an effect keyed on the URL's
   * scope, and every gap between the two was a defect: an account switch followed
   * by a `navigate()` in the same handler left state on one account and the URL on
   * the other with no scope change for the effect to see, so `ScopeGate` waited
   * forever; a retry that loaded the URL's account had nothing to adopt it; and
   * back/forward between two accounts spent one render on the old account, which
   * the gate covered with a spinner and so remounted every page. Deriving it
   * leaves nothing to fall out of step: the address bar is the answer the moment
   * it names an account this person has.
   *
   * State still matters when the URL is unscoped, or names an account that is not
   * in the list (`ScopeGate` refuses that link; state is what "Go to my
   * workspace" opens).
   */
  const urlAccountId =
    urlScope &&
    urlScope.tenantId === activeTenantId &&
    accounts.some(a => a.id === urlScope.accountId)
      ? urlScope.accountId
      : null;
  const activeAccountId = urlAccountId ?? selectedAccountId;

  /**
   * Resolve the tenant's accounts, **preferring the full list and falling back to
   * the caller's own**.
   *
   * Deliberately a fallback rather than a replacement. `GET /accounts` returns
   * whole `Account` rows and is what an `account_admin` already has; switching
   * everyone to `/accounts/mine` would silently strip `slug`, `settings` and
   * `status` from the switcher for every role that can see them today — a
   * regression for the many to fix a break for the few. `/accounts/mine` is
   * narrower on purpose (it skips the permission check), so it is what we reach
   * for only once the permissioned route has said no.
   *
   * The fallback runs on **any** failure of the first call, not on a 403
   * specifically: the server masks upstream errors, so keying off a status code makes
   * recovery depend on a detail the error contract does not promise to preserve —
   * and a second attempt at a cheaper route costs one request on a path that has
   * already failed.
   *
   * ── But narrowing is now CLASSIFIED, which it was not ───────────────────────
   * Falling back on any failure is right for recovery and was wrong for honesty.
   * An `account_admin` signing in during a server restart or a timeout got
   * `/accounts/mine` — only their own memberships, without `slug`/`settings`/
   * `status` — while `accountResolution` said `'ready'`. No warning, no retry
   * offered, the narrowed selection written to `localStorage`, and
   * `accountsLoadedForTenant` set so the effect never fired again: the only escapes
   * were a tenant switch or a page reload, neither of which the user has any reason
   * to try because nothing told them anything was wrong.
   *
   * So the second element: `degraded` is true when the fallback carried us **and**
   * the first failure was not a permission refusal. A 403 is a legitimate
   * narrowing — the caller genuinely has fewer accounts — and warning about it
   * would cry wolf at every agent on every sign-in.
   */
  const resolveAccounts = useCallback(
    async (
      tenantId: string,
    ): Promise<{ accounts: TenantAccount[]; degraded: boolean; cause: unknown }> => {
      try {
        return { accounts: await listAccounts(tenantId), degraded: false, cause: null };
      } catch (err) {
        return {
          accounts: await listMyAccounts(tenantId),
          degraded: !isPermissionRefusal(err),
          cause: err,
        };
      }
    },
    [],
  );

  // Auto-select first tenant if none selected, or reset if stored tenant is invalid
  useEffect(() => {
    if (tenants.length === 0) return;
    const isValid = activeTenantId && tenants.some(t => t.id === activeTenantId);
    if (!isValid) {
      const first = tenants[0];
      if (first) setActiveTenantIdState(first.id);
    }
  }, [activeTenantId, tenants]);

  /**
   * URL → state: adopt the scope a navigation brought in (a pasted link, the back
   * button, a link from another tab's address bar).
   *
   * Keyed on the scope's identity, which changes only when the tenant or account
   * in the URL does — never on the state it sets — so it cannot fight the
   * switchers, which move the URL and the state together. A tenant the caller is
   * not a member of is not adopted; `ScopeGate` reports it.
   */
  useEffect(() => {
    if (!urlScope) return;
    if (urlScope.tenantId !== activeTenantRef.current) {
      if (tenants.length > 0 && !tenants.some(t => t.id === urlScope.tenantId)) return;
      setActiveTenantIdState(urlScope.tenantId);
      setActiveAccountIdState(null);
      setAccounts([]);
      setAccountResolution('loading');
      setAccountError(null);
      accountsLoadedForTenant.current = null;
    }
    // The ACCOUNT needs no adopting: it is derived from the URL (see
    // `activeAccountId`). `tenants` is read for the membership check only: a scope
    // that arrives before the session does is adopted, and `tenants` arriving later
    // must not re-run this.
  }, [urlScope]);

  /**
   * Keep the selection on the account the URL is showing, so that leaving the
   * scope (a tenant switch, an unscoped bookmark) carries on from the account the
   * user was last looking at rather than one they navigated away from.
   */
  useEffect(() => {
    if (urlAccountId && urlAccountId !== selectedAccountId) setActiveAccountIdState(urlAccountId);
  }, [urlAccountId, selectedAccountId]);

  // Load accounts when tenant changes, then validate/set accountId
  // Gate on `user` to ensure Firebase auth token is available for apiFetch
  useEffect(() => {
    if (!activeTenantId || !user) {
      setAccounts([]);
      setActiveAccountIdState(null);
      // Not an error — there is nothing to resolve yet, and saying "we couldn't
      // find your account" before sign-in completes would be a lie with a Retry
      // button on it.
      setAccountResolution('loading');
      setAccountError(null);
      accountsLoadedForTenant.current = null;
      return;
    }

    // Prevent duplicate fetches for the same tenant
    if (accountsLoadedForTenant.current === activeTenantId) return;
    // A tenant the session does not list (a stale stored id, or a link to a
    // tenant this person is not in): the effect above is about to replace it, and
    // asking the server for its accounts would only produce a 403 and an error.
    if (tenants.length > 0 && !tenants.some(t => t.id === activeTenantId)) return;

    // Clear account immediately on tenant switch to prevent stale accountId in API calls
    setActiveAccountIdState(null);
    setAccountResolution('loading');
    setAccountError(null);
    accountsLoadedForTenant.current = activeTenantId;

    resolveAccounts(activeTenantId)
      .then(({ accounts: fetchedAccounts, degraded, cause }) => {
        // Guard: only apply if tenant hasn't changed during the fetch
        if (accountsLoadedForTenant.current !== activeTenantId) return;

        setAccounts(fetchedAccounts);
        // An empty list is a real answer, not a failure: a tenant can genuinely
        // have no accounts, and `AgencyLayout` already has copy for that. Marking
        // it `'error'` would put a retry button in front of a state retrying
        // cannot change.
        //
        // `'degraded'` is not `'error'` either, and the distinction is the point: we
        // have a usable account list, so blocking the whole app behind
        // `AccountUnavailable` would be a worse outcome than the narrowing it was
        // reporting. The user works; the switcher says the list may be short and
        // offers the retry.
        setAccountResolution(degraded ? 'degraded' : 'ready');
        setAccountError(
          degraded
            ? cause instanceof Error
              ? cause.message
              : 'Could not load the full account list.'
            : null,
        );

        // The account the URL names wins: that is what a shared link is for.
        const scoped = urlScopeRef.current;
        const urlAccountId = scoped && scoped.tenantId === activeTenantId ? scoped.accountId : null;
        if (urlAccountId && fetchedAccounts.some(a => a.id === urlAccountId)) {
          setActiveAccountIdState(urlAccountId);
          return;
        }

        // Then the one this browser last had open.
        const stored = localStorage.getItem(STORAGE_KEY);
        let storedAccountId: string | null = null;
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as { tenantId?: string; accountId?: string };
            if (parsed.tenantId === activeTenantId) {
              storedAccountId = parsed.accountId ?? null;
            }
          } catch { /* ignore */ }
        }

        // Validate stored accountId belongs to this tenant's accounts
        const validStored = storedAccountId && fetchedAccounts.some(a => a.id === storedAccountId);
        // There is no session `default_account` fallback: that field exists only
        // on session path 4 (a brand-new tenant), which agency refuses with 403
        // `no_membership`.
        if (validStored) {
          setActiveAccountIdState(storedAccountId);
        } else if (fetchedAccounts.length > 0) {
          setActiveAccountIdState(fetchedAccounts[0]!.id);
        }
      })
      .catch((err: unknown) => {
        /**
         * **Both routes failed, and that is now said out loud.**
         *
         * This used to swallow the rejection and "proceed with empty accounts",
         * which is not proceeding at all: `activeAccountId` stays null, every
         * account-scoped hook keeps its `if (!accountId) return` guard, and
         * `FeatureFlagsContext` holds `status: 'loading'` for the life of the
         * session. The user gets a spinner with no error, nothing in the console
         * and no way to tell a slow network from a permission problem.
         *
         * Recording a terminal state instead is the half that matters: the
         * `/accounts/mine` fallback above removes one cause, this one makes every
         * remaining cause visible.
         */
        if (accountsLoadedForTenant.current !== activeTenantId) return;
        setAccounts([]);
        setAccountResolution('error');
        setAccountError(err instanceof Error ? err.message : 'Could not load your accounts.');
      });
  }, [activeTenantId, user, tenants, resolveAccounts]);

  /**
   * Persist to localStorage only when both are valid **and the list is trusted**.
   *
   * The `'degraded'` exclusion is what stops a transient outage becoming a durable
   * one. The selection made from a narrowed list is a real account the user can
   * work in, so it is fine *for this session* — but writing it to storage makes it
   * the value the next session restores, and the restore path validates only that
   * the id is present in whatever list came back. A five-second the server restart
   * would otherwise pin an `account_admin` to one account across reloads, with the
   * evidence of why long gone.
   */
  useEffect(() => {
    if (activeTenantId && activeAccountId && accountResolution !== 'degraded') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tenantId: activeTenantId, accountId: activeAccountId }));
    }
  }, [activeTenantId, activeAccountId, accountResolution]);

  const activeTenant = tenants.find(t => t.id === activeTenantId) ?? null;

  const membership = memberships.find(m =>
    m.tenant_id === activeTenantId && m.status === 'active' &&
    (activeAccountId ? m.account_id === activeAccountId || m.account_id === null : true)
  ) ?? null;

  // For role resolution: prefer tenant-level membership, then account-level
  const tenantMembership = memberships.find(m =>
    m.tenant_id === activeTenantId && m.account_id === null && m.status === 'active'
  );
  const accountMembership = activeAccountId
    ? memberships.find(m => m.tenant_id === activeTenantId && m.account_id === activeAccountId && m.status === 'active')
    : null;
  const role = tenantMembership?.role ?? accountMembership?.role;

  /**
   * Switch tenant. On a scoped page this also LEAVES the scope, keeping the app
   * path: the new tenant's account is not known until its accounts load, and
   * `ScopeGate` puts the URL back under `/t/<new>/a/<account>` once it is.
   */
  const setActiveTenantId = useCallback((id: string) => {
    if (urlScopeRef.current && urlScopeRef.current.tenantId !== id) go(null);
    setActiveTenantIdState(id);
    setActiveAccountIdState(null);
    setAccounts([]);
    // A failure belonged to the tenant we just left. Carrying it across would
    // show the new tenant's screens an error about the old one's accounts.
    setAccountResolution('loading');
    setAccountError(null);
    accountsLoadedForTenant.current = null; // Force re-fetch for new tenant
  }, [go]);

  /**
   * Switch account. On a scoped page the URL moves with it — pushed, so the back
   * button returns to the account the user came from — keeping the app path.
   */
  const setActiveAccountId = useCallback((id: string | null) => {
    setActiveAccountIdState(id);
    const tenant = activeTenantRef.current;
    if (id && tenant && urlScopeRef.current) go({ tenantId: tenant, accountId: id });
  }, [go]);

  /**
   * Re-resolve. Doubles as the **Retry** behind the terminal error screen, which
   * is why it clears the failure and re-selects an account rather than only
   * refreshing the list: after a failed first resolution there is no active
   * account to preserve, and a retry that reloaded the list without selecting one
   * would land the user straight back on the spinner it replaced.
   */
  const reloadAccounts = useCallback(() => {
    if (!activeTenantId) return;
    const forTenant = activeTenantId;
    setAccountError(null);
    resolveAccounts(forTenant)
      .then(({ accounts: fetched, degraded, cause }) => {
        // The person switched tenant while this was in flight (the Accounts page reloads
        // after every create): this list is the OLD tenant's, and applying it would put
        // its accounts in the new tenant's switcher.
        if (activeTenantRef.current !== forTenant) return;
        setAccounts(fetched);
        // A retry that succeeds through the fallback is **still degraded** — it must
        // not report `'ready'` and take the warning down over a list that is just as
        // narrow as the one the user asked us to re-check. That would turn the retry
        // into a way of dismissing the notice rather than of fixing it.
        setAccountResolution(degraded ? 'degraded' : 'ready');
        setAccountError(
          degraded
            ? cause instanceof Error
              ? cause.message
              : 'Could not load the full account list.'
            : null,
        );
        // The account the URL names, when the fresh list has it. This is the
        // Retry behind "You can't open this account" for a narrowed list and
        // behind `AccountUnavailable` after an outage: in both the link named an
        // account, and opening the first one instead would break the promise the
        // link made.
        const scoped = urlScopeRef.current;
        if (
          scoped &&
          scoped.tenantId === forTenant &&
          fetched.some(a => a.id === scoped.accountId)
        ) {
          setActiveAccountIdState(scoped.accountId);
          return;
        }
        // If the currently active account was deleted — or was never resolved at
        // all — switch to the first available.
        if (!activeAccountId || !fetched.some(a => a.id === activeAccountId)) {
          const replacement = fetched[0]?.id ?? null;
          setActiveAccountIdState(replacement);
          // The URL named the account that went away; point it at the one now
          // open rather than leave a link to nothing in the address bar.
          if (replacement && urlScopeRef.current) {
            go({ tenantId: forTenant, accountId: replacement }, undefined, { replace: true });
          }
        }
      })
      .catch((err: unknown) => {
        if (activeTenantRef.current !== forTenant) return;
        setAccountResolution('error');
        setAccountError(err instanceof Error ? err.message : 'Could not load your accounts.');
      });
  }, [activeTenantId, activeAccountId, resolveAccounts, go]);

  // Stable between renders that change none of these, so a re-render above the
  // provider does not re-render every `useTenant()` consumer.
  const value = useMemo<TenantContextValue>(
    () => ({
      activeTenant,
      tenantId: activeTenantId,
      accountId: activeAccountId,
      accounts,
      membership,
      role,
      accountResolution,
      accountError,
      setActiveTenantId,
      setActiveAccountId,
      reloadAccounts,
    }),
    [
      activeTenant,
      activeTenantId,
      activeAccountId,
      accounts,
      membership,
      role,
      accountResolution,
      accountError,
      setActiveTenantId,
      setActiveAccountId,
      reloadAccounts,
    ],
  );

  return (
    <TenantContext.Provider value={value}>
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant(): TenantContextValue {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used within TenantProvider');
  return ctx;
}
