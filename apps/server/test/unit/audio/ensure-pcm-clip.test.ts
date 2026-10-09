import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────
//
// The real decode/cache modules are owned by the decode-layer work and exercised
// against real fixtures there. Here we mock at the module boundary and model the
// clip cache as an explicit in-memory "disk" so a test can delete a file — which
// is exactly what "a second replica that never handled the upload" looks like
// from this process's point of view.

const mocks = vi.hoisted(() => {
  /** hash → written clip. Stands in for the node-local TTS_AUDIO_DIR. */
  const disk = new Map<string, { sampleRate: number; channels: number; bytes: number }>();
  /**
   * Stands in for the real `AudioDecodeError` (owned by the decode layer). Defined
   * here so this file has no load-order dependency on that module's shape — only
   * on the error carrying a `code`, which is all ensurePcmClip's callers rely on.
   */
  class AudioDecodeError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'AudioDecodeError';
      this.code = code;
    }
  }
  return {
    disk,
    AudioDecodeError,
    getFile: vi.fn(),
    decodeToPcm16: vi.fn(),
    hashAudioFileContent: vi.fn((bytes: Buffer) => `audiohash-${bytes.toString('utf8')}`),
    ttsFileExists: vi.fn((hash: string) => disk.has(hash)),
    writeTtsFile: vi.fn((hash: string, pcm16: Buffer, sampleRate: number, channels: number) => {
      disk.set(hash, { sampleRate, channels, bytes: pcm16.length });
    }),
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
  };
});

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/storage/s3.js', () => ({
  getFile: mocks.getFile,
}));

vi.mock('../../../src/audio/decode.js', () => ({
  decodeToPcm16: mocks.decodeToPcm16,
  AudioDecodeError: mocks.AudioDecodeError,
}));

vi.mock('../../../src/tts/tts-file-cache.js', () => ({
  hashAudioFileContent: mocks.hashAudioFileContent,
  ttsFileExists: mocks.ttsFileExists,
  writeTtsFile: mocks.writeTtsFile,
}));

vi.mock('@magick-agency/db', () => ({
  getPool: () => ({ query: mocks.query }),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────

import { ensurePcmClip } from '../../../src/audio/ensure-pcm-clip.js';
import type { AudioFileRecord } from '@magick-agency/db/models/audio-file.model';

// ── Helpers ────────────────────────────────────────────────────────────

function makeAudioFile(overrides: Partial<AudioFileRecord> = {}): AudioFileRecord {
  return {
    id: 'af-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    name: 'Diwali greeting',
    slug: 'diwali-greeting',
    original_filename: 'diwali.mp3',
    content_type: 'audio/mpeg',
    size_bytes: 12345,
    s3_key: 'tenant-1/af-1/diwali-greeting.mp3',
    duration_seconds: 12,
    created_at: new Date(),
    updated_at: new Date(),
    pcm_audio_hash: null,
    pcm_sample_rate: null,
    pcm_channels: null,
    ...overrides,
  };
}

/** The bytes the mock hasher turns into `audiohash-<content>`. */
const S3_BYTES = Buffer.from('mp3bytes');

function decoded(sampleRate = 44100) {
  return {
    pcm16: Buffer.alloc(8000),
    sampleRate,
    durationSeconds: 0.09,
    decoder: 'mpg123' as const,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('ensurePcmClip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.disk.clear();
    mocks.getFile.mockResolvedValue(S3_BYTES);
    mocks.decodeToPcm16.mockResolvedValue(decoded());
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    // Re-arm the implementations vi.clearAllMocks() strips.
    mocks.hashAudioFileContent.mockImplementation((bytes: Buffer) => `audiohash-${bytes.toString('utf8')}`);
    mocks.ttsFileExists.mockImplementation((hash: string) => mocks.disk.has(hash));
    mocks.writeTtsFile.mockImplementation(
      (hash: string, pcm16: Buffer, sampleRate: number, channels: number) => {
        mocks.disk.set(hash, { sampleRate, channels, bytes: pcm16.length });
      },
    );
  });

  describe('fast path — hash set and clip present on this disk', () => {
    it('returns the stored hash without touching S3 or the decoder', async () => {
      mocks.disk.set('audiohash-mp3bytes', { sampleRate: 8000, channels: 1, bytes: 8000 });
      const af = makeAudioFile({ pcm_audio_hash: 'audiohash-mp3bytes', pcm_sample_rate: 8000, pcm_channels: 1 });

      const res = await ensurePcmClip(af);

      expect(res).toEqual({ hash: 'audiohash-mp3bytes', sampleRate: 8000 });
      expect(mocks.getFile).not.toHaveBeenCalled();
      expect(mocks.decodeToPcm16).not.toHaveBeenCalled();
      expect(mocks.writeTtsFile).not.toHaveBeenCalled();
      // Row already correct → no redundant write
      expect(mocks.query).not.toHaveBeenCalled();
    });

    /**
     * A clip cached at the SOURCE rate predates the pre-conversion change. It is
     * usable, so the old fast path happily served it — and every call then paid a
     * ~1.9s resample while the callee held a silent line. It must be treated as a
     * miss so the row heals to 8kHz once, off the call path.
     *
     * The rate is the ONLY signal available: the hash is content-addressed on the
     * raw uploaded bytes, so it is byte-identical for a 44.1kHz and an 8kHz cache
     * of the same file.
     */
    it('treats a legacy clip cached at the source rate as a miss and heals it to 8kHz', async () => {
      mocks.disk.set('audiohash-mp3bytes', { sampleRate: 44100, channels: 1, bytes: 8000 });
      const af = makeAudioFile({ pcm_audio_hash: 'audiohash-mp3bytes', pcm_sample_rate: 44100, pcm_channels: 1 });

      const res = await ensurePcmClip(af);

      // Re-decoded despite the clip being present on disk.
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);
      expect(res.sampleRate).toBe(8000);
      expect(mocks.disk.get(res.hash)!.sampleRate).toBe(8000);
      // Same bytes ⇒ same content hash; only the cached rate changed.
      expect(res.hash).toBe('audiohash-mp3bytes');
      // The row is corrected so the next resolve takes the fast path.
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(mocks.query.mock.calls[0]![1]).toEqual(['af-1', 'audiohash-mp3bytes', 8000, 1]);
    });
  });

  describe('cache miss with a stored hash (simulates another replica)', () => {
    it('re-downloads from S3, re-decodes, and re-populates the cache under the SAME hash', async () => {
      // The row says the file decoded fine and this is its key…
      const af = makeAudioFile({ pcm_audio_hash: 'audiohash-mp3bytes', pcm_sample_rate: 8000, pcm_channels: 1 });
      // …but the clip is not on THIS node's disk (upload landed on another replica,
      // or sweepTtsCache evicted it).
      expect(mocks.disk.has('audiohash-mp3bytes')).toBe(false);

      const res = await ensurePcmClip(af);

      expect(mocks.getFile).toHaveBeenCalledWith('tenant-1/af-1/diwali-greeting.mp3');
      expect(mocks.decodeToPcm16).toHaveBeenCalledWith(S3_BYTES, 'audio/mpeg');
      // Same content ⇒ same hash. Content-addressing is what makes the re-decode
      // idempotent and safe to race across replicas.
      expect(res.hash).toBe('audiohash-mp3bytes');
      // Re-populated at the 8kHz wire rate — the re-decode path applies the SAME
      // normalization as upload, so a clip resolved on a replica that did not
      // handle the upload does not re-introduce the mid-call resample.
      expect(mocks.disk.get('audiohash-mp3bytes')!.sampleRate).toBe(8000);
      expect(mocks.disk.get('audiohash-mp3bytes')!.channels).toBe(1);
      // Nothing changed on the row, so no UPDATE is issued.
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('deleting the cache file after a first resolve forces a second decode', async () => {
      const af = makeAudioFile();

      const first = await ensurePcmClip(af);
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);

      // Simulate the sweeper (or a different replica's empty disk).
      mocks.disk.delete(first.hash);

      const healed = makeAudioFile({ pcm_audio_hash: first.hash, pcm_sample_rate: first.sampleRate, pcm_channels: 1 });
      const second = await ensurePcmClip(healed);

      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
      expect(mocks.disk.has(first.hash)).toBe(true);
    });

    it('writes the clip through writeTtsFile (the sole writer of the 44-byte layout readTtsPcm assumes)', async () => {
      await ensurePcmClip(makeAudioFile());

      expect(mocks.writeTtsFile).toHaveBeenCalledTimes(1);
      const [hash, pcm16, sampleRate, channels] = mocks.writeTtsFile.mock.calls[0]!;
      expect(hash).toBe('audiohash-mp3bytes');
      expect(Buffer.isBuffer(pcm16)).toBe(true);
      expect(sampleRate).toBe(8000);
      // Always mono — decodeToPcm16 contracts mono output.
      expect(channels).toBe(1);
    });

    /**
     * Inverts a previous assertion ("does not resample — cached at its native
     * rate"). That behaviour was deliberate but turned out to be the wrong
     * trade-off: it deferred the resample to `handleStart`, which runs while the
     * callee is on a live, silent line. Measured on a 58s clip, 44.1kHz→8k is
     * ~1.9s and the G.711 encode from 8kHz is ~3ms — so the resample IS the gap.
     * Paying it once at upload is the whole point of the change.
     */
    it('resamples to the 8kHz telephony wire rate regardless of source rate', async () => {
      for (const sourceRate of [22050, 44100, 48000]) {
        vi.clearAllMocks();
        mocks.disk.clear();
        mocks.getFile.mockResolvedValue(S3_BYTES);
        mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
        mocks.hashAudioFileContent.mockImplementation((bytes: Buffer) => `audiohash-${bytes.toString('utf8')}`);
        mocks.ttsFileExists.mockImplementation((hash: string) => mocks.disk.has(hash));
        mocks.writeTtsFile.mockImplementation(
          (hash: string, pcm16: Buffer, sampleRate: number, channels: number) => {
            mocks.disk.set(hash, { sampleRate, channels, bytes: pcm16.length });
          },
        );
        mocks.decodeToPcm16.mockResolvedValue(decoded(sourceRate));

        const res = await ensurePcmClip(makeAudioFile());

        expect(res.sampleRate, `source ${sourceRate}`).toBe(8000);
        expect(mocks.disk.get(res.hash)!.sampleRate, `source ${sourceRate}`).toBe(8000);
      }
    });

    it('leaves an already-8kHz source untouched (idempotent, no needless resample)', async () => {
      mocks.decodeToPcm16.mockResolvedValue(decoded(8000));

      const res = await ensurePcmClip(makeAudioFile());

      expect(res.sampleRate).toBe(8000);
      // Byte count unchanged — the source was already at the wire rate, so no
      // resample ran (a resample would have altered the sample count).
      expect(mocks.disk.get(res.hash)!.bytes).toBe(8000);
    });
  });

  describe('legacy row healing (pcm_audio_hash IS NULL)', () => {
    it('decodes from S3 and PERSISTS hash + rate + channels onto the row', async () => {
      const af = makeAudioFile({ pcm_audio_hash: null, pcm_sample_rate: null, pcm_channels: null });

      const res = await ensurePcmClip(af);

      expect(res).toEqual({ hash: 'audiohash-mp3bytes', sampleRate: 8000 });
      expect(mocks.query).toHaveBeenCalledTimes(1);
      const [sql, params] = mocks.query.mock.calls[0]!;
      expect(sql).toContain('UPDATE audio_files');
      expect(sql).toContain('pcm_audio_hash');
      expect(sql).toContain('pcm_sample_rate');
      expect(sql).toContain('pcm_channels');
      expect(params).toEqual(['af-1', 'audiohash-mp3bytes', 8000, 1]);
    });

    it('a failed persist does not fail the resolve (the clip is usable for THIS dispatch)', async () => {
      mocks.query.mockRejectedValue(new Error('db down'));

      const res = await ensurePcmClip(makeAudioFile());

      expect(res.hash).toBe('audiohash-mp3bytes');
      expect(mocks.disk.has('audiohash-mp3bytes')).toBe(true);
    });

    it('heals a row whose stored hash no longer matches the S3 content (file replaced)', async () => {
      const af = makeAudioFile({ pcm_audio_hash: 'audiohash-stale', pcm_sample_rate: 8000, pcm_channels: 1 });

      const res = await ensurePcmClip(af);

      expect(res.hash).toBe('audiohash-mp3bytes');
      expect(mocks.query).toHaveBeenCalledTimes(1);
      expect(mocks.query.mock.calls[0]![1]).toEqual(['af-1', 'audiohash-mp3bytes', 8000, 1]);
    });
  });

  describe('failure propagation (fail-closed)', () => {
    it('propagates AudioDecodeError for an undecodable legacy audio/mp4 row', async () => {
      mocks.decodeToPcm16.mockRejectedValue(
        new mocks.AudioDecodeError('mpg123: Format not recognised', 'UNSUPPORTED_FORMAT'),
      );
      const af = makeAudioFile({ content_type: 'audio/mp4', original_filename: 'legacy.m4a' });

      await expect(ensurePcmClip(af)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
      // Nothing cached, nothing persisted — no silent clip is manufactured.
      expect(mocks.disk.size).toBe(0);
      expect(mocks.query).not.toHaveBeenCalled();
    });

    it('propagates an S3 fetch failure', async () => {
      mocks.getFile.mockRejectedValue(new Error('NoSuchKey'));

      await expect(ensurePcmClip(makeAudioFile())).rejects.toThrow('NoSuchKey');
      expect(mocks.decodeToPcm16).not.toHaveBeenCalled();
    });

    it('a failure is not memoized — the next call retries cleanly', async () => {
      mocks.decodeToPcm16.mockRejectedValueOnce(new Error('transient decoder crash'));
      const af = makeAudioFile();

      await expect(ensurePcmClip(af)).rejects.toThrow('transient decoder crash');

      const res = await ensurePcmClip(af);
      expect(res.hash).toBe('audiohash-mp3bytes');
    });
  });

  describe('race safety', () => {
    it('concurrent resolves of the same file collapse to ONE S3 fetch + ONE decode', async () => {
      let releaseDecode: (v: unknown) => void = () => {};
      const gate = new Promise((r) => { releaseDecode = r; });
      mocks.decodeToPcm16.mockImplementation(async () => {
        await gate;
        return decoded();
      });

      const af = makeAudioFile();
      const all = Promise.all([ensurePcmClip(af), ensurePcmClip(af), ensurePcmClip(af)]);
      releaseDecode(null);
      const results = await all;

      expect(mocks.getFile).toHaveBeenCalledTimes(1);
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);
      expect(results.every((r) => r.hash === 'audiohash-mp3bytes')).toBe(true);
    });

    it('two different files resolve independently', async () => {
      mocks.getFile.mockImplementation(async (key: string) =>
        key.includes('af-2') ? Buffer.from('oggbytes') : S3_BYTES,
      );

      const [a, b] = await Promise.all([
        ensurePcmClip(makeAudioFile()),
        ensurePcmClip(makeAudioFile({ id: 'af-2', s3_key: 'tenant-1/af-2/x.ogg', content_type: 'audio/ogg' })),
      ]);

      expect(a.hash).toBe('audiohash-mp3bytes');
      expect(b.hash).toBe('audiohash-oggbytes');
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(2);
    });

    it('a concurrent resolver that already wrote the clip is reused rather than re-decoded', async () => {
      // Second caller arrives after the first wrote the file but with a row that
      // already carries the matching hash — it must read the disk, not re-decode.
      const af = makeAudioFile();
      const first = await ensurePcmClip(af);
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);

      const withHash = makeAudioFile({ pcm_audio_hash: first.hash, pcm_sample_rate: first.sampleRate, pcm_channels: 1 });
      const second = await ensurePcmClip(withHash);

      expect(second).toEqual(first);
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);
      expect(mocks.getFile).toHaveBeenCalledTimes(1);
    });

    it('a shared SingleFlight failure is seen by every waiter (never memoized)', async () => {
      let release: (err: Error) => void = () => {};
      const gate = new Promise<never>((_resolve, reject) => {
        release = reject;
      });
      mocks.decodeToPcm16.mockImplementation(() => gate);

      const af = makeAudioFile();
      const waiters = Promise.allSettled([
        ensurePcmClip(af),
        ensurePcmClip(af),
        ensurePcmClip(af),
      ]);
      release(new Error('s3 exploded mid-flight'));
      const results = await waiters;

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);

      // Failures are never sticky — a subsequent call retries cleanly.
      mocks.decodeToPcm16.mockResolvedValue(decoded());
      await expect(ensurePcmClip(af)).resolves.toMatchObject({ hash: 'audiohash-mp3bytes' });
    });
  });
});
