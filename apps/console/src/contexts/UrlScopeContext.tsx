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
import {
  parseUrlScope,
  scopePrefixOf,
  stripUrlScope,
  withUrlScope,
  type UrlScope,
} from '../utils/urlScope';

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
 * `go` is the one way to move between scopes. Inside a scope, plain
 * `navigate('/agency/…')` keeps the current one (the basename prefixes it), and
 * react-router cannot navigate outside its own basename at all — so the tenant and
 * account switchers, and the gate that pins an unscoped URL to the active account,
 * all come through here.
 */
export interface UrlScopeValue {
  /** The scope in the URL, or `null` on an unscoped page. */
  scope: UrlScope | null;
  /** `/t/<tenant>/a/<account>` as written in the URL, or `''`. */
  prefix: string;
  /** The current URL without its scope prefix: pathname + search + hash. */
  appPath: string;
  location: Location;
  action: NavigationType;
  history: BrowserHistory | null;
  /**
   * Go to `path` (an app path, e.g. `/agency/campaigns`) under `scope`, or
   * unscoped when `scope` is `null`. Defaults to the current app path, so
   * `go(next)` re-points the page the user is on at another account.
   */
  go: (scope: UrlScope | null, path?: string, options?: { replace?: boolean }) => void;
}

const NO_LOCATION: Location = { pathname: '/', search: '', hash: '', state: null, key: 'default' };

/**
 * Outside a provider (unit tests that render a context or a page on its own) there
 * is no URL to scope, and moving between scopes is a no-op.
 */
const UNSCOPED: UrlScopeValue = {
  scope: null,
  prefix: '',
  appPath: '/',
  location: NO_LOCATION,
  action: 'POP' as NavigationType,
  history: null,
  go: () => {},
};

const UrlScopeContext = createContext<UrlScopeValue>(UNSCOPED);

export function UrlScopeProvider({ children }: { children: ReactNode }) {
  const historyRef = useRef<BrowserHistory | null>(null);
  if (!historyRef.current) {
    // `v5Compat` so `listen` hears push/replace as well as POP — what
    // `BrowserRouter` does with the same history.
    historyRef.current = UNSAFE_createBrowserHistory({ window, v5Compat: true });
  }
  const history = historyRef.current;

  const [state, setState] = useState<{ action: NavigationType; location: Location }>(() => ({
    action: history.action,
    location: history.location,
  }));
  useLayoutEffect(
    () => history.listen(({ action, location }) => setState({ action, location })),
    [history],
  );

  const { location, action } = state;
  const pathname = location.pathname;
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
  const appPath = stripUrlScope(`${pathname}${location.search}${location.hash}`);

  const go = useCallback<UrlScopeValue['go']>(
    (target, path, options) => {
      const current = `${history.location.pathname}${history.location.search}${history.location.hash}`;
      const app = path ?? stripUrlScope(current);
      const next = target ? withUrlScope(target, app) : stripUrlScope(app);
      if (next === current) return;
      if (options?.replace) history.replace(next);
      else history.push(next);
    },
    [history],
  );

  const value = useMemo<UrlScopeValue>(
    () => ({ scope, prefix, appPath, location, action, history, go }),
    [scope, prefix, appPath, location, action, history, go],
  );

  return <UrlScopeContext.Provider value={value}>{children}</UrlScopeContext.Provider>;
}

export function useUrlScope(): UrlScopeValue {
  return useContext(UrlScopeContext);
}
