// Tenant/account labels are wrapped in `uuidFor` (UUID columns).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { audioFileRepository } = await import('../../../src/repositories/audio-file.repository.js');

/**
 * Real-DB round-trip for the migration-067 PCM columns through the repository
 * (create / find / scoped / list / delete). Unit tests cover SQL shape; this
 * pins that Postgres actually stores and returns the values with the right
 * coercions.
 */
describe('audioFileRepository — PCM columns (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('create → findById round-trips PCM columns and coerces duration_seconds', async () => {
    const hash = 'b'.repeat(40);
    const created = await audioFileRepository.create({
      tenant_id: uuidFor('tenant-1'),
      account_id: uuidFor('account-1'),
      name: 'Promo',
      slug: `promo-${randomUUID().slice(0, 8)}`,
      original_filename: 'promo.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 4641,
      s3_key: `tenant-1/${randomUUID()}/promo.mp3`,
      duration_seconds: 0.5,
      pcm_audio_hash: hash,
      pcm_sample_rate: 44100,
      pcm_channels: 1,
    });

    expect(created.pcm_audio_hash).toBe(hash);
    expect(created.pcm_sample_rate).toBe(44100);
    expect(created.pcm_channels).toBe(1);
    expect(created.duration_seconds).toBe(0.5);
    expect(typeof created.duration_seconds).toBe('number');

    const found = await audioFileRepository.findById(created.id);
    expect(found).toMatchObject({
      pcm_audio_hash: hash,
      pcm_sample_rate: 44100,
      pcm_channels: 1,
      duration_seconds: 0.5,
    });
  });

  it('omitted PCM columns persist as NULL (legacy-shaped insert)', async () => {
    const created = await audioFileRepository.create({
      tenant_id: uuidFor('tenant-1'),
      account_id: uuidFor('account-1'),
      name: 'Legacy',
      slug: `legacy-${randomUUID().slice(0, 8)}`,
      original_filename: 'legacy.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 100,
      s3_key: `tenant-1/${randomUUID()}/legacy.mp3`,
    });

    expect(created.pcm_audio_hash).toBeNull();
    expect(created.pcm_sample_rate).toBeNull();
    expect(created.pcm_channels).toBeNull();
    expect(created.duration_seconds).toBeNull();
  });

  it('findByIdScoped returns null for a wrong tenant/account (ownership boundary)', async () => {
    const created = await audioFileRepository.create({
      tenant_id: uuidFor('tenant-a'),
      account_id: uuidFor('account-a'),
      name: 'Owned',
      slug: `owned-${randomUUID().slice(0, 8)}`,
      original_filename: 'x.wav',
      content_type: 'audio/wav',
      size_bytes: 1,
      s3_key: 'k',
      pcm_audio_hash: 'c'.repeat(40),
      pcm_sample_rate: 16000,
      pcm_channels: 1,
    });

    expect(await audioFileRepository.findByIdScoped(created.id, uuidFor('tenant-a'), uuidFor('account-a'))).not.toBeNull();
    expect(await audioFileRepository.findByIdScoped(created.id, uuidFor('tenant-b'), uuidFor('account-a'))).toBeNull();
    expect(await audioFileRepository.findByIdScoped(created.id, uuidFor('tenant-a'), uuidFor('account-b'))).toBeNull();
    // Unscoped find still returns the row — scoping is the caller's responsibility.
    expect(await audioFileRepository.findById(created.id)).not.toBeNull();
  });

  it('listByTenant coerces duration and preserves NULL PCM columns', async () => {
    await audioFileRepository.create({
      tenant_id: uuidFor('tenant-list'),
      account_id: uuidFor('account-list'),
      name: 'With PCM',
      slug: `with-${randomUUID().slice(0, 8)}`,
      original_filename: 'a.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 1,
      s3_key: 'k1',
      duration_seconds: 12.34,
      pcm_audio_hash: 'd'.repeat(40),
      pcm_sample_rate: 22050,
      pcm_channels: 1,
    });
    await audioFileRepository.create({
      tenant_id: uuidFor('tenant-list'),
      account_id: uuidFor('account-list'),
      name: 'Without PCM',
      slug: `without-${randomUUID().slice(0, 8)}`,
      original_filename: 'b.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 1,
      s3_key: 'k2',
    });

    const { rows, total } = await audioFileRepository.listByTenant(uuidFor('tenant-list'), uuidFor('account-list'), 10, 0);
    expect(total).toBe(2);
    const withPcm = rows.find((r) => r.name === 'With PCM')!;
    const without = rows.find((r) => r.name === 'Without PCM')!;
    expect(withPcm.duration_seconds).toBe(12.34);
    expect(typeof withPcm.duration_seconds).toBe('number');
    expect(withPcm.pcm_audio_hash).toBe('d'.repeat(40));
    expect(without.pcm_audio_hash).toBeNull();
    expect(without.duration_seconds).toBeNull();
  });

  it('a healing UPDATE on a legacy row persists PCM metadata idempotently', async () => {
    // Mirrors ensurePcmClip's persistPcmMetadata — the single post-upload writer
    // of these columns. Pinning the SQL against real Postgres catches a typo in
    // column names that the unit mock would never see.
    const created = await audioFileRepository.create({
      tenant_id: uuidFor('tenant-heal'),
      account_id: uuidFor('account-heal'),
      name: 'Heal me',
      slug: `heal-${randomUUID().slice(0, 8)}`,
      original_filename: 'heal.mp3',
      content_type: 'audio/mpeg',
      size_bytes: 1,
      s3_key: 'k-heal',
    });
    expect(created.pcm_audio_hash).toBeNull();

    const hash = 'e'.repeat(40);
    await getTestPool().query(
      `UPDATE audio_files
          SET pcm_audio_hash = $2, pcm_sample_rate = $3, pcm_channels = $4
        WHERE id = $1`,
      [created.id, hash, 44100, 1],
    );

    const healed = await audioFileRepository.findById(created.id);
    expect(healed).toMatchObject({
      pcm_audio_hash: hash,
      pcm_sample_rate: 44100,
      pcm_channels: 1,
    });

    // Same-value rewrite (two replicas healing) must not error.
    await getTestPool().query(
      `UPDATE audio_files
          SET pcm_audio_hash = $2, pcm_sample_rate = $3, pcm_channels = $4
        WHERE id = $1`,
      [created.id, hash, 44100, 1],
    );
    const again = await audioFileRepository.findById(created.id);
    expect(again!.pcm_audio_hash).toBe(hash);
  });
});
