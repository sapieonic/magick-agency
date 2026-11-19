import type { AgencyClientKind } from '@magick-agency/contracts/agency';

/**
 * Which app sent an HTTP request, from its `X-Client` header.
 *
 * The agent mobile app sends
 * `X-Client: magick-agency-mobile/<semver>+<build> (<ios|android> <osver>; <model>)`.
 * Anything that does not start `magick-agency-mobile/` — no header, the browser
 * console, a curl — is `web`.
 *
 * The web UIs send `X-Client: <app>/<semver>`, the app being their originator
 * (`magick-agency-console`, `magick-agency-super-admin`): still `web`, with `app` and
 * `version` read so every line names which build of which UI sent it. Any other single
 * `<name>/<version>` token is read the same way and logged as given (`curl/8.5.0` is app
 * `curl`), so `clientApp` is what the caller says it is, not proof it is one of ours. A
 * header in no such shape (a browser's user agent, with its spaces) is a bare `web`.
 *
 * **Client-declared and unverified.** It picks the liveness intervals a session is
 * served and labels logs; it is never an auth input, never a rate-limit key, and never
 * decides what a caller may do. A client that lies about it only changes how quickly
 * its own silent station is closed.
 */
export interface ParsedClientHeader {
  kind: AgencyClientKind;
  /** The app's name before the `/`, lower-cased, when it is a plausible app name. */
  app?: string;
  /** The version after the `/` (mobile: `<semver>+<build>`), when it is a plausible version token. */
  version?: string;
  /** `ios` or `android` (mobile only), when the parenthesised part names one. */
  platform?: 'ios' | 'android';
}

const MOBILE_PREFIX = 'magick-agency-mobile/';

/**
 * Bound on what is parsed. A real header is well under 200 characters; anything
 * longer is cut before the regexes run, so a hostile header costs nothing.
 */
const MAX_HEADER_CHARS = 256;

/** A version token: semver-ish, an optional `+build`. Nothing that could smuggle a log field. */
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const PLATFORM = /^\((ios|android)\b/i;

/**
 * An app's name, lower-cased: what the console's brand ids allow (`VALID_BRAND_ID`,
 * apps/console/src/brand/load-brand.ts) plus the `-console` / `-super-admin` suffix, bounded.
 * Nothing that could smuggle a log field.
 */
const APP = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `<app>/<version>` from a web UI: one token, no detail. */
function parseWebApp(header: string): ParsedClientHeader {
  if (/\s/.test(header)) return { kind: 'web' };
  const slash = header.indexOf('/');
  if (slash <= 0) return { kind: 'web' };
  const app = header.slice(0, slash).toLowerCase();
  const version = header.slice(slash + 1);
  if (!APP.test(app) || !VERSION.test(version)) return { kind: 'web' };
  return { kind: 'web', app, version };
}

export function parseClientHeader(value: string | string[] | undefined | null): ParsedClientHeader {
  // Node joins a repeated header into one string for unknown names, but Fastify can
  // hand an array through; the first value is the one a client meant.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return { kind: 'web' };
  const header = raw.trim().slice(0, MAX_HEADER_CHARS);
  if (!header.toLowerCase().startsWith(MOBILE_PREFIX)) return parseWebApp(header);

  const rest = header.slice(MOBILE_PREFIX.length);
  const space = rest.indexOf(' ');
  const versionToken = space === -1 ? rest : rest.slice(0, space);
  const detail = space === -1 ? '' : rest.slice(space + 1).trim();
  const platform = PLATFORM.exec(detail)?.[1]?.toLowerCase() as 'ios' | 'android' | undefined;
  return {
    kind: 'mobile',
    app: MOBILE_PREFIX.slice(0, -1),
    ...(VERSION.test(versionToken) ? { version: versionToken } : {}),
    ...(platform ? { platform } : {}),
  };
}
