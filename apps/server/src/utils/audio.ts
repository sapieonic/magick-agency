// PORT NOTE (magick-agency): ported from magic-voice-core/src/utils/audio.ts@4850d1d9. Removed:
// `frameDurationMs` and its `AudioEncoding` import (AI live-adapter frame accounting only).

// ── G.711 μ-law encoding/decoding ────────────────────────────────────────────
// Standard ITU-T G.711 μ-law algorithm (Sun `g711.c`), the same reference form
// `encodeAlawSample`/`alawDecodeTable` below follow.
//
// The curve is not ours to choose: a μ-law carrier (twilio, telnyx, generic SIP,
// exotel in μ-law mode) decodes our bytes with the standard table, and we decode
// the caller's standard-encoded bytes on the way in. A self-consistent
// non-standard pair round-trips perfectly and is still wrong in both directions
// — the one this replaced carried ~6x the quantisation noise the standard curve
// does, worst at small amplitudes, i.e. on quiet speech.
//
// Everything below works in the standard's 14-bit domain (16-bit sample >> 2).
const MULAW_BIAS = 0x84;
// The G.711 clip point, 8159 in the 14-bit domain = 32636 at 16-bit scale. NOT
// full scale: a larger clamp lets `value + BIAS` overflow the segment search,
// which has no answer for it, and the loud sample wraps to the codeword for
// SILENCE instead of saturating.
const MULAW_CLIP = 8159;
// Segment end-points for the μ-law encoder search (14-bit, biased domain).
const MULAW_SEG_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

const mulawDecodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  // μ-law is transmitted inverted.
  const u = ~i & 0xff;
  let t = ((u & 0x0f) << 3) + MULAW_BIAS;
  t <<= (u & 0x70) >> 4;
  // In μ-law the sign bit (0x80) SET means negative (opposite of A-law).
  mulawDecodeTable[i] = (u & 0x80) !== 0 ? MULAW_BIAS - t : t - MULAW_BIAS;
}

export function decodeMulaw(mulawData: Buffer): Int16Array {
  const pcm = new Int16Array(mulawData.length);
  for (let i = 0; i < mulawData.length; i++) {
    pcm[i] = mulawDecodeTable[mulawData[i]!]!;
  }
  return pcm;
}

export function encodeMulaw(pcmData: Int16Array): Buffer {
  // allocUnsafe: every byte is overwritten in the loop below — safe, avoids zero-fill on hot path
  const mulaw = Buffer.allocUnsafe(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    mulaw[i] = encodeMulawSample(pcmData[i]!);
  }
  return mulaw;
}

function encodeMulawSample(sample: number): number {
  // Scale the 16-bit sample down to the 14-bit μ-law magnitude domain.
  let pcmVal = sample >> 2;

  let mask: number;
  if (pcmVal < 0) {
    mask = 0x7f; // sign (8th) bit = 0 → negative
    pcmVal = -pcmVal;
  } else {
    mask = 0xff; // sign bit = 1 → positive
  }

  if (pcmVal > MULAW_CLIP) pcmVal = MULAW_CLIP;
  pcmVal += MULAW_BIAS >> 2;

  // Find the segment (exponent) for the biased magnitude.
  let seg = 8;
  for (let i = 0; i < 8; i++) {
    if (pcmVal <= MULAW_SEG_END[i]!) {
      seg = i;
      break;
    }
  }

  if (seg >= 8) {
    // At the clip point the biased magnitude runs past the last segment →
    // maximum amplitude. This is the saturation the old full-scale clamp
    // inverted into silence.
    return (0x7f ^ mask) & 0xff;
  }

  return (((seg << 4) | ((pcmVal >> (seg + 1)) & 0x0f)) ^ mask) & 0xff;
}

// ── G.711 A-law encoding/decoding ────────────────────────────────────────────
// A-law is the European G.711 variant (µ-law is the North-American one). Some
// telephony carriers (e.g. VoiceLink's Indian carrier) force `audio/alaw` 8kHz
// on the media stream, so we need the same encode/decode/resample surface we
// already have for µ-law. Standard ITU-T G.711 A-law algorithm (Sun `g711.c`).
//
// A-law silence is 0xD5 (decodes to +8, ≈0); this matches the captured frames.

const alawDecodeTable = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const aval = i ^ 0x55; // A-law toggles the even bits before transmission
  let t = (aval & 0x0f) << 4;
  const seg = (aval & 0x70) >> 4;
  if (seg === 0) {
    t += 8;
  } else if (seg === 1) {
    t += 0x108;
  } else {
    t += 0x108;
    t <<= seg - 1;
  }
  // In A-law the sign bit (0x80) SET means positive (opposite of µ-law).
  alawDecodeTable[i] = (aval & 0x80) !== 0 ? t : -t;
}

// Segment end-points for the A-law encoder search (12-bit magnitude domain).
const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

export function decodeAlaw(alawData: Buffer): Int16Array {
  const pcm = new Int16Array(alawData.length);
  for (let i = 0; i < alawData.length; i++) {
    pcm[i] = alawDecodeTable[alawData[i]!]!;
  }
  return pcm;
}

export function encodeAlaw(pcmData: Int16Array): Buffer {
  // allocUnsafe: every byte is overwritten in the loop below — safe, avoids zero-fill on hot path
  const alaw = Buffer.allocUnsafe(pcmData.length);
  for (let i = 0; i < pcmData.length; i++) {
    alaw[i] = encodeAlawSample(pcmData[i]!);
  }
  return alaw;
}

function encodeAlawSample(sample: number): number {
  // Scale the 16-bit sample down to the 12-bit A-law magnitude domain.
  let pcmVal = sample >> 3;

  let mask: number;
  if (pcmVal >= 0) {
    mask = 0xd5; // sign (7th) bit = 1 → positive
  } else {
    mask = 0x55; // sign bit = 0 → negative
    pcmVal = -pcmVal - 1;
  }

  // Find the segment (exponent) for the magnitude.
  let seg = 8;
  for (let i = 0; i < 8; i++) {
    if (pcmVal <= ALAW_SEG_END[i]!) {
      seg = i;
      break;
    }
  }

  if (seg >= 8) {
    // Out of range → maximum magnitude.
    return (0x7f ^ mask) & 0xff;
  }

  let aval = seg << 4;
  if (seg < 2) {
    aval |= (pcmVal >> 1) & 0x0f;
  } else {
    aval |= (pcmVal >> seg) & 0x0f;
  }
  return (aval ^ mask) & 0xff;
}

/**
 * Band-limited windowed-sinc resampler.
 * Converts PCM16 audio from one sample rate to another with proper
 * anti-aliasing (downsampling) and anti-imaging (upsampling).
 *
 * Uses a Blackman-windowed sinc kernel (~74dB stopband attenuation)
 * with 16-tap half-width — good quality/performance tradeoff for
 * real-time telephony voice (8kHz ↔ 16kHz ↔ 24kHz).
 */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const outputLength = Math.round(input.length / ratio);
  const output = new Int16Array(outputLength);

  // When downsampling, scale the sinc cutoff to prevent aliasing.
  // filterScale < 1 narrows the passband; when upsampling it stays 1.
  const filterScale = Math.min(1.0, toRate / fromRate);

  // Half-width of the sinc kernel in scaled-domain samples.
  // 16 taps provides ~74dB stopband with Blackman window.
  const KERNEL_HALF = 16;
  // Effective radius in input samples (wider when downsampling)
  const effectiveRadius = KERNEL_HALF / filterScale;

  for (let i = 0; i < outputLength; i++) {
    const center = i * ratio;
    const start = Math.max(0, Math.ceil(center - effectiveRadius));
    const end = Math.min(input.length - 1, Math.floor(center + effectiveRadius));

    let sum = 0;
    let weightSum = 0;

    for (let j = start; j <= end; j++) {
      const x = (j - center) * filterScale;

      // sinc(x) = sin(πx) / (πx), with sinc(0) = 1
      const sinc = Math.abs(x) < 1e-6
        ? 1.0
        : Math.sin(Math.PI * x) / (Math.PI * x);

      // Blackman window over the kernel radius
      const wArg = x / KERNEL_HALF;
      const w = Math.abs(wArg) <= 1.0
        ? 0.42 + 0.5 * Math.cos(Math.PI * wArg) + 0.08 * Math.cos(2 * Math.PI * wArg)
        : 0;

      const weight = sinc * w * filterScale;
      sum += input[j]! * weight;
      weightSum += weight;
    }

    // Normalize to preserve gain, clamp to Int16 range
    const sample = weightSum > 0 ? sum / weightSum : 0;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }

  return output;
}

/**
 * Convert telephony μ-law 8kHz to PCM16 at target sample rate
 */
export function mulawToTargetPcm(mulawData: Buffer, targetRate: number): Buffer {
  const pcm8k = decodeMulaw(mulawData);
  const resampled = resample(pcm8k, 8000, targetRate);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

/**
 * Convert PCM16 at source sample rate to telephony μ-law 8kHz
 */
export function pcmToMulaw(pcmData: Buffer, sourceRate: number): Buffer {
  const pcm = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
  const resampled = resample(pcm, sourceRate, 8000);
  return encodeMulaw(resampled);
}

/**
 * Convert telephony A-law 8kHz to PCM16 at target sample rate
 */
export function alawToTargetPcm(alawData: Buffer, targetRate: number): Buffer {
  const pcm8k = decodeAlaw(alawData);
  const resampled = resample(pcm8k, 8000, targetRate);
  return Buffer.from(resampled.buffer, resampled.byteOffset, resampled.byteLength);
}

/**
 * Convert PCM16 at source sample rate to telephony A-law 8kHz
 */
export function pcmToAlaw(pcmData: Buffer, sourceRate: number): Buffer {
  const pcm = new Int16Array(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength / 2);
  const resampled = resample(pcm, sourceRate, 8000);
  return encodeAlaw(resampled);
}

/**
 * Average interleaved N-channel PCM16 down to mono.
 *
 * Averages rather than dropping channels: dropping loses anything panned to the
 * discarded side, which on a customer-supplied announcement can mean losing the
 * voice entirely. Needed because `sndfile-convert` has no `-mono` option, so
 * stereo WAV/OGG comes back interleaved and must be downmixed here.
 *
 * `channels <= 1` returns the input unchanged. A trailing partial frame is
 * dropped so the output is always whole samples.
 */
export function downmixToMono(pcm16: Buffer, channels: number): Buffer {
  if (channels <= 1) return pcm16;

  const bytesPerFrame = 2 * channels;
  const frames = Math.floor(pcm16.length / bytesPerFrame);
  // allocUnsafe: every byte is overwritten in the loop below
  const out = Buffer.allocUnsafe(frames * 2);

  for (let frame = 0; frame < frames; frame++) {
    const base = frame * bytesPerFrame;
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      sum += pcm16.readInt16LE(base + ch * 2);
    }
    // Round toward zero, then clamp — averaging cannot overflow int16, but a
    // rounding step at the extremes could land on ±32768.
    let sample = Math.round(sum / channels);
    if (sample > 32767) sample = 32767;
    else if (sample < -32768) sample = -32768;
    out.writeInt16LE(sample, frame * 2);
  }

  return out;
}

/**
 * Accumulate audio chunks until the buffer reaches the target duration
 */
export class AudioBuffer {
  private buffers: Buffer[] = [];
  private totalLength = 0;
  private readonly targetBytes: number;

  constructor(targetDurationMs: number, sampleRate: number, bytesPerSample: number = 1) {
    this.targetBytes = Math.round((targetDurationMs / 1000) * sampleRate * bytesPerSample);
  }

  push(chunk: Buffer): Buffer | null {
    this.buffers.push(chunk);
    this.totalLength += chunk.length;

    if (this.totalLength >= this.targetBytes) {
      const result = Buffer.concat(this.buffers);
      this.buffers = [];
      this.totalLength = 0;
      return result;
    }

    return null;
  }

  flush(): Buffer | null {
    if (this.buffers.length === 0) return null;
    const result = Buffer.concat(this.buffers);
    this.buffers = [];
    this.totalLength = 0;
    return result;
  }

  clear(): void {
    this.buffers = [];
    this.totalLength = 0;
  }
}
