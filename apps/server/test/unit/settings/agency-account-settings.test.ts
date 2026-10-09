import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * NEW (magick-agency, no source): the per-account settings map that replaces
 * master's governance resolve in the session payload (plan §3.2, lead decision
 * Q3a). Reach is decided by ACTIVE memberships only: a tenant-wide membership
 * (`account_id IS NULL`) reaches every live account in the tenant, an
 * account-scoped one reaches only its account, and NULL columns / a missing row
 * resolve to the documented defaults. Deleted accounts are excluded by the two
 * account reads (`status != 'deleted'`), which the real-Postgres case in
 * `test/integration/settings/agency-account-settings.test.ts` proves.
 */

const mocks = vi.hoisted(() => ({
  findByTenantId: vi.fn(),
  findByIds: vi.fn(),
  listByTenant: vi.fn(),
  findByTenantAndAccount: vi.fn(),
  findAllByUserId: vi.fn(),
  listByUserId: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/account.repository', () => ({
  accountRepository: { findByTenantId: mocks.findByTenantId, findByIds: mocks.findByIds },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    listByTenant: mocks.listByTenant,
    findByTenantAndAccount: mocks.findByTenantAndAccount,
  },
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findAllByUserId: mocks.findAllByUserId },
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { listByUserId: mocks.listByUserId },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  buildAgencyAccountSettingsMap,
  loadAgencyAccountSettings,
  toAgencyAccountSettings,
  DEFAULT_ALLOW_RECORDING,
  DEFAULT_ANALYZE_CALLS,
  DEFAULT_MAX_CONCURRENT_CALLS,
  DEFAULT_WEBRTC_MAX_DURATION_SECONDS,
} from '../../../src/settings/agency-account-settings.js';
import { buildSessionPayload, resolveSettingsSafe } from '../../../src/auth/session-payload.js';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';

const T1 = 'tenant-1';
const T2 = 'tenant-2';
const ACCOUNT_UPDATED = new Date('2026-01-02T03:04:05.000Z');
const ROW_UPDATED = new Date('2026-05-06T07:08:09.000Z');

function account(id: string, tenantId = T1) {
  return { id, tenant_id: tenantId, name: id, slug: id, settings: {}, status: 'active', created_at: ACCOUNT_UPDATED, updated_at: ACCOUNT_UPDATED };
}

function row(accountId: string, overrides: Record<string, unknown> = {}, tenantId = T1) {
  return {
    id: `s-${accountId}`,
    tenant_id: tenantId,
    account_id: accountId,
    max_concurrent_calls: 7,
    concurrency_allocation_mode: 'legacy_total',
    concurrency_allocation_version: 0,
    analyze_calls: true,
    allow_recording: true,
    webrtc_max_duration_seconds: 900,
    created_at: ROW_UPDATED,
    updated_at: ROW_UPDATED,
    ...overrides,
  };
}

function membership(tenantId: string, accountId: string | null, status: MembershipRecord['status'] = 'active') {
  return { tenant_id: tenantId, account_id: accountId, status };
}

describe('agency account settings — defaults', () => {
  it('documents the defaults a NULL column or missing row resolves to', () => {
    expect(DEFAULT_ALLOW_RECORDING).toBe(false);
    expect(DEFAULT_ANALYZE_CALLS).toBe(false);
    expect(DEFAULT_MAX_CONCURRENT_CALLS).toBe(5);
    expect(DEFAULT_WEBRTC_MAX_DURATION_SECONDS).toBe(1800);
  });

  it('resolves NULL columns to the defaults and keeps the row updated_at', () => {
    const out = toAgencyAccountSettings(
      T1,
      account('a1'),
      row('a1', { analyze_calls: null, allow_recording: null, webrtc_max_duration_seconds: null }) as never,
    );
    expect(out).toEqual({
      tenant_id: T1,
      account_id: 'a1',
      allow_recording: false,
      analyze_calls: false,
      max_concurrent_calls: 7,
      webrtc_max_duration_seconds: 1800,
      updated_at: ROW_UPDATED.toISOString(),
    });
  });

  it('with no settings row, every field is a default and updated_at is the account\'s', () => {
    expect(toAgencyAccountSettings(T1, account('a1'), null)).toEqual({
      tenant_id: T1,
      account_id: 'a1',
      allow_recording: false,
      analyze_calls: false,
      max_concurrent_calls: 5,
      webrtc_max_duration_seconds: 1800,
      updated_at: ACCOUNT_UPDATED.toISOString(),
    });
  });

  it('passes stored values through unchanged', () => {
    expect(toAgencyAccountSettings(T1, account('a1'), row('a1') as never)).toMatchObject({
      allow_recording: true,
      analyze_calls: true,
      max_concurrent_calls: 7,
      webrtc_max_duration_seconds: 900,
    });
  });

  it('loadAgencyAccountSettings reads the one row for (tenant, account)', async () => {
    mocks.findByTenantAndAccount.mockResolvedValueOnce(row('a1', { allow_recording: false }));
    const out = await loadAgencyAccountSettings(T1, account('a1'));
    expect(mocks.findByTenantAndAccount).toHaveBeenCalledWith(T1, 'a1');
    expect(out.allow_recording).toBe(false);
    expect(out.max_concurrent_calls).toBe(7);
  });
});

describe('buildAgencyAccountSettingsMap — reach', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByTenantId.mockResolvedValue([]);
    mocks.findByIds.mockResolvedValue([]);
    mocks.listByTenant.mockResolvedValue([]);
  });

  it('a tenant-wide membership reaches every live account in the tenant', async () => {
    mocks.findByTenantId.mockResolvedValue([account('a1'), account('a2')]);
    mocks.listByTenant.mockResolvedValue([row('a1')]);

    const map = await buildAgencyAccountSettingsMap([membership(T1, null)]);

    expect(mocks.findByTenantId).toHaveBeenCalledWith(T1);
    expect(mocks.findByIds).not.toHaveBeenCalled();
    expect(Object.keys(map).sort()).toEqual(['a1', 'a2']);
    expect(map['a1']!.max_concurrent_calls).toBe(7);
    // a2 has no row: defaults.
    expect(map['a2']!.max_concurrent_calls).toBe(5);
    expect(map['a2']!.allow_recording).toBe(false);
  });

  it('an account-scoped membership reaches only its own account, tenant-filtered', async () => {
    mocks.findByIds.mockResolvedValue([account('a1')]);
    mocks.listByTenant.mockResolvedValue([row('a1'), row('a2')]);

    const map = await buildAgencyAccountSettingsMap([membership(T1, 'a1')]);

    expect(mocks.findByTenantId).not.toHaveBeenCalled();
    expect(mocks.findByIds).toHaveBeenCalledWith(['a1'], T1);
    // A settings row for a sibling account is never surfaced.
    expect(Object.keys(map)).toEqual(['a1']);
  });

  it('a tenant-wide membership wins over account-scoped ones in the same tenant', async () => {
    mocks.findByTenantId.mockResolvedValue([account('a1'), account('a2')]);

    const map = await buildAgencyAccountSettingsMap([membership(T1, 'a1'), membership(T1, null)]);

    expect(mocks.findByTenantId).toHaveBeenCalledWith(T1);
    expect(mocks.findByIds).not.toHaveBeenCalled();
    expect(Object.keys(map).sort()).toEqual(['a1', 'a2']);
  });

  it('de-duplicates account ids and covers every tenant the memberships reach', async () => {
    mocks.findByIds.mockImplementation(async (_ids: string[], tenantId: string) =>
      tenantId === T1 ? [account('a1')] : [account('b1', T2)],
    );
    mocks.listByTenant.mockImplementation(async (tenantId: string) =>
      tenantId === T1 ? [] : [row('b1', { allow_recording: true }, T2)],
    );

    const map = await buildAgencyAccountSettingsMap([
      membership(T1, 'a1'),
      membership(T1, 'a1'),
      membership(T2, 'b1'),
    ]);

    expect(mocks.findByIds).toHaveBeenCalledWith(['a1'], T1);
    expect(mocks.findByIds).toHaveBeenCalledWith(['b1'], T2);
    expect(mocks.listByTenant).toHaveBeenCalledTimes(2);
    expect(map['a1']!.tenant_id).toBe(T1);
    expect(map['b1']).toMatchObject({ tenant_id: T2, allow_recording: true });
  });

  it('ignores revoked and inactive memberships entirely', async () => {
    const map = await buildAgencyAccountSettingsMap([
      membership(T1, null, 'revoked'),
      membership(T2, 'b1', 'inactive'),
    ]);

    expect(map).toEqual({});
    expect(mocks.findByTenantId).not.toHaveBeenCalled();
    expect(mocks.findByIds).not.toHaveBeenCalled();
    expect(mocks.listByTenant).not.toHaveBeenCalled();
  });

  it('answers only the accounts the reads return — a deleted account is simply absent', async () => {
    // `findByTenantId` / `findByIds` filter `status != 'deleted'` in SQL.
    mocks.findByIds.mockResolvedValue([]);
    mocks.listByTenant.mockResolvedValue([row('a-deleted')]);

    const map = await buildAgencyAccountSettingsMap([membership(T1, 'a-deleted')]);

    expect(map).toEqual({});
  });
});

describe('resolveSettingsSafe / buildSessionPayload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails open to an empty map when a read throws (master resolveGovernanceSafe posture)', async () => {
    mocks.findByTenantId.mockRejectedValueOnce(new Error('db down'));
    mocks.listByTenant.mockResolvedValue([]);

    await expect(resolveSettingsSafe([membership(T1, null)] as never)).resolves.toEqual({});
    expect(mocks.warn).toHaveBeenCalledOnce();
  });

  it('the session payload carries `settings` (not `governance`) and is_new: false', async () => {
    const memberships = [{ id: 'm1', user_id: 'u1', role: 'agent', ...membership(T1, 'a1') }];
    mocks.findAllByUserId.mockResolvedValue(memberships);
    mocks.listByUserId.mockResolvedValue([{ id: T1 }]);
    mocks.findByIds.mockResolvedValue([account('a1')]);
    mocks.listByTenant.mockResolvedValue([]);

    const payload = await buildSessionPayload({ id: 'u1' }, 'u1');

    expect(payload).not.toHaveProperty('governance');
    expect(payload.is_new).toBe(false);
    expect(payload.memberships).toBe(memberships);
    expect(Object.keys(payload.settings)).toEqual(['a1']);
  });
});
