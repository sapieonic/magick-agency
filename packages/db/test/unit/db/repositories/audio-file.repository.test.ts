// PORT NOTE (magick-agency): ported from magic-voice-core/test/unit/db/repositories/audio-file.repository.test.ts@4850d1d9.
// Changed: connection/repository import paths (packages/db layout). Deleted the whole
// `migration 067 — shape and safety` describe (6 cases) and its fs/path imports + MIGRATION
// constant: they read core's src/db/migrations/067_audio_file_pcm.sql, which is not carried —
// agency has a squashed baseline (packages/db/migrations/0001_baseline.sql) that creates the
// three PCM columns nullable with no DEFAULT inline. Ids stay non-UUID: the pool is mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { AudioFileRepository } from '../../../../src/repositories/audio-file.repository.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'af-1',
    tenant_id: 't1',
    account_id: 'a1',
    name: 'Promo',
    slug: 'promo',
    original_filename: 'promo.mp3',
    content_type: 'audio/mpeg',
    size_bytes: '4641',
    s3_key: 't1/af-1/promo.mp3',
    duration_seconds: null,
    pcm_audio_hash: null,
    pcm_sample_rate: null,
    pcm_channels: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

let repo: AudioFileRepository;

beforeEach(() => {
  vi.clearAllMocks();
  repo = new AudioFileRepository();
});

describe('AudioFileRepository.create — PCM columns round-trip (§5.5)', () => {
  it('inserts all three PCM columns plus duration', async () => {
    mocks.query.mockResolvedValue({ rows: [row({ pcm_audio_hash: 'h'.repeat(40), pcm_sample_rate: 44100, pcm_channels: 1, duration_seconds: '0.50' })] });

    await repo.create({
      tenant_id: 't1',
      account_id: 'a1',
      name: 'Promo',
      slug: 'promo',
      original_filename: 'promo.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 4641,
      s3_key: 't1/af-1/promo.mp3',
      duration_seconds: 0.5,
      pcm_audio_hash: 'h'.repeat(40),
      pcm_sample_rate: 44100,
      pcm_channels: 1,
    });

    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('pcm_audio_hash');
    expect(sql).toContain('pcm_sample_rate');
    expect(sql).toContain('pcm_channels');
    expect(sql).toContain('duration_seconds');
    // Placeholder count must match the column list or Postgres errors at runtime.
    expect(sql).toContain('$12');
    expect(sql).not.toContain('$13');
    expect(params).toHaveLength(12);
    expect(params.slice(8)).toEqual([0.5, 'h'.repeat(40), 44100, 1]);
  });

  it('writes NULL for every PCM column when they are omitted (legacy-shaped insert)', async () => {
    mocks.query.mockResolvedValue({ rows: [row()] });

    await repo.create({
      tenant_id: 't1',
      account_id: 'a1',
      name: 'Legacy',
      slug: 'legacy',
      original_filename: 'legacy.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 100,
      s3_key: 'k',
    });

    const params = (mocks.query.mock.calls[0] as [string, unknown[]])[1];
    // All nullable — a caller that does not decode must still be able to insert.
    expect(params.slice(8)).toEqual([null, null, null, null]);
  });

  it('returns the PCM columns on the created record', async () => {
    mocks.query.mockResolvedValue({
      rows: [row({ pcm_audio_hash: 'abc', pcm_sample_rate: 16000, pcm_channels: 1, duration_seconds: '12.34' })],
    });
    const out = await repo.create({
      tenant_id: 't1', account_id: 'a1', name: 'n', slug: 's',
      original_filename: 'f.wav', content_type: 'audio/wav', size_bytes: 1, s3_key: 'k',
    });
    expect(out.pcm_audio_hash).toBe('abc');
    expect(out.pcm_sample_rate).toBe(16000);
    expect(out.pcm_channels).toBe(1);
  });
});

describe('AudioFileRepository — duration_seconds is coerced from NUMERIC (pg returns a string)', () => {
  it('coerces on create', async () => {
    mocks.query.mockResolvedValue({ rows: [row({ duration_seconds: '12.34' })] });
    const out = await repo.create({
      tenant_id: 't1', account_id: 'a1', name: 'n', slug: 's',
      original_filename: 'f.mp3', content_type: 'audio/mpeg', size_bytes: 1, s3_key: 'k',
    });
    // Was a type lie while the column was never populated; now that upload writes
    // it, any arithmetic or JSON consumer would see "12.34" instead of 12.34.
    expect(out.duration_seconds).toBe(12.34);
    expect(typeof out.duration_seconds).toBe('number');
  });

  it('coerces on findById', async () => {
    mocks.query.mockResolvedValue({ rows: [row({ duration_seconds: '0.50' })] });
    const out = await repo.findById('af-1');
    expect(out!.duration_seconds).toBe(0.5);
  });

  it('coerces on findByIdScoped', async () => {
    mocks.query.mockResolvedValue({ rows: [row({ duration_seconds: '99.99' })] });
    const out = await repo.findByIdScoped('af-1', 't1', 'a1');
    expect(out!.duration_seconds).toBe(99.99);
  });

  it('coerces on listByTenant', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({ rows: [row({ duration_seconds: '1.50' }), row({ duration_seconds: null })] });
    const out = await repo.listByTenant('t1', 'a1');
    expect(out.total).toBe(2);
    expect(out.rows[0]!.duration_seconds).toBe(1.5);
    // A legacy NULL must stay NULL, not become 0 — "unknown" is not "zero-length".
    expect(out.rows[1]!.duration_seconds).toBeNull();
  });

  it('leaves a NULL duration as null rather than coercing to 0', async () => {
    mocks.query.mockResolvedValue({ rows: [row({ duration_seconds: null })] });
    const out = await repo.findById('af-1');
    expect(out!.duration_seconds).toBeNull();
  });

  it('returns null (not undefined) when the row does not exist', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect(await repo.findById('nope')).toBeNull();
    expect(await repo.findByIdScoped('nope', 't1', 'a1')).toBeNull();
  });

  it('keeps scoped lookups tenant+account filtered', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await repo.findByIdScoped('af-1', 't1', 'a1');
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('tenant_id = $2');
    expect(sql).toContain('account_id = $3');
    expect(params).toEqual(['af-1', 't1', 'a1']);
  });
});

describe('AudioFileRepository.delete', () => {
  it('returns true when a row was deleted', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    expect(await repo.delete('af-1')).toBe(true);
    const [sql, params] = mocks.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/DELETE FROM audio_files WHERE id = \$1/);
    expect(params).toEqual(['af-1']);
  });

  it('returns false when the id does not exist', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await repo.delete('nope')).toBe(false);
  });
});
