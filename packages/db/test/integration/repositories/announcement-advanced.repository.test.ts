// PORT NOTE (magick-agency): ported from magic-voice-core/test/integration/repositories/announcement-advanced.repository.test.ts@4850d1d9.
// Changed: connection/repository paths (packages/db layout); tenant/account labels wrapped in
// `uuidFor` (UUID columns); factories come from ../setup/clip-factories.js (audio-type default).
// Decision 4 (uploaded clip only — tts_text/tts_voice/tts_language dropped, type CHECKed to 'audio'):
//  - deleted 'creates a TTS announcement with all fields' and 'sets default voice and language when
//    not provided';
//  - 'creates an audio announcement with audio_file_id': dropped `expect(record.tts_text).toBeNull()`
//    (the column no longer exists);
//  - 'updates multiple fields at once': the two remaining updatable fields (name + audio_file_id)
//    replace name + tts_text + tts_voice, so the multi-column SET is still exercised.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAnnouncement, insertAudioFile } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { announcementRepository } = await import('../../../src/repositories/announcement.repository.js');

describe('AnnouncementRepository advanced scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── create ─────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates an audio announcement with audio_file_id', async () => {
      const audioFile = await insertAudioFile({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const record = await announcementRepository.create({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        name: 'Audio Reminder',
        type: 'audio',
        audio_file_id: audioFile.id,
      });

      expect(record.type).toBe('audio');
      expect(record.audio_file_id).toBe(audioFile.id);
    });
  });

  // ── findById vs findActiveById ────────────────────────────────────────

  describe('findById vs findActiveById', () => {
    it('findById returns soft-deleted records', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('find-t'), account_id: uuidFor('find-a') });
      const pool = getTestPool();
      await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [ann.id]);

      const found = await announcementRepository.findById(ann.id);
      expect(found).not.toBeNull();
      expect(found!.is_active).toBe(false);
    });

    it('findActiveById does NOT return soft-deleted records', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('find-t'), account_id: uuidFor('find-a') });
      const pool = getTestPool();
      await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [ann.id]);

      const found = await announcementRepository.findActiveById(ann.id);
      expect(found).toBeNull();
    });

    it('findActiveById returns active records', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('find-t'), account_id: uuidFor('find-a') });

      const found = await announcementRepository.findActiveById(ann.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(ann.id);
    });
  });

  // ── listByTenant ──────────────────────────────────────────────────────

  describe('listByTenant', () => {
    it('only returns active announcements', async () => {
      await insertAnnouncement({ tenant_id: uuidFor('list-t'), account_id: uuidFor('list-a'), name: 'Active 1' });
      await insertAnnouncement({ tenant_id: uuidFor('list-t'), account_id: uuidFor('list-a'), name: 'Active 2' });
      const deleted = await insertAnnouncement({ tenant_id: uuidFor('list-t'), account_id: uuidFor('list-a'), name: 'Deleted' });

      const pool = getTestPool();
      await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [deleted.id]);

      const { rows, total } = await announcementRepository.listByTenant(uuidFor('list-t'), uuidFor('list-a'));
      expect(total).toBe(2);
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.is_active)).toBe(true);
    });

    it('returns announcements ordered by created_at DESC', async () => {
      const ann1 = await insertAnnouncement({ tenant_id: uuidFor('order-t'), account_id: uuidFor('order-a'), name: 'First' });
      const ann2 = await insertAnnouncement({ tenant_id: uuidFor('order-t'), account_id: uuidFor('order-a'), name: 'Second' });
      const ann3 = await insertAnnouncement({ tenant_id: uuidFor('order-t'), account_id: uuidFor('order-a'), name: 'Third' });

      const { rows } = await announcementRepository.listByTenant(uuidFor('order-t'), uuidFor('order-a'));
      expect(rows[0]!.name).toBe('Third');
      expect(rows[2]!.name).toBe('First');
    });

    it('handles pagination correctly', async () => {
      for (let i = 0; i < 7; i++) {
        await insertAnnouncement({ tenant_id: uuidFor('page-t'), account_id: uuidFor('page-a'), name: `Ann ${i}` });
      }

      const page1 = await announcementRepository.listByTenant(uuidFor('page-t'), uuidFor('page-a'), 3, 0);
      const page2 = await announcementRepository.listByTenant(uuidFor('page-t'), uuidFor('page-a'), 3, 3);
      const page3 = await announcementRepository.listByTenant(uuidFor('page-t'), uuidFor('page-a'), 3, 6);

      expect(page1.total).toBe(7);
      expect(page1.rows).toHaveLength(3);
      expect(page2.rows).toHaveLength(3);
      expect(page3.rows).toHaveLength(1);
    });

    it('isolates by tenant and account', async () => {
      await insertAnnouncement({ tenant_id: uuidFor('iso-A'), account_id: uuidFor('acc-A'), name: 'A only' });
      await insertAnnouncement({ tenant_id: uuidFor('iso-B'), account_id: uuidFor('acc-B'), name: 'B only' });

      const { rows: rowsA } = await announcementRepository.listByTenant(uuidFor('iso-A'), uuidFor('acc-A'));
      const { rows: rowsB } = await announcementRepository.listByTenant(uuidFor('iso-B'), uuidFor('acc-B'));

      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!.name).toBe('A only');
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0]!.name).toBe('B only');
    });
  });

  // ── update ────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates multiple fields at once', async () => {
      const ann = await insertAnnouncement({
        tenant_id: uuidFor('upd-t'),
        account_id: uuidFor('upd-a'),
        name: 'Original',
      });
      const replacement = await insertAudioFile({ tenant_id: uuidFor('upd-t'), account_id: uuidFor('upd-a') });

      const updated = await announcementRepository.update(ann.id, {
        name: 'Updated',
        audio_file_id: replacement.id,
      });

      expect(updated!.name).toBe('Updated');
      expect(updated!.audio_file_id).toBe(replacement.id);
    });

    it('returns the record unchanged when no fields provided', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('upd-t'), account_id: uuidFor('upd-a'), name: 'No Change' });

      const result = await announcementRepository.update(ann.id, {});
      expect(result!.name).toBe('No Change');
    });

    it('does not update soft-deleted announcements', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('upd-t'), account_id: uuidFor('upd-a') });
      const pool = getTestPool();
      await pool.query('UPDATE announcements SET is_active = false WHERE id = $1', [ann.id]);

      const result = await announcementRepository.update(ann.id, { name: 'Should Fail' });
      expect(result).toBeNull();
    });
  });

  // ── softDelete ────────────────────────────────────────────────────────

  describe('softDelete', () => {
    it('sets is_active to false', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('del-t'), account_id: uuidFor('del-a') });

      const result = await announcementRepository.softDelete(ann.id);
      expect(result).toBe(true);

      const found = await announcementRepository.findById(ann.id);
      expect(found!.is_active).toBe(false);
    });

    it('returns false for non-existent record', async () => {
      const result = await announcementRepository.softDelete('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });

    it('returns false when already soft-deleted', async () => {
      const ann = await insertAnnouncement({ tenant_id: uuidFor('del-t'), account_id: uuidFor('del-a') });
      await announcementRepository.softDelete(ann.id);

      const secondDelete = await announcementRepository.softDelete(ann.id);
      expect(secondDelete).toBe(false);
    });
  });
});
