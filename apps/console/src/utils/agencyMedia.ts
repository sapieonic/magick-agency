/**
 * The agency station socket's **audio wire format**, in one place.
 *
 * Everything here is transcribed from core rather than assumed, because the
 * console is the only participant that has to *produce* the format and the cost
 * of getting it wrong is a call that connects, bills, and carries no sound.
 *
 * ── What core sends us (downlink) ────────────────────────────────────────────
 *   `{ event: 'media', media: { payload: <base64> } }`
 * `payload` is **PCM16, mono, 16 kHz, little-endian**. Core normalises both
 * carriers to it before writing to this socket: VoiceLink's G.711 A-law 8 kHz is
 * transcoded (`magic-voice-core/src/core/webrtc-bridge-manager.ts:1154`) and
 * VoBiz's L16 16 kHz is passed through verbatim (`:1157`).
 *
 * ── What core expects from us (uplink) ───────────────────────────────────────
 * The **same envelope in the same encoding** (`:1083`, `:1099-1109`). Core reads
 * `data.event === 'media' && typeof data.media?.payload === 'string'` and then
 * transcodes *outbound* per carrier. So the asymmetry that exists — A-law for
 * VoiceLink, L16 for VoBiz — is entirely on core's far side. **The console has
 * exactly one format to produce and one to consume, and neither depends on which
 * carrier is dialling.** That is worth stating because the obvious guess (mirror
 * whatever the carrier uses) would be wrong and would fail per-carrier.
 *
 * There is **no handshake**. Core's browser-side listener treats
 * `start`/`connected`/`stop` as informational and acts on nothing but `media`
 * (`:1117`), unlike the AI-call media-stream path where `useBrowserCall` opens
 * with a `start`. Sending one here would be harmless and meaningless, so we
 * don't — a frame nobody reads is the exact shape of the dead `hangup` frame
 * `MAG-112` removed.
 *
 * Master relays both directions untouched
 * (`magick-master/src/api/routes/proxy-agency-station.routes.ts:151-167`), so
 * there is no third format in the middle.
 */

/** Core normalises every carrier to this before the socket. Hz. */
export const AGENCY_MEDIA_SAMPLE_RATE = 16000;

/**
 * Samples per outbound frame — 20 ms at 16 kHz, which is what
 * `pcm16-processor` already emits for the AI-call path. Kept as a named constant
 * because the playback jitter cushion below is expressed in whole frames of it.
 */
export const AGENCY_MEDIA_FRAME_SAMPLES = 320;

/**
 * Core's ceiling, transcribed: `MAX_MEDIA_FRAME_BYTES * 2` where
 * `MAX_MEDIA_FRAME_BYTES = 64000` (`webrtc-bridge-manager.ts:182`), compared
 * against `data.media.payload.length` — the **encoded** string — at `:1089`
 * (uplink) and `:1143` (downlink).
 *
 * ── What the `* 2` is, and what it is not ───────────────────────────────────
 * It is **not** a base64 conversion. Base64 expands 4/3, not 2, so the honest
 * encoded bound for 64000 decoded bytes would be `ceil(64000/3)*4 = 85336`.
 * Core's own comment at `:1088` calls the limit "bytes" while its code measures
 * characters, so `* 2` is a loose safety factor sitting on top of a units
 * mismatch. An earlier revision of this file repeated core's confusion back as
 * if it were the derivation, which is worse than either mistake alone: the value
 * was right and the stated reason was wrong, so a reader checking the arithmetic
 * would have concluded the constant was wrong and "fixed" it.
 *
 * ── Why 128000 and not 85336 ────────────────────────────────────────────────
 * Because this must match what core **actually rejects**, not what it ought to.
 * A tighter bound here would reject frames core accepts; a looser one would ship
 * frames into core's silent drop. It is transcribed, and it must be re-checked
 * against `webrtc-bridge-manager.ts:182` whenever that file moves — there is no
 * build-time link between the repos that could catch it.
 *
 * ── This is not a protective bound in practice ──────────────────────────────
 * A 20 ms frame is 640 bytes → **856 base64 characters**, 0.7% of this ceiling.
 * Nothing the capture graph produces can approach it. The check exists so that a
 * broken graph upstream fails visibly on this side rather than becoming audio
 * that never arrives two services away — not because normal traffic is near it.
 */
export const MAX_AGENCY_MEDIA_PAYLOAD_CHARS = 128000;

/**
 * The uplink frame, serialised.
 *
 * Returns `null` for a payload core would drop, so the caller can count the drop
 * instead of shipping a frame into a silent discard.
 */
export function encodeAgencyMediaFrame(payload: string): string | null {
  if (payload.length === 0 || payload.length > MAX_AGENCY_MEDIA_PAYLOAD_CHARS) return null;
  return JSON.stringify({ event: 'media', media: { payload } });
}

/**
 * Read a downlink payload off an already-parsed frame.
 *
 * Deliberately tolerant in the same way core's reader is — `typeof payload ===
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
