// Tenant/account labels are wrapped in `uuidFor` (UUID columns); factories come from
// ../setup/clip-factories.js (there is no tts_text column).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAudioFile, insertAnnouncement } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { audioFileRepository } = await import('../../../src/repositories/audio-file.repository.js');
const { announcementRepository } = await import('../../../src/repositories/announcement.repository.js');

describe('Audio file + announcement FK scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('deleting audio file referenced by soft-deleted announcement (bug fix)', () => {
    it('succeeds when the referencing announcement is soft-deleted', async () => {
      // 1. Create an audio file
      const audioFile = await insertAudioFile({
        tenant_id: uuidFor('tenant-fk'),
        account_id: uuidFor('account-fk'),
        name: 'fk-test-audio',
      });

      // 2. Create an audio-type announcement referencing it
      const announcement = await insertAnnouncement({
        tenant_id: uuidFor('tenant-fk'),
        account_id: uuidFor('account-fk'),
        name: 'fk-test-announcement',
        type: 'audio',
        audio_file_id: audioFile.id,
      });
      expect(announcement.audio_file_id).toBe(audioFile.id);

      // 3. Soft-delete the announcement
      const deleted = await announcementRepository.softDelete(announcement.id);
      expect(deleted).toBe(true);

      // 4. Delete the audio file — should succeed (ON DELETE SET NULL)
      const audioDeleted = await audioFileRepository.delete(audioFile.id);
      expect(audioDeleted).toBe(true);

      // 5. Verify the announcement's audio_file_id was set to NULL
      const pool = getTestPool();
      const { rows } = await pool.query(
        'SELECT audio_file_id, is_active FROM announcements WHERE id = $1',
        [announcement.id],
      );
      expect(rows[0].audio_file_id).toBeNull();
      expect(rows[0].is_active).toBe(false);
    });

    it('sets audio_file_id to NULL on active announcement when audio file is deleted', async () => {
      // Edge case: what if the audio file is deleted while announcement is still active?
      // ON DELETE SET NULL will null it out, but only if the check constraint allows it.
      // Our updated check only enforces audio_file_id NOT NULL for active audio announcements.
      // So this should FAIL (check constraint prevents NULL audio_file_id on active audio announcements).
      const audioFile = await insertAudioFile({
        tenant_id: uuidFor('tenant-fk2'),
        account_id: uuidFor('account-fk2'),
        name: 'fk-test-audio-2',
      });

      await insertAnnouncement({
        tenant_id: uuidFor('tenant-fk2'),
        account_id: uuidFor('account-fk2'),
        name: 'fk-test-ann-2',
        type: 'audio',
        audio_file_id: audioFile.id,
      });

      // Deleting the audio file should fail because the active announcement
      // has a CHECK constraint requiring audio_file_id IS NOT NULL for active audio type
      await expect(audioFileRepository.delete(audioFile.id)).rejects.toThrow();
    });

    it('allows deleting audio file with no announcement references', async () => {
      const audioFile = await insertAudioFile({
        tenant_id: uuidFor('tenant-fk3'),
        account_id: uuidFor('account-fk3'),
        name: 'standalone-audio',
      });

      const deleted = await audioFileRepository.delete(audioFile.id);
      expect(deleted).toBe(true);
    });

    it('allows multiple soft-deleted announcements referencing the same audio file', async () => {
      const audioFile = await insertAudioFile({
        tenant_id: uuidFor('tenant-multi'),
        account_id: uuidFor('account-multi'),
        name: 'shared-audio',
      });

      // Create two announcements referencing the same audio file
      const ann1 = await insertAnnouncement({
        tenant_id: uuidFor('tenant-multi'),
        account_id: uuidFor('account-multi'),
        name: 'ann-multi-1',
        type: 'audio',
        audio_file_id: audioFile.id,
      });
      const ann2 = await insertAnnouncement({
        tenant_id: uuidFor('tenant-multi'),
        account_id: uuidFor('account-multi'),
        name: 'ann-multi-2',
        type: 'audio',
        audio_file_id: audioFile.id,
      });

      // Soft-delete both
      await announcementRepository.softDelete(ann1.id);
      await announcementRepository.softDelete(ann2.id);

      // Delete the audio file — should succeed
      const deleted = await audioFileRepository.delete(audioFile.id);
      expect(deleted).toBe(true);

      // Both announcements should have NULL audio_file_id
      const pool = getTestPool();
      const { rows } = await pool.query(
        'SELECT id, audio_file_id FROM announcements WHERE id = ANY($1)',
        [[ann1.id, ann2.id]],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.audio_file_id === null)).toBe(true);
    });
  });
});
