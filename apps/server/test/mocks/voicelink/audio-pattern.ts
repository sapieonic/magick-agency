/**
 * Audio that can be checked for order and loss after it has been through the bridge's
 * real codec.
 *
 * The relay transcodes in both directions (A-law 8 kHz ⇄ PCM16 16 kHz, with stateful
 * FIR filters), so no byte of a frame survives the trip and a sequence number cannot
 * ride in the payload. What does survive is loudness: every frame is either a 1 kHz
 * tone ("loud") or silence ("quiet"), and a seeded bit pattern decides which. On the
 * far side each relayed frame is classified by its RMS, and the recovered bit string is
 * compared with the one sent. A dropped, duplicated or reordered frame shifts the
 * string; a frame relayed onto the wrong call carries that call's pattern instead.
 *
 * The threshold is not tuned to a machine: through the product's own transcoder a loud
 * 20 ms frame comes out at RMS ≈ 4100–4250 and a quiet one at ≤ ~950 (the FIR tail of a
 * loud predecessor), so anything between is a wide margin.
 */
import { decodeAlaw, encodeAlaw } from '../../../src/utils/audio.js';

/** Samples per 20 ms frame at the carrier's 8 kHz. */
export const ALAW_FRAME_SAMPLES = 160;
/** Samples per 20 ms frame at the browser's 16 kHz. */
export const PCM16K_FRAME_SAMPLES = 320;

const TONE_HZ = 1000;
const TONE_AMPLITUDE = 6000;
/** Loud frames measure ≈ 4100+, quiet ≤ ≈ 950 through the real transcoder. */
export const LOUD_RMS_THRESHOLD = 2500;

function tone(samples: number, rate: number, phase: number, loud: boolean): Int16Array {
  const pcm = new Int16Array(samples);
  if (!loud) return pcm;
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.round(TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * (phase + i)) / rate));
  }
  return pcm;
}

/** One 20 ms A-law frame (what the carrier sends). `index` keeps the tone phase continuous. */
export function alawFrame(index: number, loud: boolean): Buffer {
  return encodeAlaw(tone(ALAW_FRAME_SAMPLES, 8000, index * ALAW_FRAME_SAMPLES, loud));
}

/** One 20 ms PCM16 16 kHz frame (what the agent's browser sends). */
export function pcm16kFrame(index: number, loud: boolean): Buffer {
  const pcm = tone(PCM16K_FRAME_SAMPLES, 16000, index * PCM16K_FRAME_SAMPLES, loud);
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

function rms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

/** Loud/quiet of a PCM16 frame the bridge relayed to the browser. */
export function isLoudPcm16(frame: Buffer): boolean {
  const samples = new Int16Array(frame.buffer, frame.byteOffset, Math.floor(frame.byteLength / 2));
  return rms(samples) > LOUD_RMS_THRESHOLD;
}

/** Loud/quiet of an A-law frame the bridge relayed to the carrier. */
export function isLoudAlaw(frame: Buffer): boolean {
  return rms(decodeAlaw(frame)) > LOUD_RMS_THRESHOLD;
}

/** `true`/`false` → `1`/`0`, for readable failure diffs. */
export function bits(pattern: readonly boolean[]): string {
  return pattern.map((b) => (b ? '1' : '0')).join('');
}
