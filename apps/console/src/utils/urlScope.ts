/**
 * The tenant and account a console URL is scoped to: `/t/:tenantId/a/:accountId/…`.
 *
 * Every signed-in page lives under this prefix, so a link copied from the address
 * bar opens the same tenant and the same account for whoever it is sent to, instead
 * of whichever one their browser last had open. The prefix is the router's
 * `basename` (`routing/ScopedRouter`), which is why nothing below the router knows
 * it exists: `<Link to="/agency/campaigns">` renders the prefixed href and
 * `useLocation().pathname` reads `/agency/campaigns`.
 *
 * Pure and dependency-free on purpose: `utils/returnPath` reads it to see through
 * the prefix, and the router, the tenant context and their tests all share it.
 *
 * ── Why `/t/…/a/…` and not `/tenants/…/accounts/…` ──────────────────────────
 * `/tenants` and `/accounts` are API prefixes. nginx and the Vite dev proxy send
 * them to the server (`docker/nginx.conf`, `API_PREFIXES` in `vite.config.ts`), so
 * a page URL starting with either would never reach the SPA.
 */

export interface UrlScope {
  tenantId: string;
  accountId: string;
}

/**
 * `/t/<tenant>/a/<account>` followed by a segment boundary. Case-insensitive on the
 * two markers because react-router's basename match is; the ids are taken as they
 * stand.
 */
const SCOPE_PREFIX = /^\/t\/([^/?#]+)\/a\/([^/?#]+)(?=[/?#]|$)/i;

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    // A decoded `/` would put the id across two segments when it is built back up.
    return decoded && !decoded.includes('/') ? decoded : null;
  } catch {
    return null;
  }
}

/** The scope `path` carries, or `null` for an unscoped path. */
export function parseUrlScope(path: string): UrlScope | null {
  const match = SCOPE_PREFIX.exec(path);
  if (!match) return null;
  const tenantId = decodeSegment(match[1]!);
  const accountId = decodeSegment(match[2]!);
  if (!tenantId || !accountId) return null;
  return { tenantId, accountId };
}

/** The prefix for a scope, with no trailing slash: `/t/<tenant>/a/<account>`. */
export function scopePrefix(scope: UrlScope): string {
  return `/t/${encodeURIComponent(scope.tenantId)}/a/${encodeURIComponent(scope.accountId)}`;
}

/**
 * The literal prefix at the start of `path` as written (not re-encoded), or `''`.
 * This is what the router uses as its basename, so it has to match the URL byte for
 * byte.
 */
export function scopePrefixOf(path: string): string {
  const match = SCOPE_PREFIX.exec(path);
  return match && parseUrlScope(path) ? match[0] : '';
}

/**
 * `path` with any scope prefix removed. An unscoped path comes back unchanged; the
 * bare prefix comes back as `/`. Query and hash are kept.
 */
export function stripUrlScope(path: string): string {
  const prefix = scopePrefixOf(path);
  if (!prefix) return path;
  const rest = path.slice(prefix.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/**
 * `path` (an app path such as `/agency/campaigns?x=1`) under `scope`. Any scope
 * `path` already carries is replaced, so this is also how a link is re-pointed at
 * another account.
 */
export function withUrlScope(scope: UrlScope, path: string): string {
  const bare = stripUrlScope(path || '/');
  const prefix = scopePrefix(scope);
  // The bare root becomes the prefix itself: `/t/x/a/y`, not `/t/x/a/y/`.
  if (bare === '/') return prefix;
  if (bare.startsWith('/?') || bare.startsWith('/#')) return `${prefix}${bare.slice(1)}`;
  return `${prefix}${bare}`;
}

/**
 * Paths that are never scoped: the two sign-in doors, the two invite landings and
 * email verification. Nobody has a tenant or an account there yet, and an invite
 * link names its tenant through its token. A scoped URL that resolves to one of
 * these (`navigate('/login')` from inside the app) is sent to the bare path.
 */
const UNSCOPED_PAGE = /^\/(?:login|verify-email|join|agency\/login|agency\/join)(?:[/?#]|$)/i;

export function isUnscopedPagePath(path: string): boolean {
  return UNSCOPED_PAGE.test(stripUrlScope(path));
}
