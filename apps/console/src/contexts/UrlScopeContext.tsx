import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { UNSAFE_createBrowserHistory, type Location, type NavigationType } from 'react-router-dom';
import { currentPath } from '../utils/returnPath';
import { parseUrlScope, scopePrefixOf, stripUrlScope, withUrlScope, type UrlScope } from '../utils/urlScope';

type BrowserHistory = ReturnType<typeof UNSAFE_createBrowserHistory>;

/**
 * The browser history, and the tenant/account scope its current URL carries.
 *
 * ── Why the history lives here and not in the router ───────────────────────
 * The scope is read by `TenantProvider`, which has to sit ABOVE the router: the
 * router's basename is the scope prefix, so it changes whenever the scope does,
 * and it renders nothing for the instant a scoped URL strays onto a sign-in page
 * (`ScopedRouter`). Anything mounted under it would be torn down with it. Owning
 * the history here lets the providers read the URL while `ScopedRouter` stays a
 * thin `<Router>` over the same history.
 *
 * `go` moves between scopes in place. Inside a scope, plain `navigate('/agency/…')`
 * keeps the current one (the basename prefixes it), and react-router cannot
 * navigate outside its own basename at all — so the gate that pins an unscoped URL
 * to the active account, and the way out of a refused link, come through here. A
 * tenant or account SWITCH does not: it is a full page load (`TenantContext`).
 *
 * The router joins `navigate()` to the basename it was rendered with, so a
 * `navigate()` in the same handler as a `go()` to another scope lands back in the
 * old one. Do one or the other; `go` takes the path.
 */
export interface UrlScopeValue {
  /** The scope in the URL, or `null` on an unscoped page. */
  scope: UrlScope | null;
  /** `/t/<tenant>/a/<account>` as written in the URL, or `''`. */
  prefix: string;
  /** `null` outside a provider. `ScopedRouter` hands it to react-router as its navigator. */
  history: BrowserHistory | null;
  /**
   * Go to `path` (an app path, e.g. `/agency/campaigns`) under `scope`, or
   * unscoped when `scope` is `null`. Defaults to the current app path, so
   * `go(next)` re-points the page the user is on at another account.
   */
  go: (scope: UrlScope | null, path?: string, options?: { replace?: boolean }) => void;
}

/** The current location, which only the router needs: it changes on every navigation. */
export interface UrlLocationValue {
  location: Location;
  action: NavigationType;
}

/**
 * Outside a provider (unit tests that render a page or a guard on its own) there
 * is no URL to scope, and moving between scopes is a no-op. Only readers fall back
 * to this: `TenantProvider`, whose switches load pages, requires the provider
 * (`useUrlHistory`).
 */
const UNSCOPED: UrlScopeValue = {
  scope: null,
  prefix: '',
  history: null,
  go: () => {},
};

/**
 * Two contexts, split by how often they change. The scope value changes only when
 * the URL's tenant or account does, so `TenantProvider` and the gates that read it
 * do not re-render on every in-app navigation; the location changes on every one,
 * and only `ScopedRouter` reads it.
 */
const UrlScopeContext = createContext<UrlScopeValue>(UNSCOPED);
const UrlLocationContext = createContext<UrlLocationValue | null>(null);

export function UrlScopeProvider({ children }: { children: ReactNode }) {
  const historyRef = useRef<BrowserHistory | null>(null);
  if (!historyRef.current) {
    // `v5Compat` so `listen` hears push/replace as well as POP — what
    // `BrowserRouter` does with the same history.
    historyRef.current = UNSAFE_createBrowserHistory({ window, v5Compat: true });
  }
  const history = historyRef.current;

  const [state, setState] = useState<UrlLocationValue>(() => ({
    action: history.action,
    location: history.location,
  }));
  useLayoutEffect(() => {
    const unlisten = history.listen(({ action, location }) => setState({ action, location }));
    /*
     * Catch up with anything that moved the URL before this subscription existed.
     * Layout effects run child-first on mount, so `ScopedRouter` replacing a scoped
     * sign-in URL on a cold load (`/t/x/a/y/login` → `/login`) happens before this
     * listener does: unheard, the provider kept the stale location, the router kept
     * rendering nothing, and the page stayed blank until a reload.
     */
    setState((prev) =>
      prev.location === history.location ? prev : { action: history.action, location: history.location },
    );
    return unlisten;
  }, [history]);

  const pathname = state.location.pathname;
  const parsed = parseUrlScope(pathname);
  const scopeTenant = parsed?.tenantId ?? null;
  const scopeAccount = parsed?.accountId ?? null;
  // Stable identity per (tenant, account), so effects keyed on it fire on a scope
  // change and not on every navigation within one.
  const scope = useMemo<UrlScope | null>(
    () => (scopeTenant && scopeAccount ? { tenantId: scopeTenant, accountId: scopeAccount } : null),
    [scopeTenant, scopeAccount],
  );
  const prefix = scopePrefixOf(pathname);

  const go = useCallback<UrlScopeValue['go']>(
    (target, path, options) => {
      const current = currentPath(history.location);
      const app = path ?? stripUrlScope(current);
      const next = target ? withUrlScope(target, app) : stripUrlScope(app);
      if (next === current) return;
      if (options?.replace) history.replace(next);
      else history.push(next);
    },
    [history],
  );

  const value = useMemo<UrlScopeValue>(() => ({ scope, prefix, history, go }), [scope, prefix, history, go]);

  return (
    <UrlScopeContext.Provider value={value}>
      <UrlLocationContext.Provider value={state}>{children}</UrlLocationContext.Provider>
    </UrlScopeContext.Provider>
  );
}

/** The URL's scope and the way between scopes; unscoped outside a provider. */
export function useUrlScope(): UrlScopeValue {
  return useContext(UrlScopeContext);
}

/**
 * {@link useUrlScope} for a caller that must have the real history, and so must
 * sit under the provider: `TenantProvider`, whose switches load pages. Throwing
 * rather than falling back keeps a test that forgets the provider from quietly
 * exercising a switch production never makes.
 */
export function useUrlHistory(): UrlScopeValue & { history: BrowserHistory } {
  const value = useContext(UrlScopeContext);
  if (!value.history) throw new Error('useUrlHistory must be used within UrlScopeProvider');
  return value as UrlScopeValue & { history: BrowserHistory };
}

/** The current location and how it was reached; for `ScopedRouter`. */
export function useUrlLocation(): UrlLocationValue {
  const value = useContext(UrlLocationContext);
  if (!value) throw new Error('useUrlLocation must be used within UrlScopeProvider');
  return value;
}
