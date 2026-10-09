// PORT NOTE (magick-agency): ported from master test/integration/repositories/account.repository.test.ts@a1f0756a (16 → 16) on real Postgres via the master pattern (`src/connection.js` → the test pool); import specifiers remapped plus one type-only `!` (agency typechecks tests, B1).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertAccount } from '../setup/platform-factories.js';

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Must import AFTER vi.mock
const { accountRepository } = await import('../../../src/repositories/account.repository.js');

describe('accountRepository (integration)', () => {
  let tenant: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create', () => {
    it('inserts an account and returns the record', async () => {
      const result = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Engineering',
        slug: 'engineering',
      });

      expect(result.id).toBeDefined();
      expect(result.tenant_id).toBe(tenant.id);
      expect(result.name).toBe('Engineering');
      expect(result.slug).toBe('engineering');
      expect(result.status).toBe('active');
    });

    it('rejects duplicate slug within the same tenant', async () => {
      await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Engineering',
        slug: 'engineering',
      });

      await expect(
        accountRepository.create({
          tenant_id: tenant.id,
          name: 'Engineering 2',
          slug: 'engineering',
        }),
      ).rejects.toThrow();
    });

    it('allows same slug in different tenants', async () => {
      const tenant2 = await insertTenant({ slug: 'other-tenant' });

      await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Engineering',
        slug: 'shared-slug',
      });

      const result = await accountRepository.create({
        tenant_id: tenant2.id,
        name: 'Engineering',
        slug: 'shared-slug',
      });

      expect(result.slug).toBe('shared-slug');
    });
  });

  describe('findById', () => {
    it('returns the account by id', async () => {
      const inserted = await insertAccount({ tenant_id: tenant.id });

      const found = await accountRepository.findById(inserted.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.name).toBe(inserted.name);
    });

    it('returns null for non-existent id', async () => {
      const found = await accountRepository.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });

    it('returns null for soft-deleted account', async () => {
      const inserted = await insertAccount({ tenant_id: tenant.id });
      await accountRepository.softDelete(inserted.id, tenant.id);

      const found = await accountRepository.findById(inserted.id);
      expect(found).toBeNull();
    });
  });

  describe('findByTenantId', () => {
    it('returns active accounts for tenant', async () => {
      await insertAccount({ tenant_id: tenant.id, name: 'Acct A', slug: 'acct-a' });
      await insertAccount({ tenant_id: tenant.id, name: 'Acct B', slug: 'acct-b' });

      const results = await accountRepository.findByTenantId(tenant.id);

      expect(results).toHaveLength(2);
      expect(results.every((r: any) => r.tenant_id === tenant.id)).toBe(true);
    });

    it('excludes soft-deleted accounts', async () => {
      const a1 = await insertAccount({ tenant_id: tenant.id, name: 'Active', slug: 'active' });
      const a2 = await insertAccount({ tenant_id: tenant.id, name: 'Deleted', slug: 'deleted' });
      await accountRepository.softDelete(a2.id, tenant.id);

      const results = await accountRepository.findByTenantId(tenant.id);

      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(a1.id);
    });
  });

  describe('update', () => {
    it('updates account fields', async () => {
      const inserted = await insertAccount({ tenant_id: tenant.id });

      const updated = await accountRepository.update(inserted.id, tenant.id, { name: 'Updated Name' });

      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated Name');
    });

    it('returns null for non-existent id', async () => {
      const result = await accountRepository.update('00000000-0000-0000-0000-000000000000', tenant.id, { name: 'Ghost' });
      expect(result).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('marks account as deleted and returns true', async () => {
      const inserted = await insertAccount({ tenant_id: tenant.id });

      const success = await accountRepository.softDelete(inserted.id, tenant.id);
      expect(success).toBe(true);

      // Should no longer be found
      const found = await accountRepository.findById(inserted.id);
      expect(found).toBeNull();
    });

    it('returns false for already-deleted account', async () => {
      const inserted = await insertAccount({ tenant_id: tenant.id });
      await accountRepository.softDelete(inserted.id, tenant.id);

      const result = await accountRepository.softDelete(inserted.id, tenant.id);
      expect(result).toBe(false);
    });

    it('returns false for non-existent id', async () => {
      const result = await accountRepository.softDelete('00000000-0000-0000-0000-000000000000', tenant.id);
      expect(result).toBe(false);
    });
  });

  describe('soft-delete slug reuse (bug fix)', () => {
    it('allows creating an account with the same slug after the original is soft-deleted', async () => {
      // 1. Create account with slug "finance"
      const original = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Finance',
        slug: 'finance',
      });
      expect(original.slug).toBe('finance');

      // 2. Soft-delete it
      const deleted = await accountRepository.softDelete(original.id, tenant.id);
      expect(deleted).toBe(true);

      // 3. Create a new account with the same slug — should succeed
      const reused = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Finance Team',
        slug: 'finance',
      });
      expect(reused.slug).toBe('finance');
      expect(reused.id).not.toBe(original.id);
    });

    it('allows multiple soft-deleted accounts with the same slug', async () => {
      // Create and delete twice
      const a1 = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Temp 1',
        slug: 'temp',
      });
      await accountRepository.softDelete(a1.id, tenant.id);

      const a2 = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Temp 2',
        slug: 'temp',
      });
      await accountRepository.softDelete(a2.id, tenant.id);

      // Create a third with the same slug — should succeed
      const a3 = await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Temp 3',
        slug: 'temp',
      });
      expect(a3.slug).toBe('temp');
      expect(a3.status).toBe('active');
    });

    it('still prevents duplicate slugs among active accounts', async () => {
      await accountRepository.create({
        tenant_id: tenant.id,
        name: 'Active Finance',
        slug: 'finance',
      });

      await expect(
        accountRepository.create({
          tenant_id: tenant.id,
          name: 'Duplicate Finance',
          slug: 'finance',
        }),
      ).rejects.toThrow();
    });
  });
});
