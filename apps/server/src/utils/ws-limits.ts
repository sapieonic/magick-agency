// The inbound message-size bound for every WebSocket the server accepts. Read by `app.ts`
// (the one `@fastify/websocket` registration), the base config block (`WS_MAX_PAYLOAD_BYTES`,
// whose floor is the largest legitimate message below) and the load harnesses, so the tests
// run against the bound production uses.
import { AGENCY_STATION_ALAW8_MAX_FRAME_BYTES, AGENCY_WS_MAX_MESSAGE_BYTES } from '@magick-agency/contracts/agency';

/** Characters of base64 for `bytes` bytes (padded). */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** `{"event":"media","media":{"payload":""}}`: the station's JSON media frame with an empty payload. */
const STATION_MEDIA_ENVELOPE_BYTES = '{"event":"media","media":{"payload":""}}'.length;

/** One second of PCM16, 16 kHz mono: what a `pcm16` station socket carries. */
const PCM16_16K_ONE_SECOND_BYTES = 16_000 * 2;

/**
 * Room for the fields a Twilio-shaped carrier media frame carries beside the payload
 * (`streamSid`, `sequenceNumber`, `media.track` / `chunk` / `timestamp`) and for the
 * `start` frame's ids and custom parameters. Generous: 4 KiB of metadata on a frame
 * whose audio is a few hundred bytes.
 */
const CARRIER_FRAME_METADATA_BYTES = 4 * 1024;

/** One second of G.711 A-law, 8 kHz mono: VoiceLink's wire audio (`voicelink.media.ts`). */
const ALAW_8K_ONE_SECOND_BYTES = 8_000;

/**
 * The largest message each WebSocket route legitimately receives, in bytes, keyed by the
 * route's URL as Fastify's `onRoute` reports it. `test/unit/app/websocket-max-payload.test.ts`
 * enumerates the WebSocket routes `buildApp` registers and requires this table to name
 * exactly those, so a new WebSocket route fails that test until it is sized here.
 *
 *  - **Station socket**, `media=pcm16`: JSON text, base64 PCM16 16 kHz. The console sends
 *    20 ms frames (856 base64 characters); one second of audio, the most any client sends
 *    in one frame, is 42 668 characters plus the envelope. (The bridge's own drop,
 *    `isOversizedMediaPayload`, sits at 128 000 characters, a loose ceiling above that;
 *    nothing legitimate reaches it.) Control frames (`ping`) are tens of bytes.
 *  - **Station socket**, `media=alaw8`: binary A-law, at most 1 s = 8000 bytes
 *    (`AGENCY_STATION_ALAW8_MAX_FRAME_BYTES`; the bridge drops anything longer).
 *  - **Carrier PSTN media stream**, `/api/v1/webrtc-call/:id/pstn-stream`: VoiceLink's
 *    Twilio-shaped JSON, A-law 8 kHz, sent in 20 ms chunks (216 base64 characters), or
 *    Plivo's JSON, μ-law 8 kHz (one byte a sample too, so the same size). Sized for one
 *    second of audio in one frame plus metadata, far above anything observed.
 */
export const WS_ROUTE_LARGEST_MESSAGE_BYTES: Readonly<Record<string, number>> = {
  '/proxy/agency/station/:sessionId': Math.max(
    base64Length(PCM16_16K_ONE_SECOND_BYTES) + STATION_MEDIA_ENVELOPE_BYTES,
    AGENCY_STATION_ALAW8_MAX_FRAME_BYTES,
  ),
  '/api/v1/webrtc-call/:id/pstn-stream': base64Length(ALAW_8K_ONE_SECOND_BYTES) + CARRIER_FRAME_METADATA_BYTES,
};

/** The largest legitimate inbound message on any route: 42 708 bytes (a 1 s `pcm16` station frame). */
export const WS_LARGEST_LEGITIMATE_MESSAGE_BYTES = Math.max(...Object.values(WS_ROUTE_LARGEST_MESSAGE_BYTES));

/**
 * Default `maxPayload` for every WebSocket: 64 KiB, about 1.5× the largest legitimate
 * message ({@link WS_LARGEST_LEGITIMATE_MESSAGE_BYTES}). The number is the wire contract's
 * (`AGENCY_WS_MAX_MESSAGE_BYTES`), so the console sizes its largest frame from the same
 * constant.
 *
 * Without it `ws` allows 100 MiB, and buffers, stringifies and `JSON.parse`s the whole
 * message on the shared event loop before anything can decide to ignore it: one
 * signed-in console could stall every call on the process. Past the bound `ws` refuses
 * the message as it arrives (it never buffers past `maxPayload`) and closes the socket
 * with **1009** (message too big). For the station that ends the agent's socket; the
 * console reconnects as for any other close, and a live call gets the bridge's usual
 * station-close grace. No legitimate client is near the bound.
 *
 * One `ws` server serves every route, so the bound is one number: the largest over all
 * routes plus margin. Configurable as `WS_MAX_PAYLOAD_BYTES` (`server.wsMaxPayloadBytes`,
 * never below {@link WS_LARGEST_LEGITIMATE_MESSAGE_BYTES}).
 */
export const WS_MAX_PAYLOAD_DEFAULT_BYTES = AGENCY_WS_MAX_MESSAGE_BYTES;

/** The options `@fastify/websocket` is registered with: `ws`'s server options carry the bound. */
export function websocketPluginOptions(maxPayload: number = WS_MAX_PAYLOAD_DEFAULT_BYTES): {
  options: { maxPayload: number };
} {
  return { options: { maxPayload } };
}
