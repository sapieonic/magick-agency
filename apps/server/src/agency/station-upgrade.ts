import type { AgencyClientKind, AgencyStationCapability, AgencyStationMediaFormat } from '@magick-agency/contracts/agency';
import { AGENCY_CLIENT_KINDS, AGENCY_STATION_CAPABILITIES, AGENCY_STATION_MEDIA_FORMATS } from '@magick-agency/contracts/agency';

/**
 * The station socket's upgrade query, beyond the token: which app is attaching, which
 * media encoding it speaks and what else it can do.
 *
 *  - `client=web|mobile` (absent: `web`). Tunes liveness: a `mobile` station is probed
 *    with protocol pings and held to `MOBILE_STATION_HEARTBEAT_GRACE_MS`
 *    (`StationRegistry`), and the attach writes it to `agency_agent_sessions.client_kind`.
 *    It also sets the inbound default: a `web` station can always take inbound calls, a
 *    `mobile` one only with `caps=inbound` ({@link stationCanTakeInbound}, IQ46).
 *  - `media=pcm16|alaw8` (absent: `pcm16`, contracts `AgencyStationMediaFormat`). Parsed
 *    and validated here so an unknown value is refused before attach like an unknown
 *    client; the station handler tags the socket with it for the bridge
 *    (`core/bridge/browser-leg-media.ts`), which relays each format.
 *  - `caps=<capability>,…` (absent or empty: none; contracts `AgencyStationCapability`).
 *    Unlike the two above, never refused: an unknown value is ignored (an app newer than
 *    this server must still get a station, and a 1008 is terminal for the app), and a
 *    repeated `caps` parameter is the union. Today `inbound`: whether a mobile station can
 *    be put through to inbound callers and sent their frames ({@link stationCanTakeInbound}).
 *
 * One parser for all three, so every station entry point refuses the same inputs the same
 * way. Client-declared and never trusted for anything security-relevant: the token is
 * what authenticates the socket.
 */
export interface StationUpgradeQuery {
  client: AgencyClientKind;
  media: AgencyStationMediaFormat;
  /** The capabilities this server knows that the station declared, each once, in contract order. */
  caps: readonly AgencyStationCapability[];
}

/** What a station gets when its upgrade names none of them (the browser console today). */
export const DEFAULT_STATION_UPGRADE: Readonly<StationUpgradeQuery> = Object.freeze({
  client: 'web', media: 'pcm16', caps: Object.freeze([]) as readonly AgencyStationCapability[],
});

/**
 * Whether a station attaching with `query` can take inbound calls (docs/inbound.md §4.3): a
 * console always; a phone only when it declared `caps=inbound`, so every app build that cannot
 * decode the inbound frames stays out of the pool and is never sent them.
 */
export function stationCanTakeInbound(query: Pick<StationUpgradeQuery, 'client' | 'caps'>): boolean {
  return query.client !== 'mobile' || query.caps.includes('inbound');
}

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
  return { ok: true, query: { client, media, caps: parseCaps(q['caps']) } };
}

/**
 * `caps`: comma-separated, a repeated parameter the union; values trimmed; unknown ones and
 * empty items ignored (never refused: see the header). Case-sensitive, as `client` and `media`.
 */
function parseCaps(value: unknown): AgencyStationCapability[] {
  const raw = (Array.isArray(value) ? value : [value]).filter((v): v is string => typeof v === 'string');
  const named = new Set(raw.flatMap((v) => v.split(',')).map((v) => v.trim()));
  return AGENCY_STATION_CAPABILITIES.filter((c) => named.has(c));
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T | null {
  if (value === undefined) return fallback;
  // A repeated parameter parses as an array: ambiguous, so refused rather than guessed.
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
