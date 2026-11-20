import type { AgencyClientKind, AgencyStationCapability, AgencyStationMediaFormat } from '@magick-agency/contracts/agency';
import {
  AGENCY_CLIENT_KINDS,
  AGENCY_STATION_CAPABILITIES,
  AGENCY_STATION_MEDIA_FORMATS,
} from '@magick-agency/contracts/agency';

/**
 * The station socket's upgrade query, beyond the token: which app is attaching, which
 * media encoding it speaks and what else it can do.
 *
 *  - `client=web|mobile` (absent: `web`). Tunes liveness: a `mobile` station is probed
 *    with protocol pings and held to `MOBILE_STATION_HEARTBEAT_GRACE_MS`
 *    (`StationRegistry`), and the attach writes it to `agency_agent_sessions.client_kind`.
 *    It also sets the inbound default: a `web` station can always take inbound calls, a
 *    `mobile` one only with `caps=inbound` ({@link stationHas}, IQ46).
 *  - `media=pcm16|alaw8` (absent: `pcm16`, contracts `AgencyStationMediaFormat`). Parsed
 *    and validated here so an unknown value is refused before attach like an unknown
 *    client; the station handler tags the socket with it for the bridge
 *    (`core/bridge/browser-leg-media.ts`), which relays each format.
 *  - `caps=<capability>,…` (absent or empty: none; contracts `AgencyStationCapability`).
 *    Unlike the two above, never refused: an unknown value is ignored (an app newer than
 *    this server must still get a station, and a 1008 is terminal for the app), and a
 *    repeated `caps` parameter is the union. `inbound`: whether a mobile station can be put
 *    through to inbound callers and sent their frames;
 *    `floor_assist`: whether it is sent a supervisor's messages and its Need help's answers;
 *    `queue_pool`: whether it is sent a `pool` campaign's queue state, declared by a console too
 *    (all three {@link stationHas}).
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
 * Whether a station attaching with `query` has capability `cap`: a console always; a phone only
 * when it declared it, so an app build that cannot decode a capability's frames is never sent them.
 * `inbound` (docs/inbound.md §4.3): put through to inbound callers and sent their frames, every
 * other app build staying out of the pool. `floor_assist` (LF4, LF5; contracts
 * `agency/floor-assist.ts`): sent a supervisor's messages and its Need help's answers, a message to
 * any other app build being `409 agent_not_live`. `queue_pool` (agent station BE-5, AS18): sent a
 * `pool` campaign's queue state; only when declared, by a console too.
 */
export function stationHas(query: Pick<StationUpgradeQuery, 'client' | 'caps'>, cap: AgencyStationCapability): boolean {
  if (DECLARED_BY_EVERY_CLIENT.has(cap)) return query.caps.includes(cap);
  return query.client !== 'mobile' || query.caps.includes(cap);
}

/**
 * The capabilities a console has only when it declares them too (agent station AS18): `queue_pool`,
 * a `pool` campaign's queue state, which a console tab built before the redesign would word for an
 * owner's own contacts. The others a console always has (every console build decodes their frames).
 */
const DECLARED_BY_EVERY_CLIENT: ReadonlySet<AgencyStationCapability> = new Set<AgencyStationCapability>(['queue_pool']);

/** Every capability a station attaching with `query` has ({@link stationHas}): what its registry entry keeps. */
export function stationCaps(query: Pick<StationUpgradeQuery, 'client' | 'caps'>): ReadonlySet<AgencyStationCapability> {
  return new Set(AGENCY_STATION_CAPABILITIES.filter((cap) => stationHas(query, cap)));
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
