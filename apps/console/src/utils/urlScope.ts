/**
 * The tenant and account a console URL is scoped to: `/t/:tenantId/a/:accountId/…` (B26).
 *
 * Every signed-in page lives under this prefix, so a link copied from the address
 * bar opens the same tenant and the same account for whoever it is sent to, instead
 * of whichever one their browser last had open. The prefix is the router's
 * `basename` (`routing/ScopedRouter`), which is why nothing below the router knows
 * it exists: `<Link to="/agency/campaigns">` renders the prefixed href and
 * `useLocation().pathname` reads `/agency/campaigns`.
 *
 * Pure and dependency-free on purpose: `utils/returnPath` reads it to see through
 * the prefix (and says which pages stay unscoped, `isUnscopedPagePath`), and the
 * router, the tenant context and their tests all share it.
 *
 * The shape itself — the markers, the encoding — is the contracts package's
 * (`console-urls`), because the server builds the same URLs into the links it
 * emails. Why `/t/…/a/…` and not `/tenants/…/accounts/…` is explained there.
 */

import {
  CONSOLE_SCOPE_PREFIX_RE,
  consoleScopePrefix,
  type ConsoleUrlScope,
} from '@magick-agency/contracts/api/platform/console-urls';

export type UrlScope = ConsoleUrlScope;

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    // A decoded `/` would put the id across two segments when it is built back up.
    return decoded && !decoded.includes('/') ? decoded : null;
  } catch {
    return null;
  }
}

/** The one match the exports below share: the scope and its literal prefix. */
function matchScope(path: string): { scope: UrlScope; prefix: string } | null {
  const match = CONSOLE_SCOPE_PREFIX_RE.exec(path);
  if (!match) return null;
  const tenantId = decodeSegment(match[1]!);
  const accountId = decodeSegment(match[2]!);
  if (!tenantId || !accountId) return null;
  return { scope: { tenantId, accountId }, prefix: match[0] };
}

/** The scope `path` carries, or `null` for an unscoped path. */
export function parseUrlScope(path: string): UrlScope | null {
  return matchScope(path)?.scope ?? null;
}

/** The prefix for a scope, with no trailing slash: `/t/<tenant>/a/<account>`. */
export function scopePrefix(scope: UrlScope): string {
  return consoleScopePrefix(scope);
}

/**
 * The literal prefix at the start of `path` as written (not re-encoded), or `''`.
 * This is what the router uses as its basename, so it has to match the URL byte for
 * byte.
 */
export function scopePrefixOf(path: string): string {
  return matchScope(path)?.prefix ?? '';
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
