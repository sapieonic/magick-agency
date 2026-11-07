/**
 * The tenant/account scope of a console page URL, `/t/:tenantId/a/:accountId/…` (B26).
 *
 * The console reads and writes it (`apps/console/src/utils/urlScope`, the router's
 * basename) and the server writes it into links it sends (the campaign-completion
 * email's "View campaign"). It lives here so that both sides build the one shape:
 * a change to the markers or the encoding changes the console's parsing and every
 * emailed link together, and `test/console-urls.test.ts` pins it.
 *
 * `/t` and `/a`, not `/tenants` and `/accounts`: those are API prefixes, which
 * nginx and the Vite dev proxy send to the server, so a page under them would
 * never reach the console.
 */

export interface ConsoleUrlScope {
  tenantId: string;
  accountId: string;
}

/**
 * `/t/<tenant>/a/<account>` at the start of a path, followed by a segment
 * boundary. Case-insensitive on the two markers because react-router's basename
 * match is. Group 1 is the tenant segment and group 2 the account segment, both
 * still percent-encoded.
 */
export const CONSOLE_SCOPE_PREFIX_RE = /^\/t\/([^/?#]+)\/a\/([^/?#]+)(?=[/?#]|$)/i;

/** The prefix for a scope, with no trailing slash: `/t/<tenant>/a/<account>`. */
export function consoleScopePrefix(scope: ConsoleUrlScope): string {
  return `/t/${encodeURIComponent(scope.tenantId)}/a/${encodeURIComponent(scope.accountId)}`;
}
