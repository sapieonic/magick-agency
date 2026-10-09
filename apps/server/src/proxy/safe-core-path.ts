/**
 * Refuse an internal handler path (`callCore`) that would leave the route the
 * caller was gated for.
 *
 * Hand-written interpolations (`/calls/${request.params.id}/recording`,
 * `/agency-campaigns/${id}/attempts`, …) put a decoded Fastify param into the
 * path string. find-my-way routes on the *encoded* URL but hands the handler a
 * percent-decoded value, so `%2F` arrives as `/` and `%2e%2e` as `..`. The
 * WHATWG URL parser (which `inject` uses) then resolves those segments before
 * the request is routed:
 *
 *   GET /proxy/agency/campaigns/x%2F..%2F..%2Fagency-agents%3F/attempts
 *     → path `/agency-campaigns/x/../../agency-agents?/attempts`
 *     → inject(`/api/v1/agency-campaigns/x/../../agency-agents?/attempts`)
 *     → `/api/v1/agency-agents`
 *
 * The public API layer's gates (RBAC permission, capabilities) are chosen per
 * route. Landing on another internal collection with the caller's own tenant
 * is a privilege bypass, not a cross-tenant leak. Hand-written interpolations,
 * including the spine routes, have no per-param guard of their own.
 *
 * ── Why this asks the URL parser instead of matching strings ────────────────
 * The first cut of this guard looked for pathname segments that were literally
 * `.` or `..`. The parser recognises strictly more than that, so the string
 * match was bypassable in at least three ways, all reachable through a single
 * find-my-way decode (the caller double-encodes, `%252e` → `%2e`):
 *
 *   `/calls/x/%2e%2e/%2e%2e/knowledge-bases/recording` → `/knowledge-bases/recording`
 *   `/calls/x/.%2e/.%2e/knowledge-bases/recording`     → `/knowledge-bases/recording`
 *   `/calls/x/.<TAB>./../knowledge-bases/recording`    → `/knowledge-bases/recording`
 *
 * (`%2e`/`%2E` are decoded before the dot-segment test, and TAB/LF/CR are
 * stripped out of the whole URL before it is parsed at all.) Re-implementing
 * that list is how the next variant gets in, so the check now runs the same
 * parser `inject` will run and requires the path to survive it **unchanged**.
 * Anything the parser rewrites — a popped segment, a dropped fragment, a `\`
 * turned into `/`, a character it percent-encodes — is refused.
 *
 * That is strict by design. Every interpolation in this repo puts an id, hash,
 * or already-`encodeURIComponent`'d value into the path, none of which the
 * parser touches; a path that does not survive a parse intact is not a path we
 * meant to build. Note `encodeURIComponent` is *not* itself a defence here —
 * it leaves `.` alone, so `encodeURIComponent('..')` is still `..`.
 *
 * ── What is checked ─────────────────────────────────────────────────────────
 * The pathname only. `?` is *not* rejected: a `?` without `..` only truncates a
 * suffix on the same collection (same RBAC), it does not walk to another tree. Dot segments after a `?` are query
 * text and are never resolved as path.
 *
 * Query strings passed via the `query` option never enter this function.
 */

/**
 * A prefix that cannot occur in a real handler path, so `..` walking off the top
 * of the caller's path shows up as a mismatch rather than silently bottoming
 * out at `/`. It also means a `path` of `//evil.com/x` is parsed as a path
 * segment rather than as an authority.
 */
const PROBE_PREFIX = '/__core_path_probe__';
const PROBE_ORIGIN = 'https://core-path-probe.invalid';

export function isUnsafeCorePath(path: string): boolean {
  if (!path.startsWith('/')) return true;

  // Both are also caught by the probe below (the parser rewrites `\` to `/`
  // and drops everything from `#` on). They are named anyway so the intent
  // survives a future edit to the probe: `#` is the worse of the two, because
  // the fragment is dropped rather than sent — a `DELETE …/<id>%23/transcript`
  // would reach the handler as `DELETE …/<id>`, deleting the parent instead of
  // its child.
  if (path.includes('\\') || path.includes('#')) return true;

  const pathname = path.split('?', 1)[0]!;
  let resolved: string;
  try {
    resolved = new URL(PROBE_PREFIX + pathname, PROBE_ORIGIN).pathname;
  } catch {
    return true;
  }
  return resolved !== PROBE_PREFIX + pathname;
}
