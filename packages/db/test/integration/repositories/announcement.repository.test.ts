// Tenant/account labels are wrapped in `uuidFor` (UUID columns); `insertAnnouncement` comes from
// ../setup/clip-factories.js (audio-type default). Announcements are uploaded clips only
// (type CHECKed to 'audio'; no tts_text/tts_voice/tts_language columns). Type-only: `rows[0]!.id`
// (packages/db tsconfig typechecks tests).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAnnouncement } from '../setup/clip-factories.js';
import { uuidFor } from '../setup/factories.js';

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Must import AFTER vi.mock
const { announcementRepository } = await import('../../../src/repositories/announcement.repository.js');

describe('announcementRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('findById', () => {
    it('returns the announcement by id (including inactive)', async () => {
      const inserted = await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const found = await announcementRepository.findById(inserted.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.tenant_id).toBe(uuidFor('tenant-1'));
    });

    it('returns null for non-existent id', async () => {
      const found = await announcementRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('findActiveById', () => {
    it('returns active announcement by id', async () => {
      const inserted = await insertAnnouncement({ is_active: true });

      const found = await announcementRepository.findActiveById(inserted.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
    });

    it('returns null for soft-deleted (inactive) announcement', async () => {
      const inserted = await insertAnnouncement({ is_active: true });
      await announcementRepository.softDelete(inserted.id);

      const found = await announcementRepository.findActiveById(inserted.id);
      expect(found).toBeNull();
    });

    it('returns null for non-existent id', async () => {
      const found = await announcementRepository.findActiveById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('listByTenant', () => {
    it('returns active announcements for tenant/account with pagination', async () => {
      const suffix = randomUUID().slice(0, 8);
      await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `ann-a-${suffix}` });
      await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `ann-b-${suffix}` });
      await insertAnnouncement({ tenant_id: uuidFor('tenant-2'), account_id: uuidFor('account-2'), name: `ann-other-${suffix}` });

      const { rows, total } = await announcementRepository.listByTenant(uuidFor('tenant-1'), uuidFor('account-1'), 10, 0);

      expect(rows).toHaveLength(2);
      expect(total).toBe(2);
      expect(rows.every(r => r.tenant_id === uuidFor('tenant-1'))).toBe(true);
    });

    it('does not include soft-deleted announcements', async () => {
      const suffix = randomUUID().slice(0, 8);
      const a1 = await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `active-ann-${suffix}` });
      const a2 = await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), name: `deleted-ann-${suffix}` });
      await announcementRepository.softDelete(a2.id);

      const { rows, total } = await announcementRepository.listByTenant(uuidFor('tenant-1'), uuidFor('account-1'), 10, 0);

      expect(rows).toHaveLength(1);
      expect(total).toBe(1);
      expect(rows[0]!.id).toBe(a1.id);
    });

    it('respects pagination', async () => {
      const suffix = randomUUID().slice(0, 8);
      await insertAnnouncement({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `pg-ann-a-${suffix}` });
      await insertAnnouncement({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `pg-ann-b-${suffix}` });
      await insertAnnouncement({ tenant_id: uuidFor('tenant-pg'), account_id: uuidFor('account-pg'), name: `pg-ann-c-${suffix}` });

      const page1 = await announcementRepository.listByTenant(uuidFor('tenant-pg'), uuidFor('account-pg'), 2, 0);
      expect(page1.rows).toHaveLength(2);
      expect(page1.total).toBe(3);

      const page2 = await announcementRepository.listByTenant(uuidFor('tenant-pg'), uuidFor('account-pg'), 2, 2);
      expect(page2.rows).toHaveLength(1);
      expect(page2.total).toBe(3);
    });
  });

  describe('update', () => {
    it('updates announcement fields', async () => {
      const inserted = await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const updated = await announcementRepository.update(inserted.id, {
        name: 'Updated Name',
      });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated Name');
    });

    it('returns null for non-existent id', async () => {
      const result = await announcementRepository.update('00000000-0000-0000-0000-000000000000', { name: 'Ghost' });
      expect(result).toBeNull();
    });

    it('returns null after soft-delete', async () => {
      const inserted = await insertAnnouncement();
      await announcementRepository.softDelete(inserted.id);

      const result = await announcementRepository.update(inserted.id, { name: 'Should Fail' });
      expect(result).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('marks announcement as inactive and returns true', async () => {
      const inserted = await insertAnnouncement({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1') });

      const success = await announcementRepository.softDelete(inserted.id);
      expect(success).toBe(true);

      const found = await announcementRepository.findById(inserted.id);
      expect(found!.is_active).toBe(false);
    });

    it('returns false for already-deleted announcement', async () => {
      const inserted = await insertAnnouncement();
      await announcementRepository.softDelete(inserted.id);

      const result = await announcementRepository.softDelete(inserted.id);
      expect(result).toBe(false);
    });

    it('returns false for non-existent id', async () => {
      const result = await announcementRepository.softDelete('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });
  });
});
