import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccount, insertAccountSettings, insertTenant, insertUser } from '../setup/factories.js';

/**
 * Every shared-infrastructure repository method that other suites exercise
 * only through a MOCKED pool, run at least once
 * against the real baseline on Postgres 5436. A mocked pool hides SQL drift — a
 * renamed column, a dropped one, a UUID column handed a free-form id — because
 * the fixture supplies the keys the query never reads.
 *
 * Covered here (everything else is covered by a real-Postgres suite):
 *  - featureFlagRepository: upsert (each scope), findGlobal, findByTenant,
 *    findOne, findByFlag, delete, upsertMany — otherwise tested only with a mock.
 *  - platform auditRepository (`platform_audit_log`): insertBatch (human and
 *    system actors), find (filters, offset, keyset, withTotal) — otherwise tested
 *    only with a mock.
 *  - accountSettingsRepository.listByTenant and .getWebrtcMaxDurationSeconds.
 *  - agencyCampaignAgentRepository.listAllForUser and .closeAllForUser (the
 *    revoke path) — no other integration suite reaches either.
 */

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { featureFlagRepository } = await import('../../../src/repositories/feature-flag.repository.js');
const { platformAuditRepository } = await import('../../../src/repositories/platform/audit.repository.js');
const { accountSettingsRepository } = await import('../../../src/repositories/account-settings.repository.js');
const { agencyCampaignAgentRepository } = await import(
  '../../../src/repositories/agency-campaign-agent.repository.js'
);

describe('shared infrastructure repositories against the real baseline', () => {
  beforeEach(async () => {
    await truncateAll();
    accountSettingsRepository.clearCache();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('featureFlagRepository (feature_flag_overrides)', () => {
    const TENANT = randomUUID();
    const ACCOUNT = randomUUID();

    it('upserts one override per scope target and reads each snapshot back', async () => {
      const global = await featureFlagRepository.upsert({
        flag_key: 'agency_dialer_enabled', scope_type: 'global', value: false, updated_by: 'sa-1',
      });
      const tenant = await featureFlagRepository.upsert({
        flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT, value: true, reason: 'pilot',
      });
      const account = await featureFlagRepository.upsert({
        flag_key: 'agency_late_binding', scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT, value: true,
        expires_at: new Date(Date.now() + 3_600_000),
      });

      expect(global).toMatchObject({ scope_type: 'global', tenant_id: null, account_id: null, value: false, created_by: 'sa-1' });
      expect(tenant).toMatchObject({ scope_type: 'tenant', tenant_id: TENANT, value: true, reason: 'pilot' });
      expect(account).toMatchObject({ scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT, value: true });
      expect(account.expires_at).toBeInstanceOf(Date);

      expect((await featureFlagRepository.findGlobal()).map((r) => r.id)).toEqual([global.id]);
      expect((await featureFlagRepository.findByTenant(TENANT)).map((r) => r.id).sort()).toEqual([tenant.id, account.id].sort());
      expect(await featureFlagRepository.findByTenant(randomUUID())).toEqual([]);
    });

    it('upsert updates in place on the partial-unique conflict target (same id, new value)', async () => {
      const first = await featureFlagRepository.upsert({
        flag_key: 'agency_call_analysis', scope_type: 'tenant', tenant_id: TENANT, value: true, updated_by: 'a',
      });
      const second = await featureFlagRepository.upsert({
        flag_key: 'agency_call_analysis', scope_type: 'tenant', tenant_id: TENANT, value: false, updated_by: 'b',
      });
      expect(second.id).toBe(first.id);
      expect(second).toMatchObject({ value: false, created_by: 'a', updated_by: 'b' });
      const { rows } = await getTestPool().query('SELECT COUNT(*)::int AS n FROM feature_flag_overrides');
      expect(rows[0].n).toBe(1);
    });

    it('findOne matches the exact tuple, NULL dimensions included', async () => {
      await featureFlagRepository.upsert({ flag_key: 'agency_dialer_enabled', scope_type: 'global', value: true });
      await featureFlagRepository.upsert({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT, value: false });

      expect(await featureFlagRepository.findOne({ flag_key: 'agency_dialer_enabled', scope_type: 'global' }))
        .toMatchObject({ scope_type: 'global', value: true });
      expect(await featureFlagRepository.findOne({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT }))
        .toMatchObject({ scope_type: 'tenant', value: false });
      expect(await featureFlagRepository.findOne({
        flag_key: 'agency_dialer_enabled', scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT,
      })).toBeNull();
    });

    it('findByFlag lists every scope of one flag; delete removes exactly one tuple', async () => {
      await featureFlagRepository.upsertMany([
        { flag_key: 'agency_dialer_enabled', scope_type: 'global', value: false },
        { flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT, value: true },
        { flag_key: 'agency_dialer_enabled', scope_type: 'account', tenant_id: TENANT, account_id: ACCOUNT, value: false },
        { flag_key: 'agency_late_binding', scope_type: 'tenant', tenant_id: TENANT, value: true },
      ]);

      const rows = await featureFlagRepository.findByFlag('agency_dialer_enabled');
      expect(rows.map((r) => r.scope_type)).toEqual(['account', 'global', 'tenant']);

      expect(await featureFlagRepository.delete({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT })).toBe(true);
      expect(await featureFlagRepository.delete({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: TENANT })).toBe(false);
      expect((await featureFlagRepository.findByFlag('agency_dialer_enabled')).map((r) => r.scope_type)).toEqual(['account', 'global']);
      expect(await featureFlagRepository.findByFlag('agency_late_binding')).toHaveLength(1);
    });
  });

  describe('platform auditRepository (platform_audit_log)', () => {
    const TENANT = randomUUID();
    const ACCOUNT = randomUUID();
    const CAMPAIGN = randomUUID();
    const USER = randomUUID();

    it('insertBatch writes both actor shapes; user_id only for a human, never for system', async () => {
      await platformAuditRepository.insertBatch([
        {
          tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'human', user_id: USER,
          action: 'agency_campaign.paused', resource_type: 'agency_campaign', resource_id: CAMPAIGN,
          campaign_id: CAMPAIGN, details: { reason: 'lunch' }, ip_address: '10.0.0.1',
        },
        // A smuggled user_id on a system row must not reach the column.
        { tenant_id: TENANT, actor_type: 'system', user_id: USER, action: 'dnc_entry.created', resource_type: 'dnc_entry' } as never,
      ]);

      const { rows } = await getTestPool().query(
        `SELECT actor_type, user_id, account_id, campaign_id, details, ip_address, action
           FROM platform_audit_log WHERE tenant_id = $1 ORDER BY action`,
        [TENANT],
      );
      expect(rows).toEqual([
        {
          actor_type: 'human', user_id: USER, account_id: ACCOUNT, campaign_id: CAMPAIGN,
          details: { reason: 'lunch' }, ip_address: '10.0.0.1', action: 'agency_campaign.paused',
        },
        {
          actor_type: 'system', user_id: null, account_id: null, campaign_id: null,
          details: {}, ip_address: null, action: 'dnc_entry.created',
        },
      ]);
    });

    it('find filters, counts, pages by offset and walks a keyset without loss', async () => {
      const events = Array.from({ length: 5 }, (_, i) => ({
        tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'human' as const, user_id: USER,
        action: i % 2 === 0 ? 'agency_session.joined' : 'agency_session.left',
        resource_type: 'agency_session', resource_id: `s-${i}`, campaign_id: CAMPAIGN,
      }));
      await platformAuditRepository.insertBatch(events);
      await platformAuditRepository.insertBatch([
        { tenant_id: randomUUID(), actor_type: 'system', action: 'agency_session.joined', resource_type: 'agency_session' },
      ]);

      const all = await platformAuditRepository.find({ tenantId: TENANT, accountId: ACCOUNT, campaignId: CAMPAIGN });
      expect(all.total).toBe(5);
      expect(all.logs).toHaveLength(5);

      const joined = await platformAuditRepository.find({
        tenantId: TENANT, actions: ['agency_session.joined'], actorType: 'human', resourceType: 'agency_session',
      });
      expect(joined.total).toBe(3);

      const single = await platformAuditRepository.find({ tenantId: TENANT, action: 'agency_session.left', resourceId: 's-1' });
      expect(single.logs.map((l) => l.resource_id)).toEqual(['s-1']);

      const windowed = await platformAuditRepository.find({
        tenantId: TENANT, from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000), limit: 2, offset: 2, withTotal: false,
      });
      expect(windowed.total).toBeNull();
      expect(windowed.logs).toHaveLength(2);

      // Keyset walk: one flush shares a timestamp, so `id` is what orders the page.
      const seen: string[] = [];
      let before: { createdAt: Date; id: string } | undefined;
      for (;;) {
        const page = await platformAuditRepository.find({ tenantId: TENANT, limit: 2, keysetOrder: true, before, withTotal: false });
        seen.push(...page.logs.map((l) => l.id));
        const last = page.logs.at(-1);
        if (!last || page.logs.length < 2) break;
        before = { createdAt: last.created_at, id: last.id };
      }
      expect(new Set(seen).size).toBe(5);
      expect(seen).toHaveLength(5);
    });
  });

  describe('accountSettingsRepository (account_settings)', () => {
    it('listByTenant returns the tenant rows newest first; getWebrtcMaxDurationSeconds reads the added column', async () => {
      const tenant = randomUUID();
      const older = await insertAccountSettings({
        tenant_id: tenant, account_id: randomUUID(), created_at: new Date(Date.now() - 60_000),
      });
      const newer = await insertAccountSettings({
        tenant_id: tenant, account_id: randomUUID(), webrtc_max_duration_seconds: 1800,
      });
      await insertAccountSettings({ tenant_id: randomUUID(), account_id: randomUUID() });

      const rows = await accountSettingsRepository.listByTenant(tenant);
      expect(rows.map((r) => r.id)).toEqual([newer.id, older.id]);
      expect(rows[0]!.webrtc_max_duration_seconds).toBe(1800);
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(tenant, newer.account_id)).toBe(1800);
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(tenant, older.account_id)).toBeNull();
    });
  });

  describe('agencyCampaignAgentRepository (agency_campaign_agents)', () => {
    it('listAllForUser returns history newest first and honours the window; closeAllForUser closes every open row once', async () => {
      const tenant = await insertTenant();
      const accountA = await insertAccount({ tenant_id: tenant.id });
      const accountB = await insertAccount({ tenant_id: tenant.id });
      const user = await insertUser();
      const [c1, c2, c3] = [randomUUID(), randomUUID(), randomUUID()];

      await agencyCampaignAgentRepository.assign({ tenant_id: tenant.id, account_id: accountA.id, campaign_id: c1, user_id: user.id });
      await agencyCampaignAgentRepository.assign({ tenant_id: tenant.id, account_id: accountB.id, campaign_id: c2, user_id: user.id });
      await agencyCampaignAgentRepository.assign({ tenant_id: tenant.id, account_id: null, campaign_id: c3, user_id: user.id });

      const history = await agencyCampaignAgentRepository.listAllForUser(tenant.id, user.id);
      expect(history).toHaveLength(3);
      expect(await agencyCampaignAgentRepository.listAllForUser(tenant.id, user.id, { limit: 0 })).toHaveLength(1);
      expect(await agencyCampaignAgentRepository.listAllForUser(tenant.id, user.id, { to: new Date(Date.now() - 3_600_000) }))
        .toEqual([]);

      // Account-scoped close reaches only that account's row (equality, not IS NULL OR =).
      const scoped = await agencyCampaignAgentRepository.closeAllForUser(tenant.id, user.id, accountA.id);
      expect(scoped).toEqual([{ id: expect.any(String), campaign_id: c1, account_id: accountA.id }]);

      // Tenant-wide close takes the rest, including the tenant-level (NULL account) row.
      const rest = await agencyCampaignAgentRepository.closeAllForUser(tenant.id, user.id);
      expect(rest.map((r) => r.campaign_id).sort()).toEqual([c2, c3].sort());
      expect(rest.find((r) => r.campaign_id === c3)!.account_id).toBeNull();

      expect(await agencyCampaignAgentRepository.closeAllForUser(tenant.id, user.id)).toEqual([]);
      expect(await agencyCampaignAgentRepository.listActiveForUser(tenant.id, user.id)).toEqual([]);
      // Closed, not deleted: the history still answers.
      expect((await agencyCampaignAgentRepository.listAllForUser(tenant.id, user.id)).every((r) => r.unassigned_at !== null)).toBe(true);
    });
  });
});
