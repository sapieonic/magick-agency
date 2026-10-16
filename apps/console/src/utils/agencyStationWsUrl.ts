import { API_BASE } from '../config';

/**
 * The server rewrites the dialer runtime's absolute URL onto its own `/proxy/...` prefix, which
 * arrives here as a PATH. A relative path is not a valid WebSocket URL, so it
 * has to be resolved against a host — and the host is **`API_BASE`, not the
 * page's origin**, because the SPA and the API are not the same origin on any
 * real deployment.
 *
 * This resolved against `window.location.host` alone, which is correct in dev
 * (`API_BASE` empty, Vite proxying `/proxy` to the API) and correct on any
 * single-origin deploy — and wrong everywhere else. On staging the page is
 * served from one host while `API_BASE` is
 * another host, so the upgrade went to the SPA's own
 * host, matched its history fallback, and came back **`200 text/html`** — the
 * index page. A WebSocket handshake that gets a 200 instead of a 101 never
 * opens, so the API's own close codes are never reached and the console has
 * nothing to report but a bare transport failure. It then re-mints a token and
 * retries forever on the backoff below, which is what turns one misresolved
 * host into a wall of console errors and a steady stream of token mints.
 *
 * Only the **origin** is taken from `API_BASE` — a base with a path prefix is
 * not joined onto the socket path, because the path is the API's own rewrite and
 * is already absolute from the host root.
 *
 * An absolute `ws(s)://` URL is still passed through untouched: that is
 * `rewriteStationWsUrl`'s documented degradation (an unrecognised the API URL is
 * left alone so the client talks to the API directly), and rewriting its host to
 * the API's would break exactly the case that fallback exists for.
 */
export function toAbsoluteWsUrl(pathOrUrl: string): string {
  if (/^wss?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  // Resolved against the page URL so a RELATIVE `API_BASE` (`/api`) is handled
  // rather than throwing out of `new URL` — a bare `new URL(API_BASE)` would.
  const base = API_BASE ? new URL(API_BASE, window.location.href) : window.location;
  const scheme = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${base.host}${path}`;
}
