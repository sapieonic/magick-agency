// PORT NOTE (magick-agency): ported from magic-voice-core/test/integration/repositories/audio-file.repository.test.ts@4850d1d9.
// Only changes: connection/repository paths (packages/db layout); tenant/account labels wrapped in
// `uuidFor` (UUID columns); `insertAudioFile` comes from ../setup/clip-factories.js. Every case kept.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAudioFile } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Must import AFTER vi.mock
const { audioFileRepository } = await import('../../../src/repositories/audio-file.repository.js');

describe('audioFileRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create', () => {
    it('inserts an audio file record and returns it', async () => {
      const id = randomUUID();
      const result = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        name: 'Test Audio File',
        slug: `audio-${id}`,
        original_filename: 'test-audio.wav',
        content_type: 'audio/wav',
        size_bytes: 204800,
        s3_key: `tenant-1/${id}/test-audio.wav`,
        duration_seconds: 15.5,
      });

      expect(result.id).toBeDefined();
      expect(result.tenant_id).toBe(uuidFor('tenant-1'));
      expect(result.account_id).toBe(uuidFor('account-1'));
      expect(result.name).toBe('Test Audio File');
      expect(result.content_type).toBe('audio/wav');
      expect(Number(result.size_bytes)).toBe(204800);
      expect(Number(result.duration_seconds)).toBe(15.5);
    });

    it('allows null duration_seconds', async () => {
      const id = randomUUID();
      const result = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        name: 'No Duration File',
        slug: `audio-noduration-${id}`,
        original_filename: 'noduration.wav',
        content_type: 'audio/wav',
        size_bytes: 1024,
        s3_key: `tenant-1/${id}/noduration.wav`,
      });

      expect(result.duration_seconds).toBeNull();
    });
  });

  describe('findById', () => {
    it('returns the audio file record by id', async () => {
      const inserted = await insertAudioFile({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const found = await audioFileRepository.findById(inserted.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.tenant_id).toBe(uuidFor('tenant-1'));
    });

    it('returns null for non-existent id', async () => {
      const found = await audioFileRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('listByTenant', () => {
    it('returns audio files for the tenant/account with pagination', async () => {
      const suffix = randomUUID().slice(0, 8);
      await insertAudioFile({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `audio-a-${suffix}` });
      await insertAudioFile({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `audio-b-${suffix}` });
      await insertAudioFile({ tenant_id: uuidFor('tenant-2'), account_id: uuidFor('account-2'), name: `audio-other-${suffix}` });

      const { rows, total } = await audioFileRepository.listByTenant(uuidFor('tenant-1'), uuidFor('account-1'), 10, 0);

      expect(rows).toHaveLength(2);
      expect(total).toBe(2);
      expect(rows.every(r => r.tenant_id === uuidFor('tenant-1'))).toBe(true);
    });

    it('respects pagination limit and offset', async () => {
      const suffix = randomUUID().slice(0, 8);
      await insertAudioFile({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `audio-pg-a-${suffix}` });
      await insertAudioFile({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `audio-pg-b-${suffix}` });
      await insertAudioFile({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `audio-pg-c-${suffix}` });

      const page1 = await audioFileRepository.listByTenant(uuidFor('tenant-pg'), uuidFor('account-pg'), 2, 0);
      expect(page1.rows).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await audioFileRepository.listByTenant(uuidFor('tenant-pg'), uuidFor('account-pg'), 2, 2);
      expect(page2.rows).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it('returns empty result for non-existent tenant', async () => {
      const { rows, total } = await audioFileRepository.listByTenant(uuidFor('no-such-tenant'), uuidFor('no-account'), 10, 0);
      expect(rows).toHaveLength(0);
      expect(total).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes an audio file and returns true', async () => {
      const inserted = await insertAudioFile({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const success = await audioFileRepository.delete(inserted.id);
      expect(success).toBe(true);

      const found = await audioFileRepository.findById(inserted.id);
      expect(found).toBeNull();
    });

    it('returns false for non-existent id', async () => {
      const result = await audioFileRepository.delete('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });
  });

  describe('unique constraint on (tenant_id, account_id, name)', () => {
    it('throws on duplicate name within same tenant/account', async () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const sharedName = `unique-audio-${Date.now()}`;

      await audioFileRepository.create({
        tenant_id: uuidFor('tenant-u'),
        account_id: uuidFor('account-u'),
        name: sharedName,
        slug: `audio-${id1}`,
        original_filename: 'file.wav',
        content_type: 'audio/wav',
        size_bytes: 512,
        s3_key: `tenant-u/${id1}/file.wav`,
      });

      await expect(
        audioFileRepository.create({
          tenant_id: uuidFor('tenant-u'),
          account_id: uuidFor('account-u'),
          name: sharedName,
          slug: `audio-${id2}`,
          original_filename: 'file2.wav',
          content_type: 'audio/wav',
          size_bytes: 512,
          s3_key: `tenant-u/${id2}/file2.wav`,
        }),
      ).rejects.toThrow();
    });

    it('allows same name under different tenant/account', async () => {
      const id1 = randomUUID();
      const id2 = randomUUID();
      const sharedName = `shared-audio-${Date.now()}`;

      const r1 = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-a'),
        account_id: uuidFor('account-a'),
        name: sharedName,
        slug: `audio-${id1}`,
        original_filename: 'file.wav',
        content_type: 'audio/wav',
        size_bytes: 512,
        s3_key: `tenant-a/${id1}/file.wav`,
      });

      const r2 = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-b'),
        account_id: uuidFor('account-b'),
        name: sharedName,
        slug: `audio-${id2}`,
        original_filename: 'file.wav',
        content_type: 'audio/wav',
        size_bytes: 512,
        s3_key: `tenant-b/${id2}/file.wav`,
      });

      expect(r1.id).not.toBe(r2.id);
      expect(r1.name).toBe(r2.name);
    });
  });
});
