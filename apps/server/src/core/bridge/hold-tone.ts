/**
 * Tones the bridge generates itself, with no clip and no speech: the built-in hold tone an
 * on-hold inbound caller hears when the route has no hold clip (decision IQ24), and the beep
 * before a recording (`WebRtcBridgeManager.recordInboundAudio`). PCM16 little-endian mono, at
 * {@link TONE_SAMPLE_RATE}; the carrier module encodes them for its wire like any cached clip.
 *
 * The hold tone is a soft two-note chime followed by silence, played on a loop: it tells the
 * caller the line is still open without sounding like ringing (a ringback cadence would make a
 * caller think the call had not been answered) and without the fatigue of continuous music.
 */

/** Sample rate of every generated tone: telephony's own, so no carrier resamples it up. */
export const TONE_SAMPLE_RATE = 8000;

/** One piece of a tone pattern: a sine at `frequencyHz`, or silence when null. */
export interface ToneSegment {
  frequencyHz: number | null;
  durationMs: number;
}

/** Peak level of a generated tone, as a fraction of full scale (about -18 dBFS: present, never loud). */
const TONE_AMPLITUDE = 0.125;
/** Fade in and out of each note, so no note starts or stops with a click. */
const TONE_FADE_MS = 10;

/** The built-in hold tone: two short soft notes, then silence, about one chime every 4 s on a loop. */
export const HOLD_TONE_PATTERN: readonly ToneSegment[] = [
  { frequencyHz: 523.25, durationMs: 180 }, // C5
  { frequencyHz: null, durationMs: 60 },
  { frequencyHz: 659.25, durationMs: 240 }, // E5
  { frequencyHz: null, durationMs: 3520 },
];

/** The beep before a recording starts: one 400 ms note (decision IQ14). */
export const RECORD_BEEP_PATTERN: readonly ToneSegment[] = [
  { frequencyHz: null, durationMs: 100 },
  { frequencyHz: 1000, durationMs: 400 },
];

/** Render a pattern to PCM16 at {@link TONE_SAMPLE_RATE}. Pure; each note fades in and out. */
export function synthesizeTones(pattern: readonly ToneSegment[]): Buffer {
  const counts = pattern.map((s) => Math.max(0, Math.round((s.durationMs * TONE_SAMPLE_RATE) / 1000)));
  const out = Buffer.alloc(counts.reduce((a, b) => a + b, 0) * 2);
  const fade = Math.round((TONE_FADE_MS * TONE_SAMPLE_RATE) / 1000);
  let at = 0;
  pattern.forEach((segment, i) => {
    const n = counts[i]!;
    if (segment.frequencyHz !== null) {
      const step = (2 * Math.PI * segment.frequencyHz) / TONE_SAMPLE_RATE;
      for (let k = 0; k < n; k += 1) {
        const edge = Math.min(k, n - 1 - k);
        const envelope = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
        const sample = Math.round(Math.sin(step * k) * envelope * TONE_AMPLITUDE * 32767);
        out.writeInt16LE(sample, (at + k) * 2);
      }
    }
    at += n;
  });
  return out;
}

let holdTone: Buffer | null = null;
let recordBeep: Buffer | null = null;

/** The built-in hold tone, rendered once per process. */
export function holdTonePcm16(): { pcm16: Buffer; sampleRate: number } {
  holdTone ??= synthesizeTones(HOLD_TONE_PATTERN);
  return { pcm16: holdTone, sampleRate: TONE_SAMPLE_RATE };
}

/** The recording beep, rendered once per process. */
export function recordBeepPcm16(): { pcm16: Buffer; sampleRate: number } {
  recordBeep ??= synthesizeTones(RECORD_BEEP_PATTERN);
  return { pcm16: recordBeep, sampleRate: TONE_SAMPLE_RATE };
}
