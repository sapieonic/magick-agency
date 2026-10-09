// Agency has no static calls and no TTS announcements (the baseline has no
// tts_text/tts_voice/tts_language columns and CHECKs type to 'audio'), so the lifecycle here is
// create (an 'audio' announcement over an inserted audio file) → update the name → soft-delete.
// Tenant/account labels are wrapped in `uuidFor`.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAudioFile } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { announcementRepository } = await import('../../../src/repositories/announcement.repository.js');

describe('Announcement lifecycle scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── Full lifecycle ────────────────────────────────────────────────────

  describe('full announcement lifecycle', () => {
    it('create → use in static calls → update → soft-delete', async () => {
      // 1. Create announcement
      const audioFile = await insertAudioFile({ tenant_id: uuidFor('lifecycle-t'), account_id: uuidFor('lifecycle-a') });
      const ann = await announcementRepository.create({
        tenant_id: uuidFor('lifecycle-t'),
        account_id: uuidFor('lifecycle-a'),
        name: 'Payment Reminder v1',
        type: 'audio',
        audio_file_id: audioFile.id,
      });
      expect(ann.is_active).toBe(true);

      // 3. Update announcement
      const updated = await announcementRepository.update(ann.id, {
        name: 'Payment Reminder v2',
      });
      expect(updated!.name).toBe('Payment Reminder v2');

      // 4. Soft-delete
      const deleted = await announcementRepository.softDelete(ann.id);
      expect(deleted).toBe(true);

      // 5. Announcement no longer appears in list
      const { rows } = await announcementRepository.listByTenant(uuidFor('lifecycle-t'), uuidFor('lifecycle-a'));
      expect(rows).toHaveLength(0);
    });
  });
});
