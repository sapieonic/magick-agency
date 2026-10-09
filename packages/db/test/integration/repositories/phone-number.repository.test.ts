import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertTenant,
  insertTelephonyProvider,
  insertPhoneNumber,
  insertPhoneAssignment,
} from '../setup/platform-factories.js';

/*
 * Factories come from `platform-factories`. `pool_eligible` and
 * `findLeastAssigned` are kept at the repository because the column is in the
 * baseline; nothing in agency calls `findLeastAssigned` (no pooled number at
 * tenant create) and the wire contract omits the field.
 */

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Must import AFTER vi.mock
const { phoneNumberRepository } = await import('../../../src/repositories/phone-number.repository.js');

describe('phoneNumberRepository (integration)', () => {
  let provider: any;

  beforeEach(async () => {
    await truncateAll();
    provider = await insertTelephonyProvider();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('create — pool_eligible default', () => {
    it('defaults pool_eligible to false (dedicated) when not specified', async () => {
      const created = await phoneNumberRepository.create({
        phone_number: '+12025550100',
        provider_id: provider.id,
        max_concurrent_calls: 1,
      });
      expect(created.pool_eligible).toBe(false);
    });

    it('persists pool_eligible=true when explicitly opted into the signup pool', async () => {
      const created = await phoneNumberRepository.create({
        phone_number: '+12025550101',
        provider_id: provider.id,
        max_concurrent_calls: 1,
        pool_eligible: true,
      });
      expect(created.pool_eligible).toBe(true);
    });
  });

  describe('update — pool_eligible toggle', () => {
    it('can flip a dedicated number into the signup pool and back', async () => {
      const pn = await insertPhoneNumber({ provider_id: provider.id, pool_eligible: false });

      const opted = await phoneNumberRepository.update(pn.id, { pool_eligible: true });
      expect(opted?.pool_eligible).toBe(true);

      const reverted = await phoneNumberRepository.update(pn.id, { pool_eligible: false });
      expect(reverted?.pool_eligible).toBe(false);
    });
  });

  describe('findLeastAssigned — signup pool selection', () => {
    it('returns null when there are active numbers but none are pool-eligible', async () => {
      // Two active, dedicated numbers — neither should ever be auto-assigned.
      await insertPhoneNumber({ provider_id: provider.id, pool_eligible: false });
      await insertPhoneNumber({ provider_id: provider.id, pool_eligible: false });

      const result = await phoneNumberRepository.findLeastAssigned();
      expect(result).toBeNull();
    });

    it('never picks a dedicated number even when it has fewer assignments', async () => {
      const tenant = await insertTenant();

      // Dedicated number with ZERO assignments (the "least assigned" overall)...
      const dedicated = await insertPhoneNumber({ provider_id: provider.id, pool_eligible: false });
      // ...and a pool-eligible number that already carries an assignment.
      const pooled = await insertPhoneNumber({ provider_id: provider.id, pool_eligible: true });
      await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: pooled.id });

      const result = await phoneNumberRepository.findLeastAssigned();
      expect(result?.id).toBe(pooled.id);
      expect(result?.id).not.toBe(dedicated.id);
    });

    it('returns the least-assigned number among the pool-eligible set', async () => {
      const tenantA = await insertTenant();
      const tenantB = await insertTenant();

      const busy = await insertPhoneNumber({ provider_id: provider.id, pool_eligible: true });
      const idle = await insertPhoneNumber({ provider_id: provider.id, pool_eligible: true });
      // `busy` has two assignments, `idle` has none.
      await insertPhoneAssignment({ tenant_id: tenantA.id, phone_number_id: busy.id });
      await insertPhoneAssignment({ tenant_id: tenantB.id, phone_number_id: busy.id });

      const result = await phoneNumberRepository.findLeastAssigned();
      expect(result?.id).toBe(idle.id);
    });

    it('excludes retired numbers even if they are pool-eligible', async () => {
      await insertPhoneNumber({ provider_id: provider.id, pool_eligible: true, status: 'retired' });

      const result = await phoneNumberRepository.findLeastAssigned();
      expect(result).toBeNull();
    });

    it('joins provider metadata onto the selected number', async () => {
      await insertPhoneNumber({ provider_id: provider.id, pool_eligible: true });

      const result = await phoneNumberRepository.findLeastAssigned();
      expect(result?.provider_name).toBe(provider.name);
    });
  });
});
