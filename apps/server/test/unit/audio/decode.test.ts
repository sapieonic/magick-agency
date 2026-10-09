// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/audio/decode.test.ts@4850d1d9.
// Changes: STATIC_CALL_MAX_DURATION_SECONDS import path (now @magick-agency/db/models/static-call.model);
// type-only fix for the server tsconfig (typechecks tests, no DOM lib): the setTimeout spy's `fn: TimerHandler`
// is typed `unknown` and its cast goes through `unknown`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, type ChildProcess } from 'node:child_process';

// `decode.ts` imports the real config module, whose loader calls `process.exit(1)`
// when required env vars are absent — which is exactly the case in CI. Mock it to
// the one field decode actually reads, matching the convention the other
// config-importing tests use (see tts-generator.test.ts).
// `decodeConcurrency` is deliberately ABSENT from the base mock: it exercises the
// gate's documented fallback to 2 through a real caller, which is the shape every
// other config-mocking suite in the repo has. The gate-specific describe below
// sets it explicitly and resets the singleton.
const cfg = vi.hoisted(() => ({
  audio: { decodeTimeoutMs: 90_000 } as { decodeTimeoutMs: number; decodeConcurrency?: number },
}));

// Pass-through `spawn` mock so a single test can substitute a never-exiting child
// without racing a real decoder against a 1ms timer (load-sensitive). Default
// implementation is the real `spawn`; overrides must restore via `reset()`.
const spawnHarness = vi.hoisted(() => {
  const state = {
    spawn: vi.fn(),
    actualSpawn: null as null | typeof import('node:child_process').spawn,
    reset() {
      if (state.actualSpawn) state.spawn.mockImplementation(state.actualSpawn);
    },
  };
  return state;
});

vi.mock('../../../src/config/index.js', () => ({ config: cfg }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  spawnHarness.actualSpawn = actual.spawn;
  spawnHarness.spawn.mockImplementation(actual.spawn);
  return {
    ...actual,
    spawn: ((...args: Parameters<typeof actual.spawn>) =>
      spawnHarness.spawn(...args)) as typeof actual.spawn,
  };
});

// A private scratch dir, set BEFORE importing the module (which reads the env
// once at import). The temp-cleanup assertions count directories, and vitest runs
// files in parallel forks that would otherwise all share os.tmpdir() and see each
// other's in-flight decodes.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'decode-test-scratch-'));
process.env['AUDIO_DECODE_TMP_DIR'] = SCRATCH;

const {
  decodeToPcm16,
  AudioDecodeError,
  parseWavPcm16,
  DECODE_TMP_PREFIX,
  AUDIO_SHORTFALL_RATIO,
  MIN_PLAUSIBLE_CLIP_SECONDS,
  MAX_DECODED_OUTPUT_BYTES,
  estimateMp3DurationSeconds,
  estimateWavDurationSeconds,
  reapDecodeScratchDirs,
} = await import('../../../src/audio/decode.js');

const { STATIC_CALL_MAX_DURATION_SECONDS } = await import('@magick-agency/db/models/static-call.model');

const { runExclusive, getDecodeGateStats, __resetDecodeGate } = await import(
  '../../../src/utils/decode-gate.js'
);

/** A manually-resolvable promise, for deterministic control of the gate. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Leftover decode scratch dirs in this file's private SCRATCH. */
function countScratchDirs(): number {
  return fs.readdirSync(SCRATCH).filter((n) => n.startsWith(DECODE_TMP_PREFIX)).length;
}

// Real fixtures, real child processes. The decode layer's whole risk surface is
// "what do these two C tools actually do with these bytes", which a mock cannot
// express — see test/fixtures/audio/README.md.
const FIXTURES = path.join(process.cwd(), 'test/fixtures/audio');

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function haveBinary(bin: string): boolean {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  // mpg123 --version exits 0; sndfile-convert has no --version and exits 1 with
  // usage. Either way, spawning succeeded ⇒ the binary exists. ENOENT ⇒ it does not.
  return !(r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT');
}

const HAVE_DECODERS = haveBinary('mpg123') && haveBinary('sndfile-convert');

// Never let the real coverage vanish silently. Locally the tools may be absent
// (they ship in the Docker image, not on a dev laptop) and skipping is fine; in
// CI a skip would mean this feature is untested, so fail instead.
describe('decoder toolchain availability', () => {
  it('has mpg123 and sndfile-convert available (required in CI)', () => {
    if (!HAVE_DECODERS && !process.env['CI']) {
      console.warn(
        '\n[decode.test] SKIPPING real-decode tests: mpg123 / sndfile-convert not installed.\n' +
          '  brew install mpg123 libsndfile   (or apt-get install mpg123 sndfile-programs)\n',
      );
      return;
    }
    expect(HAVE_DECODERS).toBe(true);
  });
});

/**
 * Goertzel magnitude at one frequency, normalized by sample count. Used to assert
 * a downmix kept BOTH channels rather than dropping one: the stereo fixtures carry
 * 440 Hz left and 880 Hz right, so a dropped channel shows up as one tone missing.
 */
function toneEnergy(pcm16: Buffer, sampleRate: number, freq: number): number {
  const n = pcm16.length / 2;
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm16.readInt16LE(i * 2) / 32768 + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.abs(s1 * s1 + s2 * s2 - coeff * s1 * s2)) / n;
}

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — real fixtures (§9.1)', () => {
  it('decodes mono MP3 to mono PCM16 at its native 44100 Hz via mpg123', async () => {
    const out = await decodeToPcm16(fixture('mono-440-44100.mp3'), 'audio/mpeg');

    expect(out.decoder).toBe('mpg123');
    expect(out.sampleRate).toBe(44100);
    // Mono ⇒ exactly 2 bytes per frame; frames must match the duration.
    expect(out.pcm16.length % 2).toBe(0);
    expect(out.durationSeconds).toBeCloseTo(out.pcm16.length / 2 / 44100, 6);
    expect(out.durationSeconds).toBeGreaterThan(0.4);
    expect(out.durationSeconds).toBeLessThan(0.7);
  });

  it('decodes mono WAV to mono PCM16 preserving a non-44.1k rate (16000) via sndfile', async () => {
    const out = await decodeToPcm16(fixture('mono-440-16000.wav'), 'audio/wav');

    // The contract predicted mpg123 would cover WAV too. It does not — it is an
    // MPEG decoder and writes no output for a WAV. Routing sends WAV to sndfile.
    expect(out.decoder).toBe('sndfile');
    // NOT resampled — pcmToAlaw handles 8 kHz downstream.
    expect(out.sampleRate).toBe(16000);
    expect(out.pcm16.length / 2).toBe(8000);
    expect(out.durationSeconds).toBeCloseTo(0.5, 3);
  });

  it('decodes mono OGG/Vorbis to mono PCM16 at 16000 Hz via sndfile', async () => {
    const out = await decodeToPcm16(fixture('mono-440-16000.ogg'), 'audio/ogg');

    expect(out.decoder).toBe('sndfile');
    expect(out.sampleRate).toBe(16000);
    expect(out.durationSeconds).toBeCloseTo(0.5, 2);
    expect(out.pcm16.length).toBeGreaterThan(0);
  });

  it('never resamples — three fixtures at three rates keep all three', async () => {
    const rates = await Promise.all([
      decodeToPcm16(fixture('mono-440-44100.mp3'), 'audio/mpeg').then((d) => d.sampleRate),
      decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav').then((d) => d.sampleRate),
      decodeToPcm16(fixture('mono-440-16000.ogg'), 'audio/ogg').then((d) => d.sampleRate),
    ]);
    expect(rates).toEqual([44100, 22050, 16000]);
  });
});

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — stereo comes out mono (§9.2)', () => {
  // The trap the contract flags: sndfile-convert has NO -mono option, so stereo
  // WAV/OGG returns interleaved 2-channel and the JS downmix is the only thing
  // preventing a clip that plays at half speed / double duration.

  it('mpg123 path: stereo MP3 → mono, both tones preserved', async () => {
    const out = await decodeToPcm16(fixture('stereo-440-880-44100.mp3'), 'audio/mpeg');

    expect(out.decoder).toBe('mpg123'); // downmixes itself via -m
    expect(out.sampleRate).toBe(44100);
    // Mono at 44100 for ~0.5 s ≈ 22050 frames. A 2-channel clip mistaken for mono
    // would report ~44100 frames and ~1.0 s.
    const frames = out.pcm16.length / 2;
    expect(frames).toBeGreaterThan(20_000);
    expect(frames).toBeLessThan(25_000);
    expect(out.durationSeconds).toBeGreaterThan(0.4);
    expect(out.durationSeconds).toBeLessThan(0.7);

    // Both channels averaged, not one dropped.
    expect(toneEnergy(out.pcm16, out.sampleRate, 440)).toBeGreaterThan(0.01);
    expect(toneEnergy(out.pcm16, out.sampleRate, 880)).toBeGreaterThan(0.01);
  });

  it('sndfile path: stereo WAV → mono via the JS downmix, both tones preserved', async () => {
    const out = await decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav');

    expect(out.decoder).toBe('sndfile');
    expect(out.sampleRate).toBe(22050);
    // 0.5 s at 22050 = 11025 frames. sndfile hands back 11025 frames × 2 channels
    // = 22050 samples; if the downmix were skipped this would read as 22050 frames
    // and 1.0 s of audio, i.e. the clip plays an octave low for twice as long.
    expect(out.pcm16.length / 2).toBe(11_025);
    expect(out.durationSeconds).toBeCloseTo(0.5, 3);

    expect(toneEnergy(out.pcm16, out.sampleRate, 440)).toBeGreaterThan(0.01);
    expect(toneEnergy(out.pcm16, out.sampleRate, 880)).toBeGreaterThan(0.01);
  });

  it('sndfile path: stereo OGG → mono, both tones preserved', async () => {
    const out = await decodeToPcm16(fixture('stereo-440-880-44100.ogg'), 'audio/ogg');

    expect(out.decoder).toBe('sndfile');
    expect(out.sampleRate).toBe(44100);
    const frames = out.pcm16.length / 2;
    expect(frames).toBeGreaterThan(20_000);
    expect(frames).toBeLessThan(25_000);
    expect(out.durationSeconds).toBeLessThan(0.7);

    expect(toneEnergy(out.pcm16, out.sampleRate, 440)).toBeGreaterThan(0.005);
    expect(toneEnergy(out.pcm16, out.sampleRate, 880)).toBeGreaterThan(0.005);
  });
});

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — bad input is a typed 4xx, never a 500 (§9.6)', () => {
  it('rejects M4A/AAC bytes (no ffmpeg) with DECODE_FAILED, not a crash', async () => {
    // Sent with an accepted MIME so it gets past the validator — this is the
    // "mislabelled MIME" case as well as the AAC one.
    await expect(decodeToPcm16(fixture('mono-440-44100.m4a'), 'audio/mpeg')).rejects.toMatchObject({
      name: 'AudioDecodeError',
      code: 'DECODE_FAILED',
    });
  });

  it('rejects an M4A labelled as audio/ogg (sndfile: "Format not recognised")', async () => {
    await expect(decodeToPcm16(fixture('mono-440-44100.m4a'), 'audio/ogg')).rejects.toMatchObject({
      code: 'DECODE_FAILED',
    });
  });

  it('rejects plain-text garbage claiming to be MP3', async () => {
    const garbage = Buffer.from('this is definitely not audio, just ascii padding over and over');
    await expect(decodeToPcm16(garbage, 'audio/mpeg')).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('rejects a truncated WAV header', async () => {
    const truncated = fixture('mono-440-16000.wav').subarray(0, 20);
    await expect(decodeToPcm16(truncated, 'audio/wav')).rejects.toMatchObject({ code: 'DECODE_FAILED' });
  });

  it('rejects a zero-sample WAV as EMPTY_AUDIO, not as a valid silent clip', async () => {
    // A header-only WAV: sndfile-convert happily produces a 0-frame output file
    // and exits 0. Without the zero-sample check this would be cached as a clip
    // that streams nothing — a silent call, the exact failure mode §5.8 exists for.
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(0, 40);

    await expect(decodeToPcm16(header, 'audio/wav')).rejects.toMatchObject({
      code: expect.stringMatching(/EMPTY_AUDIO|DECODE_FAILED/),
    });
  });

  it('never leaks decoder stderr into the thrown message (it goes on .detail)', async () => {
    const err = await decodeToPcm16(Buffer.from('nope nope nope nope nope'), 'audio/ogg').catch((e) => e);
    expect(err).toBeInstanceOf(AudioDecodeError);
    // The message is what the route may show a customer; stderr names host paths.
    expect(err.message).not.toMatch(/sndfile-convert|mpg123|\/(tmp|var|Users)\//);
    expect(err.message).toMatch(/corrupt|truncated|not really/i);
  });
});

describe('decodeToPcm16 — input guards (no decoder needed)', () => {
  it('rejects an unaccepted MIME with UNSUPPORTED_FORMAT naming the supported list', async () => {
    const err = await decodeToPcm16(Buffer.from('x'), 'audio/mp4').catch((e) => e);
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(err.code).toBe('UNSUPPORTED_FORMAT');
    expect(err.message).toContain('audio/mpeg');
    expect(err.message).toContain('audio/wav');
    expect(err.message).toContain('audio/ogg');
    expect(err.message).not.toContain('audio/mp4,');
  });

  it('rejects a zero-byte upload with EMPTY_AUDIO before spawning anything', async () => {
    await expect(decodeToPcm16(Buffer.alloc(0), 'audio/mpeg')).rejects.toMatchObject({ code: 'EMPTY_AUDIO' });
  });
});

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — timeout kills the child and leaves no temp files (§9.5)', () => {
  // Counts leftovers in this file's private scratch dir. Asserting an exact 0 is
  // only meaningful because nothing else writes here.
  function tempDirCount(): number {
    return fs.readdirSync(SCRATCH).filter((n) => n.startsWith(DECODE_TMP_PREFIX)).length;
  }

  /**
   * A child that never exits on its own — only on `kill()`. Removes the race
   * where a real tiny fixture can finish before a short `setTimeout` fires when
   * the event loop is descheduled under full-suite load.
   */
  function hangingChild(): ChildProcess {
    const child = new EventEmitter() as EventEmitter & {
      kill: (signal?: NodeJS.Signals | number) => boolean;
      stderr: EventEmitter;
      stdin: null;
      stdout: null;
    };
    child.stderr = new EventEmitter();
    child.stdin = null;
    child.stdout = null;
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null));
      return true;
    };
    return child as unknown as ChildProcess;
  }

  afterEach(() => {
    spawnHarness.reset();
  });

  it('throws DECODE_TIMEOUT on an unreachable budget and cleans up its temp dir', async () => {
    // Hang the child so the budget timer is guaranteed to win — a real 1ms race
    // against sndfile-convert is load-sensitive (child runs off-thread; a delayed
    // timer lets the decode finish first and the assertion sees DecodedAudio).
    spawnHarness.spawn.mockImplementation(() => hangingChild());

    const err = await decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav', {
      timeoutMs: 20,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(err.code).toBe('DECODE_TIMEOUT');
    expect(err.message).toContain('20ms');

    // The `finally` runs on the timeout path too — no leaked temp dir.
    expect(tempDirCount()).toBe(0);
    expect(spawnHarness.spawn).toHaveBeenCalled();
  });

  it('cleans up its temp dir on the failure path as well', async () => {
    await decodeToPcm16(Buffer.from('garbage bytes here'), 'audio/mpeg').catch(() => undefined);
    expect(tempDirCount()).toBe(0);
  });

  it('cleans up its temp dir on the success path', async () => {
    await decodeToPcm16(fixture('mono-440-16000.wav'), 'audio/wav');
    expect(tempDirCount()).toBe(0);
  });

  it('leaves nothing behind across a mixed run of successes and failures', async () => {
    await Promise.all([
      decodeToPcm16(fixture('mono-440-44100.mp3'), 'audio/mpeg'),
      decodeToPcm16(Buffer.from('junk'), 'audio/ogg').catch(() => undefined),
      decodeToPcm16(fixture('mono-440-16000.ogg'), 'audio/ogg'),
      decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav', { timeoutMs: 1 }).catch(() => undefined),
    ]);
    expect(tempDirCount()).toBe(0);
  });

  it('concurrent decodes of distinct fixtures never collide on scratch dirs', async () => {
    // Scratch dirs are mkdtemp'd; a bulk upload that decodes N files in parallel
    // must not EEXIST or cross-contaminate. Five simultaneous real decodes is
    // enough to catch a shared-temp-path regression.
    const results = await Promise.all([
      decodeToPcm16(fixture('mono-440-44100.mp3'), 'audio/mpeg'),
      decodeToPcm16(fixture('mono-440-16000.wav'), 'audio/wav'),
      decodeToPcm16(fixture('mono-440-16000.ogg'), 'audio/ogg'),
      decodeToPcm16(fixture('stereo-440-880-44100.mp3'), 'audio/mpeg'),
      decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav'),
    ]);
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.pcm16.length > 0)).toBe(true);
    expect(tempDirCount()).toBe(0);
  });

  it('leaves no lingering decoder process after a timeout', async () => {
    await decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav', { timeoutMs: 1 }).catch(
      () => undefined,
    );
    // Give SIGTERM/SIGKILL time to land, then assert nothing of ours survives.
    await new Promise((r) => setTimeout(r, 300));
    const ps = spawnSync('ps', ['-eo', 'command'], { encoding: 'utf8' });
    const ours = (ps.stdout ?? '')
      .split('\n')
      .filter((l) => /sndfile-convert .*audio-decode-|mpg123 .*audio-decode-/.test(l));
    expect(ours).toEqual([]);
  });
});

describe('parseWavPcm16 — external-tool WAV, so chunks must be walked', () => {
  function wav(opts: {
    channels?: number;
    sampleRate?: number;
    bits?: number;
    format?: number;
    data: Buffer;
    extraChunk?: { id: string; body: Buffer };
  }): Buffer {
    const channels = opts.channels ?? 1;
    const sampleRate = opts.sampleRate ?? 16000;
    const bits = opts.bits ?? 16;
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(opts.format ?? 1, 0);
    fmt.writeUInt16LE(channels, 2);
    fmt.writeUInt32LE(sampleRate, 4);
    fmt.writeUInt32LE(sampleRate * channels * (bits / 8), 8);
    fmt.writeUInt16LE(channels * (bits / 8), 12);
    fmt.writeUInt16LE(bits, 14);

    const chunks: Buffer[] = [];
    const push = (id: string, body: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(id, 0);
      h.writeUInt32LE(body.length, 4);
      chunks.push(h, body);
      if (body.length % 2) chunks.push(Buffer.alloc(1));
    };
    push('fmt ', fmt);
    if (opts.extraChunk) push(opts.extraChunk.id, opts.extraChunk.body);
    push('data', opts.data);

    const body = Buffer.concat(chunks);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0);
    head.writeUInt32LE(4 + body.length, 4);
    head.write('WAVE', 8);
    return Buffer.concat([head, body]);
  }

  it('reads a canonical 44-byte-header WAV', () => {
    const data = Buffer.from([1, 0, 2, 0, 3, 0]);
    const out = parseWavPcm16(wav({ data }));
    expect(out).toEqual({ pcm: data, sampleRate: 16000, channels: 1 });
  });

  it('skips a LIST/INFO chunk before data — the sndfile-convert layout', () => {
    // This is the load-bearing difference from readTtsPcm's hardcoded offset 44:
    // sndfile-convert emits LIST/INFO, so a 44-byte assumption would return the
    // chunk header ("LIST....INFO...") as audio samples — noise on a live call.
    const data = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const out = parseWavPcm16(
      wav({ data, extraChunk: { id: 'LIST', body: Buffer.from('INFOISFTLavf62 (libsndfile)') } }),
    );
    expect(out?.pcm).toEqual(data);
    expect(out?.sampleRate).toBe(16000);
  });

  it('reports the real channel count so the caller knows to downmix', () => {
    const out = parseWavPcm16(wav({ channels: 2, sampleRate: 44100, data: Buffer.alloc(8) }));
    expect(out?.channels).toBe(2);
    expect(out?.sampleRate).toBe(44100);
  });

  it('trims a partial trailing frame rather than shearing a sample', () => {
    // 2 channels ⇒ 4 bytes/frame; 10 bytes is 2 whole frames + 2 stray bytes.
    const out = parseWavPcm16(wav({ channels: 2, data: Buffer.alloc(10) }));
    expect(out?.pcm.length).toBe(8);
  });

  it('trusts the buffer over a declared size larger than the file (killed decoder)', () => {
    const full = wav({ data: Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]) });
    // Header still claims 8 data bytes; only 4 survive.
    const chopped = full.subarray(0, full.length - 4);
    const out = parseWavPcm16(chopped);
    expect(out?.pcm.length).toBe(4);
  });

  it('returns null for non-RIFF bytes', () => {
    expect(parseWavPcm16(Buffer.from('not a wav file at all'))).toBeNull();
  });

  it('returns null for a RIFF container that is not WAVE', () => {
    const b = Buffer.alloc(16);
    b.write('RIFF', 0);
    b.writeUInt32LE(8, 4);
    b.write('AVI ', 8);
    expect(parseWavPcm16(b)).toBeNull();
  });

  it('returns null for non-PCM (compressed) audio', () => {
    expect(parseWavPcm16(wav({ format: 0x11, data: Buffer.alloc(8) }))).toBeNull();
  });

  it('returns null for a bit depth other than 16', () => {
    expect(parseWavPcm16(wav({ bits: 24, data: Buffer.alloc(9) }))).toBeNull();
  });

  it('returns null when there is no data chunk', () => {
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0);
    fmt.writeUInt16LE(1, 2);
    fmt.writeUInt32LE(16000, 4);
    fmt.writeUInt16LE(16, 14);
    const h = Buffer.alloc(8);
    h.write('fmt ', 0);
    h.writeUInt32LE(16, 4);
    const body = Buffer.concat([h, fmt]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0);
    head.writeUInt32LE(4 + body.length, 4);
    head.write('WAVE', 8);
    expect(parseWavPcm16(Buffer.concat([head, body]))).toBeNull();
  });

  it('returns null for a truncated RIFF header', () => {
    expect(parseWavPcm16(Buffer.from('RIF'))).toBeNull();
  });
});

// ── §9.6 (the partial-decode half): truncated but decodable input ────────────
//
// The pre-existing §9.6 cases above all use input so damaged that decode fails
// COMPLETELY. That leaves the genuinely dangerous class untested: a file that
// decodes fine, just to a fraction of its real content. A 90%-truncated MP3 yields
// ~1 ms of audio, which would otherwise be cached, dialed, played as silence, and
// billed as a connected call.
//
// Truncation is done at RUNTIME from the committed fixtures — a truncated fixture
// is a derived artifact, not source, and committing one would make the ratio
// impossible to re-derive when the fixture is regenerated.

function truncateTo(buf: Buffer, fraction: number): Buffer {
  return buf.subarray(0, Math.floor(buf.length * fraction));
}

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — truncated-but-decodable input (§9.6)', () => {
  it('rejects a 50%-truncated MP3 that would otherwise decode to a short clip', async () => {
    const err = await decodeToPcm16(truncateTo(fixture('stereo-440-880-44100.mp3'), 0.5), 'audio/mpeg').catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(err.code).toBe('AUDIO_TRUNCATED');
    // Actionable, and specifically about re-uploading — the user's actual remedy.
    expect(err.message).toMatch(/incomplete/i);
    expect(err.message).toMatch(/re-upload/i);
    // The coverage numbers must reach the logs for Loki triage.
    expect(err.detail).toMatch(/coverage/);
  });

  it('rejects a 90%-truncated MP3 (decodes to ~1ms — the silent-call case)', async () => {
    const err = await decodeToPcm16(truncateTo(fixture('stereo-440-880-44100.mp3'), 0.1), 'audio/mpeg').catch(
      (e) => e,
    );

    expect(err.code).toBe('AUDIO_TRUNCATED');
    // Whichever guard fires first, the decoded duration is nowhere near usable.
    expect(err.durationSeconds).toBeLessThan(MIN_PLAUSIBLE_CLIP_SECONDS);
  });

  it('rejects a 50%-truncated mono MP3 too (not a stereo-only artifact)', async () => {
    const err = await decodeToPcm16(truncateTo(fixture('mono-440-44100.mp3'), 0.5), 'audio/mpeg').catch((e) => e);
    expect(err.code).toBe('AUDIO_TRUNCATED');
  });

  it('rejects a 50%-truncated WAV, whose header still declares the full data size', async () => {
    const err = await decodeToPcm16(truncateTo(fixture('stereo-440-880-22050.wav'), 0.5), 'audio/wav').catch(
      (e) => e,
    );
    expect(err.code).toBe('AUDIO_TRUNCATED');
  });

  it('still rejects a truncated OGG (libsndfile refuses it outright)', async () => {
    // OGG has no truncation-surviving duration header, so it never reaches the
    // cross-check — libsndfile declines the malformed stream first. Pinned so a
    // future libsndfile that DOES partially decode is caught by a failing test
    // rather than by a silent call.
    const err = await decodeToPcm16(truncateTo(fixture('stereo-440-880-44100.ogg'), 0.5), 'audio/ogg').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(['DECODE_FAILED', 'AUDIO_TRUNCATED']).toContain(err.code);
  });

  // ── The regression risk of the guards: false positives on real audio ────────
  //
  // Every committed fixture is INTACT and short (0.5 s), so these are exactly the
  // inputs a too-aggressive ratio or floor would wrongly reject.
  const intact: [string, string][] = [
    ['mono-440-44100.mp3', 'audio/mpeg'],
    ['stereo-440-880-44100.mp3', 'audio/mpeg'],
    ['mono-440-16000.wav', 'audio/wav'],
    ['stereo-440-880-22050.wav', 'audio/wav'],
    ['mono-440-16000.ogg', 'audio/ogg'],
    ['stereo-440-880-44100.ogg', 'audio/ogg'],
  ];

  for (const [name, mime] of intact) {
    it(`still accepts the intact short clip ${name} (no false positive)`, async () => {
      const out = await decodeToPcm16(fixture(name), mime);
      expect(out.durationSeconds).toBeGreaterThan(0);
      expect(out.pcm16.length).toBeGreaterThan(0);
    });
  }

  it('leaves real headroom between an intact clip and the shortfall threshold', async () => {
    // An intact MP3 decodes to ~0.91 of its Xing-declared duration: the encoder's
    // declared frame count includes decoder-delay/padding frames the decoder
    // correctly drops. If that legitimate overhead ever drifted below the ratio,
    // every MP3 upload would start failing — so pin the margin, not just the pass.
    const buf = fixture('stereo-440-880-44100.mp3');
    const expected = estimateMp3DurationSeconds(buf);
    expect(expected).not.toBeNull();
    const out = await decodeToPcm16(buf, 'audio/mpeg');
    expect(out.durationSeconds / expected!).toBeGreaterThan(AUDIO_SHORTFALL_RATIO);
  });
});

describe('duration estimators — independent of the decoder, so truncation cannot hide', () => {
  it('reads an MP3 Xing/Info frame count that SURVIVES truncation', () => {
    // The whole guard rests on this: the header lives in the FIRST frame, so a
    // truncated file still declares its original length. If this ever stopped
    // being true the cross-check would silently compare a file against itself.
    const full = fixture('stereo-440-880-44100.mp3');
    const expected = estimateMp3DurationSeconds(full);

    expect(expected).toBeGreaterThan(0.5);
    expect(estimateMp3DurationSeconds(truncateTo(full, 0.5))).toBeCloseTo(expected!, 6);
    expect(estimateMp3DurationSeconds(truncateTo(full, 0.1))).toBeCloseTo(expected!, 6);
  });

  it('reads a WAV declared data-chunk duration that survives truncation', () => {
    const full = fixture('stereo-440-880-22050.wav');
    const expected = estimateWavDurationSeconds(full);

    expect(expected).toBeGreaterThan(0.4);
    expect(estimateWavDurationSeconds(truncateTo(full, 0.5))).toBeCloseTo(expected!, 6);
  });

  it('returns null rather than guessing on bytes with no frame header', () => {
    expect(estimateMp3DurationSeconds(Buffer.from('no mpeg sync word anywhere in here'))).toBeNull();
    expect(estimateWavDurationSeconds(Buffer.from('not a riff file'))).toBeNull();
  });

  it('does not scan unboundedly over a large garbage buffer', () => {
    // A 10 MB upload of noise must not cost a byte-by-byte resync over all of it.
    const start = Date.now();
    estimateMp3DurationSeconds(Buffer.alloc(10 * 1024 * 1024, 0x7f));
    expect(Date.now() - start).toBeLessThan(500);
  });
});

// ── Output-size ceiling: bound the DECODE, not just the input ────────────────

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — decoded output is bounded during decode', () => {
  /**
   * A long CBR MP3, built by repeating a real fixture's audio frames. ~500 s of
   * 44.1 kHz audio ⇒ a ~45 MB WAV, comfortably past the ceiling — the same shape as
   * the reported 7.2 MB / 2 h / 8 kbps file that amplifies ~16×, without committing
   * a multi-megabyte fixture.
   */
  function longMp3(): Buffer {
    const src = fixture('mono-440-44100.mp3');
    // Skip the ID3 tag + Xing header frame so the repeats are plain audio frames.
    return Buffer.concat(Array.from({ length: 900 }, () => src.subarray(45)));
  }

  it('rejects on output SIZE without ever reading the clip into memory', async () => {
    const err = await decodeToPcm16(longMp3(), 'audio/mpeg').catch((e) => e);

    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(err.code).toBe('TOO_LONG');
    // The distinguishing evidence: rejected on bytes-on-disk, so no duration was
    // ever computed (the post-decode TOO_LONG path always carries one) — i.e. the
    // ~45 MB output was never `readFile`d into a Buffer.
    expect(err.durationSeconds).toBeUndefined();
    expect(err.detail).toMatch(/exceeded/);
  });

  it('kills the decoder mid-write when the decode runs long enough to sample', async () => {
    // Two layers guard this, and they cover different cases. The stat-before-read
    // gate is deterministic but only bounds the HEAP — the file is already fully
    // written. The in-flight watchdog is what bounds SCRATCH DISK, but it polls, so
    // a fast decode can finish between ticks. Forcing a tiny ceiling makes the
    // watchdog fire deterministically and proves the child is actually killed.
    const outputBytes: number[] = [];
    const err = await decodeToPcm16(longMp3(), 'audio/mpeg', {
      maxOutputBytes: 512 * 1024,
      onOutputTooLarge: (bytes) => outputBytes.push(bytes),
    }).catch((e) => e);

    expect(err.code).toBe('TOO_LONG');
    expect(outputBytes.length).toBeGreaterThan(0);
    // Killed while writing: far past the 512 KB trigger, but nowhere near the
    // ~45 MB the full decode would have produced.
    expect(outputBytes[0]!).toBeLessThan(45 * 1024 * 1024);
  });

  it('rejects fast — it does not wait for the full decode to finish', async () => {
    // The unbounded decode of this input takes noticeably longer than the bounded
    // one; a ceiling checked only after materialization would show no difference.
    const start = Date.now();
    await decodeToPcm16(longMp3(), 'audio/mpeg').catch(() => undefined);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it('leaves no scratch directory behind when the ceiling fires', async () => {
    const before = countScratchDirs();
    await decodeToPcm16(longMp3(), 'audio/mpeg').catch(() => undefined);
    expect(countScratchDirs()).toBe(before);
  });

  it('sets the ceiling above the largest clip the product actually allows', () => {
    // 120 s of 48 kHz stereo PCM16 is the worst case a VALID upload can decode to
    // (sndfile-convert does not downmix; the JS downmix runs after). The ceiling
    // must clear it, or legitimate long clips would be killed mid-decode.
    const worstValid = STATIC_CALL_MAX_DURATION_SECONDS * 48_000 * 2 * 2;
    expect(MAX_DECODED_OUTPUT_BYTES).toBeGreaterThan(worstValid);
  });
});

// ── Startup reaper for orphaned scratch dirs ─────────────────────────────────

describe('reapDecodeScratchDirs — crash-orphaned scratch dirs', () => {
  function makeScratchDir(name: string, ageMs: number): string {
    const dir = path.join(SCRATCH, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'out.wav'), Buffer.alloc(1024));
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, when, when);
    return dir;
  }

  it('removes a stale orphan and leaves a fresh one alone', async () => {
    // The fresh dir stands in for a SIBLING REPLICA's in-flight decode on a shared
    // volume: reaping it would corrupt a live upload, which is why the reap is
    // age-gated rather than "delete everything at boot".
    const stale = makeScratchDir(`${DECODE_TMP_PREFIX}stale-one`, 60 * 60 * 1000);
    const fresh = makeScratchDir(`${DECODE_TMP_PREFIX}fresh-one`, 0);

    const reaped = await reapDecodeScratchDirs({ minAgeMs: 60_000 });

    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);

    fs.rmSync(fresh, { recursive: true, force: true });
  });

  it('ignores directories that are not decode scratch dirs', async () => {
    const unrelated = path.join(SCRATCH, 'something-else-entirely');
    fs.mkdirSync(unrelated, { recursive: true });
    const when = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(unrelated, when, when);

    await reapDecodeScratchDirs({ minAgeMs: 1 });

    expect(fs.existsSync(unrelated)).toBe(true);
    fs.rmSync(unrelated, { recursive: true, force: true });
  });

  it('never throws when the scratch dir cannot be read', async () => {
    // Runs at startup — a missing/unreadable dir must not stop the service booting.
    await expect(reapDecodeScratchDirs({ minAgeMs: 1 })).resolves.toBeTypeOf('number');
  });
});

// ── Decode concurrency gate ──────────────────────────────────────────────────
//
// Each in-flight decode is a child process plus up to ~23MB of scratch, and this
// process shares its CPU and event loop with live AI calls. Nothing upstream
// bounds the fleet — the upload route decodes synchronously in the request path
// behind only a *request* rate limit, and ensurePcmClip's SingleFlight dedupes one
// audio file, never N distinct ones — so the ceiling has to live in decodeToPcm16
// itself, where every caller passes through.

describe.skipIf(!HAVE_DECODERS)('decodeToPcm16 — concurrency gate', () => {
  beforeEach(() => {
    delete cfg.audio.decodeConcurrency;
    __resetDecodeGate();
  });
  afterEach(() => {
    delete cfg.audio.decodeConcurrency;
    __resetDecodeGate();
  });

  it('does NOT consume a permit for an unsupported content type', async () => {
    // Cheap synchronous validation must reject before acquisition: a flood of bad
    // uploads would otherwise occupy queue slots that real decodes are waiting
    // for, and each bad request would pay the queue latency for an answer already
    // known.
    cfg.audio.decodeConcurrency = 1;
    __resetDecodeGate();

    // Occupy the single permit for a duration unambiguously longer than the
    // rejection should take. A real decode is single-digit ms, which is too close
    // to the rejection to distinguish "validated first" from "queued and then
    // validated" — so hold the permit directly.
    const release = deferred<void>();
    const holder = runExclusive(() => release.promise);
    await new Promise((r) => setTimeout(r, 10));
    expect(getDecodeGateStats()).toMatchObject({ active: 1, queued: 0 });

    // ...and reject a bad type WHILE it is held.
    const t0 = Date.now();
    const err = await decodeToPcm16(Buffer.from('x'), 'audio/mp4').catch((e) => e);
    const elapsed = Date.now() - t0;

    expect(err).toBeInstanceOf(AudioDecodeError);
    expect(err.code).toBe('UNSUPPORTED_FORMAT');
    // The assertions that actually bite. Without these the test passes even if
    // validation is moved UNDER the gate — the error code would be identical, just
    // arrive 300ms later. `queued: 0` proves it never joined the queue; `elapsed`
    // proves it did not wait for the permit that is still held below.
    expect(getDecodeGateStats()).toMatchObject({ active: 1, queued: 0 });
    expect(elapsed).toBeLessThan(100);

    release.resolve();
    await holder;
    expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('does NOT consume a permit for an empty upload', async () => {
    cfg.audio.decodeConcurrency = 1;
    __resetDecodeGate();

    const err = await decodeToPcm16(Buffer.alloc(0), 'audio/mpeg').catch((e) => e);
    expect(err.code).toBe('EMPTY_AUDIO');
    // Nothing was acquired, so nothing needs releasing — the gate is untouched.
    expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('releases the permit when a decode FAILS, so the gate is never wedged', async () => {
    cfg.audio.decodeConcurrency = 1;
    __resetDecodeGate();

    await decodeToPcm16(Buffer.from('garbage bytes here'), 'audio/mpeg').catch(() => undefined);
    expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0 });

    // A subsequent decode still gets a permit.
    await decodeToPcm16(Buffer.from('more garbage'), 'audio/mpeg').catch(() => undefined);
    expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0 });
  });

  it('returns the gate to idle after a burst of successes and failures', async () => {
    cfg.audio.decodeConcurrency = 2;
    __resetDecodeGate();

    await Promise.all([
      decodeToPcm16(fixture('mono-440-44100.mp3'), 'audio/mpeg'),
      decodeToPcm16(Buffer.from('junk'), 'audio/ogg').catch(() => undefined),
      decodeToPcm16(fixture('mono-440-16000.wav'), 'audio/wav'),
      decodeToPcm16(Buffer.alloc(0), 'audio/mpeg').catch(() => undefined),
      decodeToPcm16(fixture('mono-440-16000.ogg'), 'audio/ogg'),
    ]);

    expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0, limit: 2 });
  });

  it('caps concurrent child processes at the configured limit', async () => {
    // The scratch dir is the observable: each in-flight decode holds exactly one
    // `audio-decode-*` dir, created after acquisition and removed in its `finally`.
    // Sampling it during a burst therefore counts decodes actually running.
    cfg.audio.decodeConcurrency = 2;
    __resetDecodeGate();

    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, countScratchDirs());
    }, 2);

    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          decodeToPcm16(
            fixture(i % 2 === 0 ? 'stereo-440-880-44100.mp3' : 'stereo-440-880-22050.wav'),
            i % 2 === 0 ? 'audio/mpeg' : 'audio/wav',
          ),
        ),
      );
    } finally {
      clearInterval(sampler);
    }

    // Never more than the limit at once — and the sampler must have actually seen
    // work, or the assertion would pass vacuously.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(countScratchDirs()).toBe(0);
  });

  it('applies the timeout to the DECODE, not to the queue wait', async () => {
    // The subtle one. If the timeout clock started before acquisition, a job
    // queued behind a slow decode could burn its whole budget having done zero
    // work and fail with DECODE_TIMEOUT — a self-inflicted failure under exactly
    // the load the gate exists to absorb.
    //
    // Assert the ordering directly: the decode-budget `setTimeout` must NOT arm
    // while the call is merely queued, and must arm only after the permit is
    // held. A wall-clock HOLD_MS ≫ BUDGET_MS race is load-sensitive (full-suite
    // CPU contention can make a real decode exceed a tight budget even when the
    // clock starts correctly), so we observe arm timing against gate stats
    // instead of elapsed milliseconds.
    cfg.audio.decodeConcurrency = 1;
    __resetDecodeGate();

    // Distinctive delay so we can identify the decode-budget timer among the
    // SIGTERM-escalation / settle fallbacks that `runDecoder` also schedules.
    const BUDGET_MS = 87_654;

    const release = deferred<void>();
    const holder = runExclusive(() => release.promise);
    // Free-path acquire increments synchronously before the first await yields.
    expect(getDecodeGateStats().active).toBe(1);

    const timeoutArms: Array<{ delay: number; active: number; queued: number }> = [];
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((fn: unknown, delay?: number, ...args: unknown[]) => {
        if (delay === BUDGET_MS) {
          timeoutArms.push({ delay, ...getDecodeGateStats() });
        }
        return realSetTimeout(fn as (...a: unknown[]) => void, delay, ...args);
      }) as unknown as typeof setTimeout);

    try {
      const queuedDecode = decodeToPcm16(fixture('stereo-440-880-22050.wav'), 'audio/wav', {
        timeoutMs: BUDGET_MS,
      });

      // Drain microtasks so the queued acquire has joined the waiters list.
      await Promise.resolve();
      await Promise.resolve();

      // Still held by `holder` — the decode is waiting, and its budget clock must
      // not have started yet. If the clock armed at call time, `timeoutArms`
      // would already contain an entry here.
      expect(getDecodeGateStats()).toMatchObject({ active: 1, queued: 1 });
      expect(timeoutArms).toEqual([]);

      release.resolve();
      const decoded = await queuedDecode;
      await holder;

      // Budget timer armed only once the decode held a permit (baton-pass keeps
      // `active` at the limit while handing off; it must never arm with active=0).
      expect(timeoutArms.length).toBeGreaterThan(0);
      for (const arm of timeoutArms) {
        expect(arm.active).toBeGreaterThan(0);
      }
      expect(decoded.pcm16.length).toBeGreaterThan(0);
      expect(getDecodeGateStats()).toMatchObject({ active: 0, queued: 0 });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
