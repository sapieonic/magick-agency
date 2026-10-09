// PORT NOTE (magick-agency): ported from magic-voice-core/test/integration/flows/ensure-pcm-clip-heal.test.ts@4850d1d9.
// Only changes: mock specifiers / import paths — db/connection -> @magick-agency/db/connection (the one
// module both ensure-pcm-clip's `@magick-agency/db` getPool and the repository's `../connection.js`
// resolve to); logger + tracing mocks merged into one @magick-agency/observability mock (same members);
// repository import -> @magick-agency/db/repositories/audio-file.repository; test-utils from
// packages/db's integration setup. Tenant/account labels wrapped in `uuidFor` (UUID columns). Every case kept.
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';

/**
 * ensurePcmClip against a REAL Postgres row + an in-memory "disk" + stubbed S3/
 * decoder. Pins the load-bearing contract: a legacy NULL pcm_audio_hash heals
 * on first use, a cache miss re-decodes under the same content hash, and a
 * failed persist does not fail a dispatch that can otherwise render audio.
 */

const mocks = vi.hoisted(() => {
  const disk = new Map<string, { sampleRate: number; channels: number; bytes: number }>();
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
  };
});

vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  withSpan: async (_n: string, _a: unknown, fn: () => Promise<unknown>) => fn(),
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

const { ensurePcmClip } = await import('../../../src/audio/ensure-pcm-clip.js');
const { audioFileRepository } = await import('@magick-agency/db/repositories/audio-file.repository');
// Imported rather than hardcoded as 8000: if the wire rate ever changes, these
// assertions must move with the source of truth, not silently pin a stale number.
const { TELEPHONY_CLIP_SAMPLE_RATE } = await import('../../../src/audio/telephony-clip.js');

const S3_BYTES = Buffer.from('mp3bytes');

async function insertLegacyAudioFile() {
  return audioFileRepository.create({
    tenant_id: uuidFor('tenant-heal'),
    account_id: uuidFor('account-heal'),
    name: `heal-${randomUUID().slice(0, 8)}`,
    slug: `heal-${randomUUID().slice(0, 8)}`,
    original_filename: 'greeting.mp3',
    content_type: 'audio/mpeg',
    size_bytes: S3_BYTES.length,
    s3_key: `tenant-heal/${randomUUID()}/greeting.mp3`,
    // Explicitly omit PCM columns — the legacy shape.
  });
}

describe('ensurePcmClip heal against real Postgres (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    mocks.disk.clear();
    vi.clearAllMocks();
    mocks.getFile.mockResolvedValue(S3_BYTES);
    mocks.decodeToPcm16.mockResolvedValue({
      pcm16: Buffer.alloc(8000),
      sampleRate: 44100,
      durationSeconds: 0.09,
      decoder: 'mpg123',
    });
    mocks.hashAudioFileContent.mockImplementation((bytes: Buffer) => `audiohash-${bytes.toString('utf8')}`);
    mocks.ttsFileExists.mockImplementation((hash: string) => mocks.disk.has(hash));
    mocks.writeTtsFile.mockImplementation(
      (hash: string, pcm16: Buffer, sampleRate: number, channels: number) => {
        mocks.disk.set(hash, { sampleRate, channels, bytes: pcm16.length });
      },
    );
  });

  afterEach(() => {
    mocks.disk.clear();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('heals a legacy NULL row: decode → write cache → UPDATE pcm_* columns', async () => {
    const af = await insertLegacyAudioFile();
    expect(af.pcm_audio_hash).toBeNull();

    const res = await ensurePcmClip(af);

    // 8000, not the decoder's native 44100: ensurePcmClip normalizes through
    // toTelephonyClip before caching, so the clip cache and the persisted
    // pcm_sample_rate both hold the telephony wire rate. The decoder mock above
    // still reports 44100 because that IS what a real decoder emits — the
    // conversion is what this asserts.
    expect(res).toEqual({ hash: 'audiohash-mp3bytes', sampleRate: TELEPHONY_CLIP_SAMPLE_RATE });
    expect(mocks.disk.has(res.hash)).toBe(true);
    expect(mocks.disk.get(res.hash)?.sampleRate).toBe(TELEPHONY_CLIP_SAMPLE_RATE);

    const reloaded = await audioFileRepository.findById(af.id);
    expect(reloaded).toMatchObject({
      pcm_audio_hash: 'audiohash-mp3bytes',
      pcm_sample_rate: TELEPHONY_CLIP_SAMPLE_RATE,
      pcm_channels: 1,
    });
  });

  it('fast path after heal: second call does not touch S3 or the decoder', async () => {
    const af = await insertLegacyAudioFile();
    const first = await ensurePcmClip(af);
    expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);

    const healed = await audioFileRepository.findById(af.id);
    const second = await ensurePcmClip(healed!);

    expect(second).toEqual(first);
    expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(1);
    expect(mocks.getFile).toHaveBeenCalledTimes(1);
  });

  it('cache miss with a stored hash (other replica / sweeper) re-decodes under the SAME hash', async () => {
    const af = await insertLegacyAudioFile();
    const first = await ensurePcmClip(af);
    // Simulate another replica / sweepTtsCache eviction.
    mocks.disk.delete(first.hash);

    const healed = await audioFileRepository.findById(af.id);
    const second = await ensurePcmClip(healed!);

    expect(second.hash).toBe(first.hash);
    expect(mocks.decodeToPcm16).toHaveBeenCalledTimes(2);
    expect(mocks.disk.has(first.hash)).toBe(true);
    // Row already correct → no redundant UPDATE churn beyond the first heal.
    const reloaded = await audioFileRepository.findById(af.id);
    expect(reloaded!.pcm_audio_hash).toBe(first.hash);
  });

  it('undecodable legacy audio/mp4 fails closed and leaves the row unhealed', async () => {
    const af = await audioFileRepository.create({
      tenant_id: uuidFor('tenant-heal'),
      account_id: uuidFor('account-heal'),
      name: `m4a-${randomUUID().slice(0, 8)}`,
      slug: `m4a-${randomUUID().slice(0, 8)}`,
      original_filename: 'legacy.m4a',
      content_type: 'audio/mp4',
      size_bytes: 100,
      s3_key: `tenant-heal/${randomUUID()}/legacy.m4a`,
    });
    mocks.decodeToPcm16.mockRejectedValue(
      new mocks.AudioDecodeError('Format not recognised', 'UNSUPPORTED_FORMAT'),
    );

    await expect(ensurePcmClip(af)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(mocks.disk.size).toBe(0);

    const reloaded = await audioFileRepository.findById(af.id);
    expect(reloaded!.pcm_audio_hash).toBeNull();
  });
});