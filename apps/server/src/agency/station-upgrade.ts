import type { AgencyClientKind, AgencyStationMediaFormat } from '@magick-agency/contracts/agency';
import { AGENCY_CLIENT_KINDS, AGENCY_STATION_MEDIA_FORMATS } from '@magick-agency/contracts/agency';

/**
 * The station socket's upgrade query, beyond the token: which app is attaching and
 * which media encoding it speaks.
 *
 *  - `client=web|mobile` (absent: `web`). Tunes liveness only: a `mobile` station is
 *    probed with protocol pings and held to `MOBILE_STATION_HEARTBEAT_GRACE_MS`
 *    (`StationRegistry`), and the attach writes it to `agency_agent_sessions.client_kind`.
 *  - `media=pcm16|alaw8` (absent: `pcm16`, contracts `AgencyStationMediaFormat`). Parsed
 *    and validated here so an unknown value is refused before attach like an unknown
 *    client; the station handler tags the socket with it for the bridge
 *    (`core/bridge/browser-leg-media.ts`), which relays each format.
 *
 * One parser for both, so every station entry point refuses the same inputs the same
 * way. Client-declared and never trusted for anything security-relevant: the token is
 * what authenticates the socket.
 */
export interface StationUpgradeQuery {
  client: AgencyClientKind;
  media: AgencyStationMediaFormat;
}

/** What a station gets when its upgrade names neither (the browser console today). */
export const DEFAULT_STATION_UPGRADE: Readonly<StationUpgradeQuery> = Object.freeze({ client: 'web', media: 'pcm16' });

export type StationUpgradeQueryResult =
  | { ok: true; query: StationUpgradeQuery }
  /** Refuse before attach with 1008 (policy violation); `reason` is the close reason. */
  | { ok: false; reason: 'invalid_client' | 'invalid_media' };

/**
 * Parse the upgrade's query. An ABSENT parameter is its default; a PRESENT one must be
 * exactly a listed value (case-sensitive, not empty, not repeated): a client that
 * named something this server does not speak must hear so on the upgrade, not find
 * out from silent audio or a liveness rule it did not expect.
 */
export function parseStationUpgradeQuery(query: unknown): StationUpgradeQueryResult {
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  const client = pick(q['client'], AGENCY_CLIENT_KINDS, DEFAULT_STATION_UPGRADE.client);
  if (client === null) return { ok: false, reason: 'invalid_client' };
  const media = pick(q['media'], AGENCY_STATION_MEDIA_FORMATS, DEFAULT_STATION_UPGRADE.media);
  if (media === null) return { ok: false, reason: 'invalid_media' };
  return { ok: true, query: { client, media } };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined) return fallback;
  // A repeated parameter parses as an array: ambiguous, so refused rather than guessed.
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
