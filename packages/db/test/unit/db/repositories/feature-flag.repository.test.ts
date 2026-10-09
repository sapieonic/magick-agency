import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({ query: mocks.poolQuery }),
}));

import { featureFlagRepository } from '../../../../src/repositories/feature-flag.repository.js';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ff-1',
    flag_key: 'whatsapp_personal',
    scope_type: 'tenant',
    tenant_id: 'tenant-1',
    account_id: null,
    value: true,
    reason: null,
    expires_at: null,
    created_by: null,
    updated_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

const lastSql = () => String(mocks.poolQuery.mock.calls.at(-1)![0]);
const lastParams = () => mocks.poolQuery.mock.calls.at(-1)![1] as unknown[];

describe('FeatureFlagRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.poolQuery.mockResolvedValue({ rows: [makeRow()], rowCount: 1 });
  });

  describe('upsert', () => {
    it('global scope: conflict on flag_key (WHERE global), JSON-stringified value', async () => {
      await featureFlagRepository.upsert({
        flag_key: 'whatsapp_personal',
        scope_type: 'global',
        value: true,
        updated_by: 'admin-1',
      });
      const sql = lastSql();
      expect(sql).toContain('ON CONFLICT (flag_key) WHERE scope_type = \'global\'');
      const params = lastParams();
      // value must be passed as JSON text for the JSONB column
      expect(params).toContain(JSON.stringify(true));
    });

    it('tenant scope: conflict on (flag_key, tenant_id) WHERE tenant', async () => {
      await featureFlagRepository.upsert({
        flag_key: 'whatsapp_personal',
        scope_type: 'tenant',
        tenant_id: 'tenant-1',
        value: false,
      });
      expect(lastSql()).toContain('ON CONFLICT (flag_key, tenant_id) WHERE scope_type = \'tenant\'');
      expect(lastParams()).toContain(JSON.stringify(false));
    });

    it('account scope: conflict on (flag_key, tenant_id, account_id) WHERE account', async () => {
      await featureFlagRepository.upsert({
        flag_key: 'whatsapp_personal',
        scope_type: 'account',
        tenant_id: 'tenant-1',
        account_id: 'acc-1',
        value: true,
      });
      expect(lastSql()).toContain(
        'ON CONFLICT (flag_key, tenant_id, account_id) WHERE scope_type = \'account\'',
      );
    });

    it('stringifies a numeric value', async () => {
      await featureFlagRepository.upsert({
        flag_key: 'prewarm_ring_delay_ms',
        scope_type: 'tenant',
        tenant_id: 'tenant-1',
        value: 5000,
      });
      expect(lastParams()).toContain(JSON.stringify(5000));
    });

    it('returns the persisted row', async () => {
      const row = makeRow({ value: false });
      mocks.poolQuery.mockResolvedValueOnce({ rows: [row], rowCount: 1 });
      const result = await featureFlagRepository.upsert({
        flag_key: 'whatsapp_personal',
        scope_type: 'tenant',
        tenant_id: 'tenant-1',
        value: false,
      });
      expect(result).toBe(row);
    });
  });

  describe('findGlobal', () => {
    it('selects only global rows', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [makeRow({ scope_type: 'global', tenant_id: null })] });
      const rows = await featureFlagRepository.findGlobal();
      expect(lastSql()).toContain("scope_type = 'global'");
      expect(rows).toHaveLength(1);
    });
  });

  describe('findByTenant', () => {
    it('restricts to tenant_id and scope_type IN (tenant, account)', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [makeRow()] });
      await featureFlagRepository.findByTenant('tenant-1');
      const sql = lastSql();
      expect(sql).toContain('tenant_id = $1');
      expect(sql).toContain("scope_type IN ('tenant', 'account')");
      expect(lastParams()).toEqual(['tenant-1']);
    });
  });

  describe('findByFlag', () => {
    it('returns all override rows for one flag', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [makeRow(), makeRow({ scope_type: 'global' })] });
      const rows = await featureFlagRepository.findByFlag('whatsapp_personal');
      expect(lastSql()).toContain('flag_key = $1');
      expect(lastParams()).toEqual(['whatsapp_personal']);
      expect(rows).toHaveLength(2);
    });
  });

  describe('findOne', () => {
    it('matches the exact scope tuple via IS NOT DISTINCT FROM, returns the row', async () => {
      const row = makeRow({ value: true });
      mocks.poolQuery.mockResolvedValueOnce({ rows: [row] });
      const result = await featureFlagRepository.findOne({
        flag_key: 'whatsapp_personal', scope_type: 'tenant', tenant_id: 'tenant-1',
      });
      expect(result).toBe(row);
      const sql = lastSql();
      expect(sql).toContain('tenant_id IS NOT DISTINCT FROM $3');
      expect(sql).toContain('account_id IS NOT DISTINCT FROM $4');
      expect(lastParams()).toEqual(['whatsapp_personal', 'tenant', 'tenant-1', null]);
    });

    it('returns null when no row matches', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [] });
      const result = await featureFlagRepository.findOne({
        flag_key: 'whatsapp_personal', scope_type: 'global',
      });
      expect(result).toBeNull();
      expect(lastParams()).toEqual(['whatsapp_personal', 'global', null, null]);
    });
  });

  describe('delete', () => {
    it('returns true when a row was deleted', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
      const ok = await featureFlagRepository.delete({
        flag_key: 'whatsapp_personal',
        scope_type: 'tenant',
        tenant_id: 'tenant-1',
      });
      expect(ok).toBe(true);
    });

    it('returns false when nothing was deleted', async () => {
      mocks.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const ok = await featureFlagRepository.delete({
        flag_key: 'whatsapp_personal',
        scope_type: 'global',
      });
      expect(ok).toBe(false);
    });
  });
});
