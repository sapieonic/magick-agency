import { resample } from '../utils/audio.js';

/**
 * Sample rate every clip played over the carrier media socket is cached at.
 *
 * 8 kHz is the telephony wire rate: G.711 A-law/mu-law are *defined* at 8 kHz
 * (1 byte/sample), and VoiceLink — the only carrier — forces A-law. So the audio is going to 8 kHz before it reaches the callee no matter
 * what; the only question is *when* we pay for the conversion.
 */
export const TELEPHONY_CLIP_SAMPLE_RATE = 8000;

/**
 * Downsample a decoded PCM16 clip to the 8 kHz telephony wire rate, so the
 * expensive resample happens ONCE when the clip is cached instead of on every
 * answered call.
 *
 * ── Why this exists (measured, not assumed) ──────────────────────────────────
 *
 * The WebRTC bridge converts the cached clip to the carrier's wire codec at play
 * time (`convertClipForCarrier`), while the callee holds a live, silent line. A
 * clip cached at its ORIGINAL upload rate (44.1 kHz for a typical MP3) would make
 * every play pay a 44.1 kHz → 8 kHz resample.
 *
 * The resample is the entire cost; the G.711 encode is free by comparison. For a
 * 58 s clip:
 *
 *     resample 44.1k → 8k      1906 ms   ← all of it
 *     pcmToAlaw  from 8k PCM       3 ms
 *     pcmToMulaw from 8k PCM       4 ms
 *     pcmToAlaw  from 44.1k     1908 ms   (= resample + encode)
 *
 * Cost scales with the SOURCE rate, not duration: 58 s @ 8 kHz is 3 ms, the same
 * 58 s @ 44.1 kHz is ~1.9 s, and a 120 s @ 44.1 kHz clip is ~3.9 s. It is a
 * windowed-sinc resampler (~176 taps/output-sample when downsampling by 5.5×),
 * which is the right choice for quality and simply expensive at high ratios.
 *
 * Caching at 8 kHz turns per-call conversion into a ~3 ms G.711 encode. It also
 * keeps that work off the event loop, where every concurrent call playing a clip
 * would otherwise pay it.
 *
 * ── Why 8 kHz PCM16 and not pre-encoded A-law ────────────────────────────────
 *
 * Committing the cache to one encoding would tie it to one carrier codec. 8 kHz
 * PCM16 is the common ancestor of A-law, mu-law and L16: A-law and mu-law encode
 * from it in ~3 ms, and an L16 carrier asking for 8 kHz needs no work at all. An
 * L16 carrier asking for 16 kHz would upsample from 8 kHz — acceptable because no
 * such carrier exists (VoiceLink is A-law-only) and the audio is band-limited to a
 * phone line regardless. Revisit only if a wideband carrier is added.
 *
 * Idempotent: a clip already at 8 kHz is returned untouched (`resample` short-
 * circuits when the rates match), which is what makes it safe to call on every
 * path that populates the cache.
 */
export function toTelephonyClip(
  pcm16: Buffer,
  sampleRate: number,
): { pcm16: Buffer; sampleRate: number } {
  if (sampleRate === TELEPHONY_CLIP_SAMPLE_RATE) {
    return { pcm16, sampleRate };
  }
  // Int16Array views require 2-byte alignment; copy when the buffer lands on an
  // odd byteOffset (same guard readTtsPcm applies).
  const aligned = pcm16.byteOffset % 2 === 0 ? pcm16 : Buffer.from(pcm16);
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
  const out = resample(samples, sampleRate, TELEPHONY_CLIP_SAMPLE_RATE);
  return {
    pcm16: Buffer.from(out.buffer, out.byteOffset, out.byteLength),
    sampleRate: TELEPHONY_CLIP_SAMPLE_RATE,
  };
}
