// Real Postgres: `src/connection.js` is pointed at the test pool.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertUser, insertMembership } from '../setup/platform-factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { tenantRepository } = await import('../../../src/repositories/tenant.repository.js');

describe('tenantRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create', () => {
    it('inserts a tenant and returns the record with correct fields', async () => {
      const result = await tenantRepository.create({
        name: 'Acme Corp',
        slug: 'acme-corp',
        settings: { timezone: 'UTC' },
      });

      expect(result.id).toBeDefined();
      expect(result.name).toBe('Acme Corp');
      expect(result.slug).toBe('acme-corp');
      expect(result.status).toBe('active');
      expect(result.created_at).toBeDefined();
    });
  });

  describe('findById', () => {
    it('returns tenant by id', async () => {
      const inserted = await insertTenant({ name: 'FindMe', slug: 'find-me' });

      const found = await tenantRepository.findById(inserted.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.name).toBe('FindMe');
    });

    it('returns null for non-existent id', async () => {
      const found = await tenantRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });

    it('returns null for deleted tenant', async () => {
      const inserted = await insertTenant();
      await tenantRepository.softDelete(inserted.id);

      const found = await tenantRepository.findById(inserted.id);
      expect(found).toBeNull();
    });
  });

  describe('findBySlug', () => {
    it('returns tenant by slug', async () => {
      const inserted = await insertTenant({ name: 'Slug Tenant', slug: 'slug-tenant' });

      const found = await tenantRepository.findBySlug('slug-tenant');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.name).toBe('Slug Tenant');
    });

    it('returns null for non-existent slug', async () => {
      const found = await tenantRepository.findBySlug('does-not-exist');
      expect(found).toBeNull();
    });
  });

  describe('update', () => {
    it('updates name and returns updated record', async () => {
      const inserted = await insertTenant({ name: 'Old Name', slug: 'update-test' });

      const updated = await tenantRepository.update(inserted.id, { name: 'New Name' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('New Name');
      expect(updated!.id).toBe(inserted.id);
    });

    it('returns null for non-existent id', async () => {
      const result = await tenantRepository.update('00000000-0000-0000-0000-000000000000', { name: 'Ghost' });
      expect(result).toBeNull();
    });
  });

  describe('listByUserId', () => {
    it('returns tenants where user has active memberships', async () => {
      const user = await insertUser();
      const tenant1 = await insertTenant({ name: 'Tenant A', slug: 'tenant-a' });
      const tenant2 = await insertTenant({ name: 'Tenant B', slug: 'tenant-b' });

      await insertMembership({ user_id: user.id, tenant_id: tenant1.id, role: 'tenant_owner' });
      await insertMembership({ user_id: user.id, tenant_id: tenant2.id, role: 'viewer' });

      const tenants = await tenantRepository.listByUserId(user.id);

      expect(tenants).toHaveLength(2);
      const names = tenants.map((t: any) => t.name);
      expect(names).toContain('Tenant A');
      expect(names).toContain('Tenant B');
    });

    it('returns empty array for user with no memberships', async () => {
      const user = await insertUser();

      const tenants = await tenantRepository.listByUserId(user.id);

      expect(tenants).toHaveLength(0);
    });
  });

  describe('softDelete', () => {
    it('marks tenant as deleted and is no longer found by findById', async () => {
      const inserted = await insertTenant();

      const success = await tenantRepository.softDelete(inserted.id);
      expect(success).toBe(true);

      const found = await tenantRepository.findById(inserted.id);
      expect(found).toBeNull();
    });

    it('returns false for non-existent id', async () => {
      const result = await tenantRepository.softDelete('00000000-0000-0000-0000-000000000000');
      expect(result).toBe(false);
    });

    it('returns false for already-deleted tenant', async () => {
      const inserted = await insertTenant();
      await tenantRepository.softDelete(inserted.id);

      const result = await tenantRepository.softDelete(inserted.id);
      expect(result).toBe(false);
    });
  });
});
