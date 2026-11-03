import {
  AGENCY_STATION_ALAW8_FRAME_BYTES,
  AGENCY_STATION_ALAW8_MAX_FRAME_BYTES,
  AGENCY_WS_MAX_MESSAGE_BYTES,
  type AgencyStationMediaFormat,
} from '@magick-agency/contracts/agency';

/**
 * The agency station socket's **audio wire formats**, in one place.
 *
 * The format belongs to the socket and is chosen at the upgrade with `media=`
 * (contracts `AgencyStationMediaFormat`; absent means `pcm16`). The console asks for
 * `alaw8` unless the tenant's `agency_console_alaw8` flag is off, and falls back to
 * `pcm16` for the rest of the station's life if the server refuses `alaw8`
 * (`useAgencyStation`). Either way the console has one format to produce and one to
 * consume per socket, and neither depends on which carrier is dialling: the server
 * transcodes on its far side.
 *
 * ── `alaw8` (the default) ──────────────────────────────────────────────────────────
 * **Binary** WebSocket messages of raw G.711 A-law, 8 kHz mono, one byte per sample,
 * no header. Up: any whole number of 160-byte (20 ms) frames per message, at most 1 s
 * ({@link isSendableAlawMessage}); the capture worklet sends one frame per message.
 * Down: exactly one 160-byte frame per message. With VoiceLink, whose wire audio is
 * already A-law, the server relays the bytes untouched: no transcode, no base64, no
 * JSON per frame. Text messages stay JSON control frames, and a JSON `media` frame on
 * this socket is dropped by the server, so the console never sends one here
 * (`useAgencyStation.sendMedia` routes by the frame's type and the socket's format).
 *
 * ── `pcm16` (the fallback) ─────────────────────────────────────────────────────────
 * Down: `{ event: 'media', media: { payload: <base64> } }`, `payload` PCM16 mono 16 kHz
 * little-endian. Up: the **same envelope in the same encoding**. A binary message on
 * this socket is ignored by the server.
 *
 * There is **no handshake** in either format: the server's browser-side listener acts
 * on `media` (or binary audio) and nothing else, so the console sends no `start`.
 */

/** One captured uplink frame: base64 PCM16 (`pcm16`) or raw A-law bytes (`alaw8`). */
export type AgencyUplinkFrame = string | ArrayBuffer;

/** What a frame of this type is: the socket format it can be sent on. */
export function uplinkFrameFormat(frame: AgencyUplinkFrame): AgencyStationMediaFormat {
  return typeof frame === 'string' ? 'pcm16' : 'alaw8';
}

/**
 * Is a binary uplink message of `byteLength` bytes one the server accepts on an `alaw8`
 * socket: a non-zero whole number of 20 ms frames, at most 1 s? Anything else the
 * server drops silently, so it is refused here where the drop can be counted.
 */
export function isSendableAlawMessage(byteLength: number): boolean {
  return (
    byteLength > 0 &&
    byteLength <= AGENCY_STATION_ALAW8_MAX_FRAME_BYTES &&
    byteLength % AGENCY_STATION_ALAW8_FRAME_BYTES === 0
  );
}

/**
 * Is a binary downlink message of `byteLength` bytes worth playing? The server sends
 * exactly one 20 ms frame; anything from one byte to 1 s is decoded (A-law has no
 * framing to lose), and a larger message is dropped rather than allocated for.
 */
export function isPlayableAlawMessage(byteLength: number): boolean {
  return byteLength > 0 && byteLength <= AGENCY_STATION_ALAW8_MAX_FRAME_BYTES;
}

/**
 * The upgrade URL with the socket's format: `station_ws_url` (a path with `?token=`, or
 * an absolute URL) plus `media=<format>`.
 *
 * Appended as text rather than re-serialised through `URLSearchParams`, which would
 * re-encode the single-use token's characters. A `media=` already present is replaced:
 * the server refuses a repeated parameter (1008) rather than guess which one was meant.
 * `pcm16` is named explicitly too, so the request says what the console will speak.
 */
export function withStationMediaQuery(url: string, format: AgencyStationMediaFormat): string {
  const hashAt = url.indexOf('#');
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const queryAt = base.indexOf('?');
  if (queryAt === -1) return `${base}?media=${format}${hash}`;
  const path = base.slice(0, queryAt);
  const params = base
    .slice(queryAt + 1)
    .split('&')
    .filter((p) => p !== '' && p !== 'media' && !p.startsWith('media='));
  params.push(`media=${format}`);
  return `${path}?${params.join('&')}${hash}`;
}

/** `pcm16`: the server normalises every carrier to this before the socket. Hz. */
export const AGENCY_MEDIA_SAMPLE_RATE = 16000;

/**
 * `pcm16`: samples per outbound frame — 20 ms at 16 kHz, which is what the capture
 * worklet emits in that format. Kept as a named constant because the playback jitter
 * cushion is expressed in whole frames of it.
 */
export const AGENCY_MEDIA_FRAME_SAMPLES = 320;

/**
 * `pcm16`: the largest uplink payload the server takes, transcribed.
 *
 * ── Where the bound comes from ──────────────────────────────────────────────
 * The server registers its WebSockets with `maxPayload` 64 KiB
 * (`AGENCY_WS_MAX_MESSAGE_BYTES` in the wire contract, which the server's
 * `WS_MAX_PAYLOAD_DEFAULT_BYTES` is; operators may raise it with `WS_MAX_PAYLOAD_BYTES`,
 * never lower it below the largest legitimate frame). That bound is on the **whole**
 * message, so the payload gets what is left after the JSON envelope
 * `{"event":"media","media":{"payload":""}}` (40 characters): 65536 − 40 = 65496. Base64
 * is ASCII, so characters and bytes agree.
 *
 * ── Why it must not be looser ───────────────────────────────────────────────
 * A message over `maxPayload` is not dropped: `ws` closes the socket with 1009, which
 * takes the agent's station (and a live call's audio) down with it. The bridge's own
 * character check behind it is looser, so this is the bound that bites. A frame refused
 * here is counted on this side instead.
 *
 * Both sides read the one constant, so the server's default cannot move without this.
 *
 * ── This is not a protective bound in practice ──────────────────────────────
 * A 20 ms frame is 640 bytes → **856 base64 characters**, 1.3% of this ceiling.
 * Nothing the capture graph produces can approach it. The check exists so that a
 * broken graph upstream fails visibly on this side rather than closing the station.
 */
export const MAX_AGENCY_MEDIA_PAYLOAD_CHARS = AGENCY_WS_MAX_MESSAGE_BYTES - '{"event":"media","media":{"payload":""}}'.length;

/**
 * A `pcm16` uplink frame, serialised.
 *
 * Returns `null` for a payload the server would drop, so the caller can count the drop
 * instead of shipping a frame into a silent discard.
 */
export function encodeAgencyMediaFrame(payload: string): string | null {
  if (payload.length === 0 || payload.length > MAX_AGENCY_MEDIA_PAYLOAD_CHARS) return null;
  return JSON.stringify({ event: 'media', media: { payload } });
}

/**
 * Read a `pcm16` downlink payload off an already-parsed frame.
 *
 * Deliberately tolerant in the same way the server's reader is — `typeof payload ===
 * 'string'` and nothing more. A frame that fails this is not an error; it is a
 * frame for someone else.
 */
export function readAgencyMediaPayload(frame: unknown): string | null {
  if (!frame || typeof frame !== 'object') return null;
  const record = frame as { event?: unknown; media?: { payload?: unknown } };
  if (record.event !== 'media') return null;
  const payload = record.media?.payload;
  return typeof payload === 'string' && payload.length > 0 ? payload : null;
}
