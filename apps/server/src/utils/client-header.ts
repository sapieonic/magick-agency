import type { AgencyClientKind } from '@magick-agency/contracts/agency';

/**
 * Which app sent an HTTP request, from its `X-Client` header: `<app>/<version>[ <detail>]`,
 * in the manner of a User-Agent.
 *
 * - The agent mobile app sends
 *   `magick-agency-mobile/<semver>+<build> (<ios|android> <osver>; <model>)`: `mobile`, with its
 *   version and platform.
 * - The web UIs send `<originator>/<version>` (`magick-agency-console/0.29.0`, web-ui's
 *   `clientHeaders`): `web`, with `app` and `version`.
 * - Anything else is `web`, with whatever `app` and `version` it names in that shape
 *   (`curl/8.5.0` is app `curl`): `clientApp` is the caller's claim, not proof it is one of ours.
 *   No header, or one in no such shape, is a bare `web`.
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

const MOBILE_APP = 'magick-agency-mobile';

/**
 * Bound on what is parsed. A real header is well under 200 characters; anything
 * longer is cut before the regexes run, so a hostile header costs nothing.
 */
const MAX_HEADER_CHARS = 256;

/**
 * An app's name, lower-cased: what the console's brand ids allow (`VALID_BRAND_ID`,
 * apps/console/src/brand/load-brand.ts) plus the `-console` / `-super-admin` suffix, bounded.
 * Nothing that could smuggle a log field.
 */
const APP = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A version token: semver-ish, an optional `+build`. Nothing that could smuggle a log field. */
const VERSION = /^[0-9A-Za-z.+-]{1,40}$/;

const PLATFORM = /^\((ios|android)\b/i;

export function parseClientHeader(value: string | string[] | undefined | null): ParsedClientHeader {
  // Node joins a repeated header into one string for unknown names, but Fastify can
  // hand an array through; the first value is the one a client meant.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return { kind: 'web' };
  const header = raw.trim().slice(0, MAX_HEADER_CHARS);

  const space = header.search(/\s/);
  const token = space === -1 ? header : header.slice(0, space);
  const slash = token.indexOf('/');
  if (slash === -1) return { kind: 'web' };
  const app = token.slice(0, slash).toLowerCase();
  if (!APP.test(app)) return { kind: 'web' };
  const version = token.slice(slash + 1);
  const kind: AgencyClientKind = app === MOBILE_APP ? 'mobile' : 'web';
  const detail = space === -1 ? '' : header.slice(space + 1).trim();
  const platform = kind === 'mobile' ? PLATFORM.exec(detail)?.[1]?.toLowerCase() as 'ios' | 'android' | undefined : undefined;
  return {
    kind,
    app,
    ...(VERSION.test(version) ? { version } : {}),
    ...(platform ? { platform } : {}),
  };
}
