// PORT NOTE (magick-agency): ported from magic-voice-core/test/integration/scenarios/announcement-lifecycle.test.ts@4850d1d9.
// Only the announcement parts are carried. Agency has no static calls (`static_calls`,
// `staticCallRepository`, `insertStaticCall`) and no TTS announcements (decision 4: the baseline drops
// tts_text/tts_voice/tts_language and CHECKs type to 'audio').
//  - 'create → use in static calls → update → soft-delete' is MODIFIED: steps 2 (insert static calls)
//    and 6 (static calls still reference the announcement) are removed; step 1 creates an 'audio'
//    announcement over an inserted audio file instead of a TTS one; step 3 updates the name only
//    (no tts_text). Steps 4 and 5 are verbatim. The case name is kept so it maps to the source.
//  - DELETED: 'can update announcement from TTS type to audio type' (TTS type),
//    'can create announcements in different languages' (tts_language),
//    'static calls preserve per-call variables alongside announcement' (static calls),
//    'announcement with very long TTS text', 'announcement with special characters in TTS text',
//    'announcement with unicode/multilingual text' (tts_text). Their describes go with them.
// Also: connection/repository paths (packages/db layout); tenant/account labels wrapped in `uuidFor`.
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
