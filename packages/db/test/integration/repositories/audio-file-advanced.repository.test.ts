// Tenant/account labels are wrapped in `uuidFor` (UUID columns); `insertAudioFile` comes from ../setup/clip-factories.js.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAudioFile } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { audioFileRepository } = await import('../../../src/repositories/audio-file.repository.js');

describe('AudioFileRepository advanced scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates an audio file record with all fields', async () => {
      const record = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        name: 'Payment Reminder Audio',
        slug: 'payment-reminder-audio',
        original_filename: 'reminder.wav',
        content_type: 'audio/wav',
        size_bytes: 2048,
        s3_key: 'tenant-1/abc-123/reminder.wav',
        duration_seconds: 15,
      });

      expect(record.id).toBeDefined();
      expect(record.name).toBe('Payment Reminder Audio');
      expect(record.slug).toBe('payment-reminder-audio');
      expect(record.original_filename).toBe('reminder.wav');
      expect(record.content_type).toBe('audio/wav');
      expect(Number(record.size_bytes)).toBe(2048);
      expect(record.s3_key).toBe('tenant-1/abc-123/reminder.wav');
      expect(Number(record.duration_seconds)).toBe(15);
    });

    it('creates record with null duration_seconds', async () => {
      const record = await audioFileRepository.create({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        name: 'No Duration',
        slug: 'no-duration',
        original_filename: 'test.mp3',
        content_type: 'audio/mpeg',
        size_bytes: 1024,
        s3_key: 'tenant-1/def/test.mp3',
      });

      expect(record.duration_seconds).toBeNull();
    });
  });

  // ── findById ───────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the audio file by ID', async () => {
      const file = await insertAudioFile({
        tenant_id: uuidFor('find-t'),
        account_id: uuidFor('find-a'),
        name: 'Test Audio',
      });

      const found = await audioFileRepository.findById(file.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(file.id);
      expect(found!.name).toBe('Test Audio');
    });

    it('returns null for non-existent ID', async () => {
      const found = await audioFileRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  // ── listByTenant ──────────────────────────────────────────────────────

  describe('listByTenant', () => {
    it('returns files for the correct tenant+account', async () => {
      await insertAudioFile({ tenant_id: uuidFor('list-t'), account_id: uuidFor('list-a'), name: 'File 1' });
      await insertAudioFile({ tenant_id: uuidFor('list-t'), account_id: uuidFor('list-a'), name: 'File 2' });
      await insertAudioFile({ tenant_id: uuidFor('other-t'), account_id: uuidFor('other-a'), name: 'Other' });

      const { rows, total } = await audioFileRepository.listByTenant(uuidFor('list-t'), uuidFor('list-a'));
      expect(total).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.tenant_id === uuidFor('list-t'))).toBe(true);
    });

    it('returns empty list when no files exist', async () => {
      const { rows, total } = await audioFileRepository.listByTenant(uuidFor('empty-t'), uuidFor('empty-a'));
      expect(total).toBe(0);
      expect(rows).toEqual([]);
    });

    it('handles pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await insertAudioFile({ tenant_id: uuidFor('page-t'), account_id: uuidFor('page-a'), name: `File ${i}` });
      }

      const page1 = await audioFileRepository.listByTenant(uuidFor('page-t'), uuidFor('page-a'), 2, 0);
      const page2 = await audioFileRepository.listByTenant(uuidFor('page-t'), uuidFor('page-a'), 2, 2);

      expect(page1.total).toBe(5);
      expect(page1.rows).toHaveLength(2);
      expect(page2.rows).toHaveLength(2);
    });

    it('returns files ordered by created_at DESC', async () => {
      await insertAudioFile({ tenant_id: uuidFor('ord-t'), account_id: uuidFor('ord-a'), name: 'First' });
      await insertAudioFile({ tenant_id: uuidFor('ord-t'), account_id: uuidFor('ord-a'), name: 'Second' });
      await insertAudioFile({ tenant_id: uuidFor('ord-t'), account_id: uuidFor('ord-a'), name: 'Third' });

      const { rows } = await audioFileRepository.listByTenant(uuidFor('ord-t'), uuidFor('ord-a'));
      expect(rows[0]!.name).toBe('Third');
      expect(rows[2]!.name).toBe('First');
    });
  });

  // ── delete ────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('hard deletes the audio file', async () => {
      const file = await insertAudioFile({ tenant_id: uuidFor('del-t'), account_id: uuidFor('del-a') });

      const result = await audioFileRepository.delete(file.id);
      expect(result).toBe(true);

      const found = await audioFileRepository.findById(file.id);
      expect(found).toBeNull();
    });

    it('returns false for non-existent ID', async () => {
      const result = await audioFileRepository.delete('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });

    it('deleted file no longer appears in list', async () => {
      const file = await insertAudioFile({ tenant_id: uuidFor('del-list-t'), account_id: uuidFor('del-list-a'), name: 'To Delete' });
      await insertAudioFile({ tenant_id: uuidFor('del-list-t'), account_id: uuidFor('del-list-a'), name: 'To Keep' });

      await audioFileRepository.delete(file.id);

      const { rows, total } = await audioFileRepository.listByTenant(uuidFor('del-list-t'), uuidFor('del-list-a'));
      expect(total).toBe(1);
      expect(rows[0]!.name).toBe('To Keep');
    });
  });

  // ── Tenant isolation ──────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('tenant A cannot see tenant B files', async () => {
      await insertAudioFile({ tenant_id: uuidFor('iso-A'), account_id: uuidFor('acc-A'), name: 'A File' });
      await insertAudioFile({ tenant_id: uuidFor('iso-B'), account_id: uuidFor('acc-B'), name: 'B File' });

      const { rows: rowsA } = await audioFileRepository.listByTenant(uuidFor('iso-A'), uuidFor('acc-A'));
      const { rows: rowsB } = await audioFileRepository.listByTenant(uuidFor('iso-B'), uuidFor('acc-B'));

      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.name).toBe('A File');
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]!.name).toBe('B File');
    });

    it('different accounts within same tenant are isolated', async () => {
      await insertAudioFile({ tenant_id: uuidFor('shared-t'), account_id: uuidFor('acc-X'), name: 'X File' });
      await insertAudioFile({ tenant_id: uuidFor('shared-t'), account_id: uuidFor('acc-Y'), name: 'Y File' });

      const { rows: rowsX } = await audioFileRepository.listByTenant(uuidFor('shared-t'), uuidFor('acc-X'));
      const { rows: rowsY } = await audioFileRepository.listByTenant(uuidFor('shared-t'), uuidFor('acc-Y'));

      expect(rowsX).toHaveLength(1);
      expect(rowsX[0]!.name).toBe('X File');
      expect(rowsY).toHaveLength(1);
      expect(rowsY[0]!.name).toBe('Y File');
    });
  });
});
