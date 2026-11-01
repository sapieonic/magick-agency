import {
  AGENCY_STATION_MEDIA_FORMATS,
  type AgencyStationMediaFormat,
} from '@magick-agency/contracts/agency';

/**
 * The station upgrade's `media=` parameter (contracts `AgencyStationMediaFormat`).
 *
 * Absent ⇒ `pcm16`, so every client that predates the parameter is unchanged. Anything
 * else that is not exactly one known value — an unknown word, a different case, an empty
 * `media=`, or the parameter given twice (Fastify parses that to an array) — is refused:
 * the caller closes 1008 before the socket is attached. Guessing would be worse than
 * refusing, because a client that sends audio in a format the server did not pick hears
 * silence on a call that looks connected.
 */
export type StationMediaFormatParse =
  | { ok: true; format: AgencyStationMediaFormat }
  | { ok: false; value: unknown };

export function parseStationMediaFormat(query: unknown): StationMediaFormatParse {
  const value = query !== null && typeof query === 'object'
    ? (query as Record<string, unknown>)['media']
    : undefined;
  if (value === undefined) return { ok: true, format: 'pcm16' };
  if (typeof value === 'string' && (AGENCY_STATION_MEDIA_FORMATS as readonly string[]).includes(value)) {
    return { ok: true, format: value as AgencyStationMediaFormat };
  }
  return { ok: false, value };
}
