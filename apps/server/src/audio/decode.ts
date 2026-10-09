import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { downmixToMono } from '../utils/audio.js';
import { runExclusive } from '../utils/decode-gate.js';
import { STATIC_CALL_MAX_DURATION_SECONDS } from '@magick-agency/db/models/static-call.model';

const log = createChildLogger({ component: 'audio-decode' });

export interface DecodedAudio {
  /** Mono, signed 16-bit LE. */
  pcm16: Buffer;
  /** Native sample rate — deliberately NOT resampled; `pcmToAlaw` handles 8 kHz downstream. */
  sampleRate: number;
  durationSeconds: number;
  decoder: 'mpg123' | 'sndfile';
}

export type AudioDecodeErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'DECODE_FAILED'
  | 'DECODE_TIMEOUT'
  | 'EMPTY_AUDIO'
  | 'TOO_LONG'
  | 'AUDIO_TRUNCATED';

export class AudioDecodeError extends Error {
  readonly code: AudioDecodeErrorCode;
  /** Decoder stderr, for logs only. MUST NOT be returned to a client as-is. */
  readonly detail?: string;
  /** Populated for TOO_LONG so the caller can name the actual duration. */
  readonly durationSeconds?: number;

  constructor(code: AudioDecodeErrorCode, message: string, opts?: { detail?: string; durationSeconds?: number }) {
    super(message);
    this.name = 'AudioDecodeError';
    this.code = code;
    if (opts?.detail !== undefined) this.detail = opts.detail;
    if (opts?.durationSeconds !== undefined) this.durationSeconds = opts.durationSeconds;
  }
}

// ── Toolchain routing (MEASURED) ────────────────────────────────────────
//
// It is tempting to prefer `mpg123` everywhere for its free downmix, on the
// theory that it covers wav/ogg too ("exit 0 on both"). That is WRONG, and
// dangerously so: `mpg123` is an *MPEG* decoder. Fed a WAV or OGG it
// scans for MPEG frame headers, finds none, prints "Illegal Audio-MPEG-Header"
// / "Hit end of (available) data during resync", writes NO output file at all —
// and still **exits 0**. Exit status alone would have reported success on a file
// that produced zero audio. (A stereo WAV happens to exit 1, a mono WAV exits 0;
// the difference is incidental, not a usable signal.)
//
// Measured coverage on real fixtures (0.5 s tones):
//
//   | Input                | mpg123 -q -m -w        | sndfile-convert -pcm16 |
//   |----------------------|------------------------|------------------------|
//   | MP3 mono   44.1k     | ✅ PCM16 mono  44100   | ✅ PCM16 mono  44100   |
//   | MP3 stereo 44.1k     | ✅ PCM16 MONO  44100   | ⚠️ PCM16 2ch  44100   |
//   | WAV mono   16k       | ❌ exit 0, no file     | ✅ PCM16 mono  16000   |
//   | WAV stereo 44.1k     | ❌ exit 1, no file     | ⚠️ PCM16 2ch  44100   |
//   | OGG mono   16k       | ❌ exit 0, no file     | ✅ PCM16 mono  16000   |
//   | OGG stereo 44.1k     | ❌ exit 0, no file     | ⚠️ PCM16 2ch  44100   |
//   | M4A/AAC              | ❌ exit 0, no file     | ❌ "Format not         |
//   |                      |                        |    recognised", exit 1 |
//
// So routing is by format, not by try-then-fall-back:
//   • MP3 (`audio/mpeg`)   → mpg123, which downmixes for free (`-m`).
//   • WAV / OGG            → sndfile-convert, then downmix in JS — it has
//                            no `-mono`/`-channels` flag (confirmed: not in its
//                            usage output).
// A mislabelled upload still gets the other tool as a fallback, so a WAV sent as
// `audio/mpeg` decodes rather than 400s.
//
// Because a zero-exit can mean "wrote nothing", success is determined by the
// OUTPUT FILE (present, parseable, non-empty) and never by the exit code alone.

const MPG123_BIN = process.env['MPG123_BIN'] || 'mpg123';
const SNDFILE_CONVERT_BIN = process.env['SNDFILE_CONVERT_BIN'] || 'sndfile-convert';

/**
 * Scratch space for the decode. Each call writes the uploaded bytes AND the
 * decoded WAV here, so a 10 MB MP3 can need >100 MB transiently (PCM16 is far
 * larger than a compressed source). `os.tmpdir()` in a container is frequently a
 * small tmpfs sized for nothing of the sort, hence the override.
 */
const AUDIO_DECODE_TMP_DIR = process.env['AUDIO_DECODE_TMP_DIR'] || os.tmpdir();

/** Prefix for the per-decode temp dir; also what the cleanup assertions look for. */
export const DECODE_TMP_PREFIX = 'audio-decode-';

// ── Truncation guard ──────────────────────────────────────────────────
//
// A truncated-but-partially-decodable file is the ONE input class that produces a
// silent call rather than an error: 90% off a 0.5s MP3 still decodes — to 1.1ms of
// audio — which passes every "is it non-empty" check, persists a short
// `duration_seconds`, plays nothing audible, and completes as a connected
// call. A silently-wrong result is worse than a failure, because a
// failure is visible.
//
// Dialer analysis already solves this class
// (`AUDIO_SHORTFALL_RATIO` in `src/core/dialer-analysis-runner.ts`): cross-check the
// decoded/transcribed coverage against an INDEPENDENT expectation of the source's
// duration and treat a large shortfall as truncation. Same name, same ratio, same
// reasoning — one idiom, not two.

/**
 * Reject when decoded coverage falls below this fraction of the independently
 * estimated source duration. 0.8 mirrors dialer-analysis exactly.
 *
 * Measured headroom on the committed fixtures: an INTACT MP3 decodes to 0.91 of
 * its Xing-declared duration (the encoder's declared frame count includes
 * decoder-delay/padding frames the decoder correctly drops), while 50%-truncated
 * lands at 0.38 and 90%-truncated at 0.002. So 0.8 sits comfortably between the
 * legitimate encoder overhead and any real truncation.
 */
export const AUDIO_SHORTFALL_RATIO = 0.8;

/**
 * Absolute floor on a decoded announcement, in seconds.
 *
 * The shortfall ratio needs an independent duration estimate; this does not, so it
 * is the fallback for any format/file where no estimate is cheaply available (a
 * headerless/CBR-less MP3, an OGG). Nothing shorter than this is a usable
 * announcement — it is a fragment of one — so rejecting is strictly better than
 * dialing it.
 *
 * 0.25s, NOT 0.5s: the committed fixtures decode to
 * exactly 0.5000s, so a 0.5 floor would sit precisely on the boundary of input the
 * product must accept — one rounding step from rejecting legitimate audio. This is
 * a coarse net for millisecond fragments (the 90%-truncated case decodes to
 * 0.0011s), not a duration policy, so it should sit well clear of anything real;
 * the shortfall ratio is what catches the subtler truncations. The shortest
 * plausible real announcement ("Your payment is due") is ~2s, so 0.25 still has
 * an order of magnitude of headroom.
 */
export const MIN_PLAUSIBLE_CLIP_SECONDS = 0.25;

/**
 * Hard ceiling on the decoder's OUTPUT file, enforced DURING decode.
 *
 * The compressed INPUT size does not bound the output: PCM16 amplifies
 * enormously (measured: a 7.2 MB / 2h / 8 kbps MP3 decodes to a 115 MB WAV in
 * 333 ms — ~16×), and a 120s duration cap checked only AFTER the whole clip was
 * materialized to disk AND read into a Buffer comes too late. A burst of
 * concurrent decodes could otherwise pin far more memory + scratch disk than the
 * input size implies, and compete with live-call CPU on the same container.
 *
 * Computed honestly from the product cap: the largest a VALID clip can be is
 * `STATIC_CALL_MAX_DURATION_SECONDS` × the maximum plausible sample rate (48 kHz)
 * × 2 bytes/sample × 2 channels (sndfile-convert does not downmix; the JS downmix
 * happens after), ≈ 23 MB, plus a small allowance for the WAV header and any
 * LIST/INFO chunk. Anything past that cannot be a valid clip at any sample rate we
 * accept, so the child is killed rather than allowed to finish writing.
 */
const MAX_DECODED_SAMPLE_RATE = 48_000;
const MAX_DECODED_CHANNELS = 2;
export const MAX_DECODED_OUTPUT_BYTES =
  STATIC_CALL_MAX_DURATION_SECONDS * MAX_DECODED_SAMPLE_RATE * 2 * MAX_DECODED_CHANNELS + 1_048_576;

/** How often the output-size watchdog stats the decoder's output file. */
const OUTPUT_WATCH_INTERVAL_MS = 100;

type Decoder = 'mpg123' | 'sndfile';

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
};

/** Decoder preference order per MIME. First entry is the primary; the rest are fallbacks. */
function decoderChain(contentType: string): Decoder[] {
  return contentType === 'audio/mpeg' ? ['mpg123', 'sndfile'] : ['sndfile', 'mpg123'];
}

/**
 * Decode an uploaded audio buffer to mono PCM16 at its native sample rate.
 *
 * Runs the decoder as a CHILD PROCESS over a temp file — never in-process FFI.
 * These are C parsers being handed untrusted bytes; a segfault must cost us one
 * short-lived subprocess, not the whole service.
 *
 * Throws {@link AudioDecodeError} for every failure mode. Never returns an empty
 * clip. Temp files are removed on every exit path, including timeout.
 *
 * The compressed input is not size-capped here; the decoded output is
 * ({@link MAX_DECODED_OUTPUT_BYTES}).
 *
 * `maxOutputBytes`/`onOutputTooLarge` exist so a test can drive the in-flight
 * watchdog deterministically (the production ceiling is only reachable with a
 * multi-megabyte input, and a fast decode can outrun the poll interval). Neither
 * is set by production callers.
 *
 * Concurrency is bounded process-wide by {@link runExclusive}
 * (`config.audio.decodeConcurrency`, default 2) — see the acquisition comment
 * below for why the gate lives here rather than at each call site.
 */
export async function decodeToPcm16(
  input: Buffer,
  contentType: string,
  opts?: { timeoutMs?: number; maxOutputBytes?: number; onOutputTooLarge?: (bytes: number) => void },
): Promise<DecodedAudio> {
  // ── Cheap synchronous validation, BEFORE the gate ────────────────────────────
  //
  // A malformed request must fail instantly rather than wait behind real decode
  // work: neither of these guards touches the filesystem or spawns anything, so
  // holding a permit to run them would be pure queueing latency for a request
  // whose answer is already known. This also keeps a flood of bad uploads from
  // occupying queue slots that legitimate decodes are waiting for.
  const ext = EXT_BY_CONTENT_TYPE[contentType];
  if (!ext) {
    throw new AudioDecodeError(
      'UNSUPPORTED_FORMAT',
      `Unsupported audio type: ${contentType}. Supported: ${Object.keys(EXT_BY_CONTENT_TYPE).join(', ')}`,
    );
  }
  if (input.length === 0) {
    throw new AudioDecodeError('EMPTY_AUDIO', 'Uploaded file is empty');
  }

  // ── Everything past here holds a decode permit ───────────────────────────────
  //
  // The gate is applied INSIDE this function, not at the call sites, so every
  // caller is covered by construction — today that is `ensurePcmClip`'s decode —
  // and a future caller cannot forget to opt in.
  //
  // WHICH CLOCK COVERS WHAT: `timeoutMs` is started by `runDecoder`, per spawned
  // child, and therefore begins only after the permit is held — it measures the
  // DECODE, never the queue wait. That ordering is load-bearing: if the clock
  // started before acquisition, a job queued behind a slow decode could exhaust
  // its whole budget having done zero work and fail with DECODE_TIMEOUT — a
  // self-inflicted failure under exactly the load this gate exists to absorb.
  // A queued caller's total wall time is therefore unbounded by design (bounded in
  // practice by the queue drain rate); only the decode itself is deadlined.
  return runExclusive(() => decodeUnderPermit(input, contentType, ext, opts));
}

/**
 * The decode proper, run while holding a permit from {@link runExclusive}.
 *
 * Split out of {@link decodeToPcm16} purely so the guarded region is explicit and
 * the validation above it demonstrably cheap. Every deadline inside — notably the
 * per-child `timeoutMs` — starts here, i.e. after acquisition.
 */
async function decodeUnderPermit(
  input: Buffer,
  contentType: string,
  ext: string,
  opts?: { timeoutMs?: number; maxOutputBytes?: number; onOutputTooLarge?: (bytes: number) => void },
): Promise<DecodedAudio> {
  const timeoutMs = opts?.timeoutMs ?? config.audio.decodeTimeoutMs;
  const maxOutputBytes = opts?.maxOutputBytes ?? MAX_DECODED_OUTPUT_BYTES;
  const dir = await fs.mkdtemp(path.join(AUDIO_DECODE_TMP_DIR, DECODE_TMP_PREFIX));
  const inPath = path.join(dir, `in.${ext}`);
  const outPath = path.join(dir, 'out.wav');

  try {
    await fs.writeFile(inPath, input);

    const failures: { decoder: Decoder; reason: string }[] = [];

    for (const decoder of decoderChain(contentType)) {
      // A previous attempt may have left a partial/zero-sample file behind.
      await fs.rm(outPath, { force: true });

      const run = await runDecoder(decoder, inPath, outPath, timeoutMs, maxOutputBytes);
      if (run.timedOut) {
        throw new AudioDecodeError('DECODE_TIMEOUT', `Audio decode exceeded ${timeoutMs}ms`, {
          detail: run.stderr,
        });
      }
      if (run.outputTooLarge) {
        // Killed mid-write: the clip is longer than the product cap allows at ANY
        // sample rate we accept. Reported as TOO_LONG because that is what it is
        // from the customer's side — but WITHOUT a duration, since we deliberately
        // never finished decoding to learn one.
        if (run.outputBytes !== undefined) opts?.onOutputTooLarge?.(run.outputBytes);
        log.warn(
          { decoder, contentType, inputBytes: input.length, outputBytes: run.outputBytes, maxOutputBytes },
          'Rejected audio: decoded output exceeded the maximum valid clip size',
        );
        throw new AudioDecodeError(
          'TOO_LONG',
          `Audio is longer than the ${STATIC_CALL_MAX_DURATION_SECONDS}s maximum. Please upload a shorter clip.`,
          { detail: `decoded output exceeded ${maxOutputBytes} bytes` },
        );
      }

      // Size-gate BEFORE reading. The watchdog above bounds a decode that runs long
      // enough to be sampled, but a fast one (measured: a 45 MB decode completes in
      // ~200 ms) can finish between two polls — and the heap cost is paid by this
      // `readFile`, not by the decode. Stat-then-read makes the memory bound
      // deterministic rather than a function of poll timing.
      let outputBytes: number;
      try {
        outputBytes = (await fs.stat(outPath)).size;
      } catch {
        // Zero-exit with no output file — mpg123's behaviour on non-MPEG input.
        failures.push({ decoder, reason: `no output (exit ${run.exitCode ?? 'signal'})` });
        continue;
      }
      if (outputBytes > maxOutputBytes) {
        log.warn(
          { decoder, contentType, inputBytes: input.length, outputBytes, maxBytes: maxOutputBytes },
          'Rejected audio: decoded output exceeded the maximum valid clip size',
        );
        throw new AudioDecodeError(
          'TOO_LONG',
          `Audio is longer than the ${STATIC_CALL_MAX_DURATION_SECONDS}s maximum. Please upload a shorter clip.`,
          { detail: `decoded output ${outputBytes} bytes exceeded ${maxOutputBytes}` },
        );
      }

      const wav = await fs.readFile(outPath);

      const parsed = parseWavPcm16(wav);
      if (!parsed) {
        failures.push({ decoder, reason: `unparseable output (exit ${run.exitCode ?? 'signal'})` });
        continue;
      }
      if (parsed.pcm.length === 0) {
        failures.push({ decoder, reason: 'zero samples' });
        continue;
      }

      const pcm16 = parsed.channels > 1 ? downmixToMono(parsed.pcm, parsed.channels) : parsed.pcm;
      const frames = pcm16.length / 2;
      const durationSeconds = frames / parsed.sampleRate;

      if (frames === 0 || durationSeconds <= 0) {
        failures.push({ decoder, reason: 'zero samples after downmix' });
        continue;
      }
      if (durationSeconds > STATIC_CALL_MAX_DURATION_SECONDS) {
        throw new AudioDecodeError(
          'TOO_LONG',
          `Audio is ${durationSeconds.toFixed(1)}s long. Maximum is ${STATIC_CALL_MAX_DURATION_SECONDS}s.`,
          { durationSeconds },
        );
      }

      // ── Truncation cross-check ──────────────────────────────────────
      //
      // Everything above proves the decode produced SOME audio. This proves it
      // produced the audio the file claims to hold. Both guards throw rather than
      // `continue`: a truncated file is truncated for every decoder in the chain,
      // so falling through to the fallback would only re-decode the same bytes and
      // report the vaguer DECODE_FAILED.
      const expectedSeconds = estimateSourceDurationSeconds(input, contentType);
      if (expectedSeconds !== null && expectedSeconds > 0) {
        const coverageRatio = durationSeconds / expectedSeconds;
        if (coverageRatio < AUDIO_SHORTFALL_RATIO) {
          log.warn(
            {
              decoder,
              contentType,
              bytes: input.length,
              decodedSeconds: Number(durationSeconds.toFixed(3)),
              expectedSeconds: Number(expectedSeconds.toFixed(3)),
              coverageRatio: Number(coverageRatio.toFixed(3)),
              shortfallRatio: AUDIO_SHORTFALL_RATIO,
              audioTruncated: true,
            },
            'Rejected audio: decoded far less than the file declares (truncated upload)',
          );
          throw new AudioDecodeError(
            'AUDIO_TRUNCATED',
            'This file appears incomplete — only part of it could be read. ' +
              'Try re-uploading it.',
            {
              detail: `decoded ${durationSeconds.toFixed(3)}s of an expected ${expectedSeconds.toFixed(3)}s (${(coverageRatio * 100).toFixed(1)}% coverage)`,
              durationSeconds,
            },
          );
        }
      }

      // Plausibility floor. Independent of any estimate, so it is the ONLY guard
      // for a format where none is available (OGG, a headerless VBR MP3) — and a
      // cheap second net under the ratio for everything else.
      if (durationSeconds < MIN_PLAUSIBLE_CLIP_SECONDS) {
        log.warn(
          {
            decoder,
            contentType,
            bytes: input.length,
            decodedSeconds: Number(durationSeconds.toFixed(3)),
            minSeconds: MIN_PLAUSIBLE_CLIP_SECONDS,
            hadEstimate: expectedSeconds !== null,
            audioTruncated: true,
          },
          'Rejected audio: decoded clip is implausibly short for an announcement',
        );
        throw new AudioDecodeError(
          'AUDIO_TRUNCATED',
          `This file only contains ${durationSeconds.toFixed(2)}s of audio, which is too short to play as an announcement. ` +
            'It may be incomplete — try re-uploading it.',
          { durationSeconds },
        );
      }

      log.debug(
        { decoder, contentType, sampleRate: parsed.sampleRate, srcChannels: parsed.channels, durationSeconds },
        'Audio decoded to mono PCM16',
      );

      return { pcm16, sampleRate: parsed.sampleRate, durationSeconds, decoder };
    }

    // Every decoder in the chain declined. Corrupt, truncated, or a MIME that
    // does not match the bytes — indistinguishable from here, and the client
    // action is the same either way.
    const detail = failures.map((f) => `${f.decoder}: ${f.reason}`).join('; ');
    log.warn({ contentType, bytes: input.length, detail }, 'Audio decode failed on every decoder');
    throw new AudioDecodeError(
      'DECODE_FAILED',
      'Could not decode the audio file. It may be corrupt, truncated, or not really a ' +
        `${contentType} file.`,
      { detail },
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch((err) => {
      log.warn({ err, dir }, 'Failed to clean up audio decode temp dir');
    });
  }
}

// ── Independent source-duration estimation ───────────────────────────────────
//
// "Independent" is the load-bearing word: the estimate must come from the SOURCE
// bytes, not from the decoder, or a truncation would shrink both sides of the
// comparison equally and the ratio would always look fine.
//
// The estimate is a lower bound on what SHOULD have decoded. It is intentionally
// best-effort: `null` means "no cheap estimate for these bytes", and the caller
// falls back to MIN_PLAUSIBLE_CLIP_SECONDS alone.

const MPEG_V1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG_V2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
// Indexed by the header's version field (3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5; 1 is reserved).
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** Length of a leading ID3v2 tag, so the frame scan starts at real audio. */
function id3v2Length(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return 0;
  // Syncsafe integer: 7 bits per byte.
  const size =
    ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  // Bit 4 of the flags byte marks a footer, which is a further 10 bytes.
  return 10 + size + ((buf[5]! & 0x10) !== 0 ? 10 : 0);
}

/**
 * Estimate an MP3's intended duration from its own headers.
 *
 * Two sources, in preference order:
 *
 *  1. **Xing/Info frame count.** Encoders (LAME/ffmpeg) write a header frame
 *     declaring the TOTAL frame count of the file. It lives in the FIRST audio
 *     frame, so it SURVIVES truncation intact — which is exactly what makes it a
 *     genuinely independent expectation. Verified on the committed fixture: full,
 *     50%-truncated and 90%-truncated all still report 21 frames / 0.549s.
 *  2. **Bitrate × remaining bytes** for a CBR file with no Xing header. This one is
 *     NOT truncation-proof (it shrinks with the file), so it can only catch a
 *     truncation the decoder itself also mangles — a weak but non-zero signal, and
 *     strictly better than nothing. VBR without a Xing header is unestimable this
 *     way and returns null.
 *
 * Returns null when no frame header is found in the first 64 KB (garbage bytes,
 * or a file the decoder will reject anyway).
 */
export function estimateMp3DurationSeconds(buf: Buffer): number | null {
  const start = id3v2Length(buf);
  // Bound the scan: a valid MP3's first frame is near the front, and an unbounded
  // byte-by-byte resync over 10 MB of garbage is pure waste.
  const scanEnd = Math.min(buf.length - 4, start + 65_536);

  for (let i = Math.max(0, start); i <= scanEnd; i++) {
    if (buf[i] !== 0xff || (buf[i + 1]! & 0xe0) !== 0xe0) continue;

    const b1 = buf[i + 1]!;
    const b2 = buf[i + 2]!;
    const b3 = buf[i + 3]!;
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = (b2 >> 4) & 0xf;
    const rateIndex = (b2 >> 2) & 3;
    const channelMode = (b3 >> 6) & 3;

    // Layer III only (layer field 1), valid version, real bitrate/sample-rate indices.
    if (layer !== 1 || version === 1 || rateIndex === 3) continue;
    if (bitrateIndex === 0 || bitrateIndex === 15) continue;

    const sampleRate = MPEG_SAMPLE_RATES[version]?.[rateIndex];
    const bitrate = (version === 3 ? MPEG_V1_L3_BITRATES : MPEG_V2_L3_BITRATES)[bitrateIndex]! * 1000;
    if (!sampleRate || !bitrate) continue;

    const samplesPerFrame = version === 3 ? 1152 : 576;

    // Xing/Info sits after the frame header + the side-information block, whose
    // size depends on version and mono-vs-stereo.
    const sideInfo =
      version === 3 ? (channelMode === 3 ? 17 : 32) : channelMode === 3 ? 9 : 17;
    const tagAt = i + 4 + sideInfo;
    if (tagAt + 8 <= buf.length) {
      const tag = buf.toString('ascii', tagAt, tagAt + 4);
      if (tag === 'Xing' || tag === 'Info') {
        const flags = buf.readUInt32BE(tagAt + 4);
        // Bit 0 = frame count present, and it is the first optional field.
        if ((flags & 1) !== 0 && tagAt + 12 <= buf.length) {
          const frames = buf.readUInt32BE(tagAt + 8);
          if (frames > 0) return (frames * samplesPerFrame) / sampleRate;
        }
      }
    }

    // No usable Xing — fall back to CBR arithmetic over the bytes we actually have.
    return ((buf.length - i) * 8) / bitrate;
  }

  return null;
}

/**
 * Estimate a WAV's intended duration from its DECLARED `data` chunk size.
 *
 * A truncated WAV keeps its original header, so the declared size still describes
 * the whole file while the bytes present do not — precisely the independent
 * expectation we need. Verified: a 50%-truncated fixture still declares
 * `data = 44100` bytes with only 22011 available.
 *
 * Returns null if `fmt `/`data` cannot be read, or if the declared size fits
 * within the buffer (nothing is missing, so there is nothing to cross-check).
 */
export function estimateWavDurationSeconds(buf: Buffer): number | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === 'fmt ' && declared >= 16 && body + 16 <= buf.length) {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (sampleRate < 1 || channels < 1 || bitsPerSample < 1) return null;
      const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
      if (bytesPerSecond <= 0) return null;
      return declared / bytesPerSecond;
    }

    // Advance by the DECLARED size: a truncated final chunk would otherwise loop.
    const next = body + declared + (declared % 2);
    if (next <= offset) return null;
    offset = next;
  }

  return null;
}

/**
 * Independent expected duration for the source bytes, or null when unavailable.
 *
 * OGG is deliberately absent: its duration lives in the granule position of the
 * LAST page, which truncation removes — so there is no truncation-surviving
 * estimate to read, and reading the first page's would tell us nothing. In
 * practice this costs nothing, because libsndfile REFUSES a truncated OGG outright
 * ("Supported file format but file is malformed", measured at every truncation
 * level), so those already fail as DECODE_FAILED. MIN_PLAUSIBLE_CLIP_SECONDS is
 * the backstop for any OGG that does slip through.
 */
function estimateSourceDurationSeconds(input: Buffer, contentType: string): number | null {
  if (contentType === 'audio/mpeg') return estimateMp3DurationSeconds(input);
  if (contentType.startsWith('audio/wav') || contentType === 'audio/x-wav' || contentType === 'audio/wave') {
    return estimateWavDurationSeconds(input);
  }
  // A mislabelled upload takes the other decoder; sniff the magic bytes so it also
  // gets a cross-check rather than only the floor.
  if (input.length >= 12 && input.toString('ascii', 0, 4) === 'RIFF') return estimateWavDurationSeconds(input);
  return estimateMp3DurationSeconds(input);
}

interface DecoderRun {
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  /** The output file blew past MAX_DECODED_OUTPUT_BYTES and the child was killed. */
  outputTooLarge: boolean;
  /** Output size observed when the watchdog fired (for the error message). */
  outputBytes?: number;
}

/**
 * Spawn one decoder over the temp file. Resolves regardless of exit status —
 * success is decided by the caller from the output file, because a zero exit
 * does not imply the decoder wrote anything (see the routing comment above).
 *
 * On timeout: SIGTERM, then SIGKILL after a short grace, then resolve as
 * `timedOut`. The process is never left running.
 *
 * An output-size WATCHDOG polls the growing output file and kills the child the
 * moment it exceeds {@link MAX_DECODED_OUTPUT_BYTES}. This is what makes an
 * over-long file rejected DURING decode rather than after ~168 MB has been written
 * to scratch and read whole into a Buffer.
 */
function runDecoder(
  decoder: Decoder,
  inPath: string,
  outPath: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<DecoderRun> {
  const [bin, args] =
    decoder === 'mpg123'
      ? // -q quiet, -m force mono downmix, -w write WAV
        [MPG123_BIN, ['-q', '-m', '-w', outPath, inPath]]
      : // No -mono/-channels option exists; JS downmix handles multi-channel output.
        [SNDFILE_CONVERT_BIN, ['-pcm16', inPath, outPath]];

  return new Promise<DecoderRun>((resolve) => {
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let outputTooLarge = false;
    let outputBytes: number | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let watchTimer: NodeJS.Timeout | undefined;

    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (watchTimer) clearInterval(watchTimer);
      const run: DecoderRun = { exitCode, stderr: stderr.slice(0, 2000), timedOut, outputTooLarge };
      if (outputBytes !== undefined) run.outputBytes = outputBytes;
      resolve(run);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn({ decoder, timeoutMs }, 'Audio decode timed out — killing decoder');
      child.kill('SIGTERM');
      // Escalate if the child ignores SIGTERM (a wedged C parser may).
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        // If even SIGKILL leaves no 'close' (impossible in practice, but the
        // caller must not hang forever), settle anyway.
        //
        // unref'd: once the promise settles this timer is pure residue, and an
        // un-unref'd one holds the event loop open for up to a second past a
        // request that is already over (and past graceful shutdown).
        setTimeout(() => finish(null), 1000).unref?.();
      }, 2000);
    }, timeoutMs);
    // Do not keep the event loop alive on the timeout alone.
    timer.unref?.();

    // Output-size watchdog. Polling `stat` is deliberate over a write-stream
    // wrapper: the decoders write the file themselves (they take an output PATH,
    // not a pipe), so the size on disk is the only observable. 100 ms is far
    // finer-grained than the ~333 ms a 115 MB decode takes, so the overshoot past
    // the ceiling is bounded to a fraction of it.
    watchTimer = setInterval(() => {
      fs.stat(outPath)
        .then((st) => {
          if (settled || st.size <= maxOutputBytes) return;
          outputTooLarge = true;
          outputBytes = st.size;
          log.warn(
            { decoder, outputBytes: st.size, maxBytes: maxOutputBytes },
            'Audio decode output exceeded the maximum valid clip size — killing decoder',
          );
          // SIGKILL directly: this is a resource guard, not a graceful stop, and
          // the partial output is discarded either way.
          child.kill('SIGKILL');
        })
        // The file may not exist yet (or at all) — nothing to bound.
        .catch(() => undefined);
    }, OUTPUT_WATCH_INTERVAL_MS);
    watchTimer.unref?.();

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      // ENOENT = the decoder binary is not installed in this image.
      stderr += `\nspawn error: ${(err as Error).message}`;
      log.error({ err, decoder, bin }, 'Failed to spawn audio decoder');
      finish(null);
    });

    child.on('close', (code) => finish(code));
  });
}

/**
 * Minimal RIFF/WAVE walker for PCM16 output written by an EXTERNAL tool.
 *
 * Deliberately NOT `readTtsPcm`: that function hardcodes a 44-byte header and is
 * safe only because `writeTtsFile` is its sole writer. `sndfile-convert` emits a
 * `LIST`/`INFO` chunk before `data` (measured: `data` starts at offset 90 on OGG
 * input), which a 44-byte assumption would read as audio — noise on a live call.
 * So walk the chunks and honour `fmt `.
 *
 * Returns null when the bytes are not a parseable 16-bit PCM WAV.
 */
export function parseWavPcm16(
  wav: Buffer,
): { pcm: Buffer; sampleRate: number; channels: number } | null {
  if (wav.length < 12) return null;
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (wav.toString('ascii', 8, 12) !== 'WAVE') return null;

  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let data: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const declared = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    // Trust the buffer over the declared size — a killed decoder can leave a
    // header claiming more bytes than it managed to write.
    const size = Math.min(declared, wav.length - body);

    if (id === 'fmt ' && size >= 16) {
      audioFormat = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      sampleRate = wav.readUInt32LE(body + 4);
      bitsPerSample = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      data = wav.subarray(body, body + size);
    }

    // Chunks are word-aligned: an odd size carries a pad byte.
    offset = body + size + (size % 2);
  }

  if (!data || audioFormat !== 1 || bitsPerSample !== 16) return null;
  if (channels < 1 || sampleRate < 1) return null;

  // Trim to whole frames so a truncated tail can't shear a sample.
  const bytesPerFrame = 2 * channels;
  const frames = Math.floor(data.length / bytesPerFrame);
  let pcm = data.subarray(0, frames * bytesPerFrame);
  // Int16Array views require 2-byte alignment; a LIST chunk of odd length can
  // land `data` on an odd byteOffset.
  if (pcm.byteOffset % 2 !== 0) pcm = Buffer.from(pcm);

  return { pcm, sampleRate, channels };
}

/**
 * Reap orphaned decode scratch directories left by a hard crash.
 *
 * Each decode's `finally` removes its own dir, but a SIGKILL/OOM/redeploy mid-decode
 * skips that — and each orphan can hold the input plus a partially-written PCM
 * output (bounded by MAX_DECODED_OUTPUT_BYTES, but that is still tens of MB). On a
 * persistent volume they accumulate forever; nothing else reaps them
 * (`sweepTtsCache` covers the CLIP cache, a different directory).
 *
 * Age-gated because this is process-wide, not per-process: sibling replicas share
 * the volume, and deleting a dir another replica is actively decoding into would
 * corrupt a live decode. `minAgeMs` defaults to comfortably beyond the decode
 * timeout, so anything older than it cannot belong to a running decode anywhere.
 *
 * Synchronous-in-spirit and fully non-throwing: this runs at startup and must never
 * prevent the service from booting.
 */
export async function reapDecodeScratchDirs(opts?: { minAgeMs?: number }): Promise<number> {
  // 3× the decode budget: the timeout bounds one decode, and the extra margin
  // covers a slow filesystem and clock skew between replicas.
  const minAgeMs = opts?.minAgeMs ?? config.audio.decodeTimeoutMs * 3;
  const cutoff = Date.now() - minAgeMs;

  let entries: string[];
  try {
    entries = await fs.readdir(AUDIO_DECODE_TMP_DIR);
  } catch (err) {
    log.warn({ err, dir: AUDIO_DECODE_TMP_DIR }, 'Could not read audio decode scratch dir for reaping');
    return 0;
  }

  let reaped = 0;
  for (const entry of entries) {
    if (!entry.startsWith(DECODE_TMP_PREFIX)) continue;
    const full = path.join(AUDIO_DECODE_TMP_DIR, entry);
    try {
      const st = await fs.stat(full);
      if (!st.isDirectory()) continue;
      // mtime, not birthtime: birthtime is not portable across filesystems, and a
      // dir being written into keeps its mtime fresh — exactly the signal we want.
      if (st.mtimeMs > cutoff) continue;
      await fs.rm(full, { recursive: true, force: true });
      reaped++;
    } catch (err) {
      // A racing sibling may have removed it already — not an error.
      log.debug({ err, dir: full }, 'Skipped an audio decode scratch dir during reap');
    }
  }

  if (reaped > 0) {
    log.info({ reaped, dir: AUDIO_DECODE_TMP_DIR, minAgeMs }, 'Reaped orphaned audio decode scratch dirs');
  }
  return reaped;
}
