import type { AgencyClientKind } from '@magick-agency/contracts/agency';

/**
 * Which app sent an HTTP request, from its `X-Client` header.
 *
 * The agent mobile app sends
 * `X-Client: magick-agency-mobile/<semver>+<build> (<ios|android> <osver>; <model>)`.
 * Anything that does not start `magick-agency-mobile/` — no header, the browser
 * console, a curl — is `web`.
 *
 * **Client-declared and unverified.** It picks the liveness intervals a session is
 * served and labels logs; it is never an auth input, never a rate-limit key, and never
 * decides what a caller may do. A client that lies about it only changes how quickly
 * its own silent station is closed.
 */
export interface ParsedClientHeader {
  kind: AgencyClientKind;
  /** `<semver>+<build>` as sent (mobile only), when it is a plausible version token. */
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

export function parseClientHeader(value: string | string[] | undefined | null): ParsedClientHeader {
  // Node joins a repeated header into one string for unknown names, but Fastify can
  // hand an array through; the first value is the one a client meant.
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return { kind: 'web' };
  const header = raw.trim().slice(0, MAX_HEADER_CHARS);
  if (!header.toLowerCase().startsWith(MOBILE_PREFIX)) return { kind: 'web' };

  const rest = header.slice(MOBILE_PREFIX.length);
  const space = rest.indexOf(' ');
  const versionToken = space === -1 ? rest : rest.slice(0, space);
  const detail = space === -1 ? '' : rest.slice(space + 1).trim();
  const platform = PLATFORM.exec(detail)?.[1]?.toLowerCase() as 'ios' | 'android' | undefined;
  return {
    kind: 'mobile',
    ...(VERSION.test(versionToken) ? { version: versionToken } : {}),
    ...(platform ? { platform } : {}),
  };
}
