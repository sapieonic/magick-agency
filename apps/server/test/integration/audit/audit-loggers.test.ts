import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { SYSTEM_AUDIT_ACTOR } from '../../../src/audit/platform/audit-actor.js';
import { getAuditRetentionHorizon, resetAuditRetentionCache } from '../../../src/audit/audit-retention.js';

/**
 * NEW (magick-agency, no source). Neither source tests its audit LOGGER against
 * a database: core and master each cover the repository and nothing drives
 * `log() → buffer → flush → INSERT` end to end. These do, for both halves of the
 * activity trail (decision B7) — core's `auditLogger` into `audit_logs` (with
 * PII masking) and master's `platformAuditLogger` into `platform_audit_log` —
 * plus core's retention horizon read against the baseline's real partitions.
 */
describe('audit loggers against the real baseline (integration)', () => {
  const TENANT = randomUUID();
  const ACCOUNT = randomUUID();

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  it("core's auditLogger masks PII and flushes the buffer into audit_logs", async () => {
    const campaignId = randomUUID();
    auditLogger.log({
      tenantId: TENANT,
      accountId: ACCOUNT,
      eventType: 'agency_campaign.auto_paused',
      eventCategory: 'system',
      severity: 'info',
      eventData: { campaign_id: campaignId, phone: '+919876543210' },
      actor: 'system:pacing-leader',
    });
    expect(auditLogger.getBufferSize()).toBe(1);
    await auditLogger.shutdown();
    expect(auditLogger.getBufferSize()).toBe(0);

    const { rows } = await getTestPool().query(
      `SELECT event_type, actor, event_data FROM audit_logs WHERE tenant_id = $1 AND account_id = $2`,
      [TENANT, ACCOUNT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('agency_campaign.auto_paused');
    expect(rows[0].actor).toBe('system:pacing-leader');
    expect(rows[0].event_data.campaign_id).toBe(campaignId);
    expect(rows[0].event_data.phone).not.toBe('+919876543210');
  });

  it("master's platformAuditLogger flushes catalog-typed rows into platform_audit_log", async () => {
    const userId = randomUUID();
    const campaignId = randomUUID();
    platformAuditLogger.log({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: userId,
      action: 'agency_campaign.paused',
      resource_type: 'agency_campaign',
      resource_id: campaignId,
      campaign_id: campaignId,
    });
    platformAuditLogger.log({
      tenant_id: TENANT,
      ...SYSTEM_AUDIT_ACTOR,
      action: 'dnc_entry.created',
      resource_type: 'dnc_entry',
    });
    await platformAuditLogger.shutdown();

    const { rows } = await getTestPool().query(
      `SELECT action, actor_type, user_id, campaign_id FROM platform_audit_log WHERE tenant_id = $1 ORDER BY action`,
      [TENANT],
    );
    expect(rows).toEqual([
      { action: 'agency_campaign.paused', actor_type: 'human', user_id: userId, campaign_id: campaignId },
      { action: 'dnc_entry.created', actor_type: 'system', user_id: null, campaign_id: null },
    ]);
  });

  it('a write outside the catalog, or with a half-stated actor, does not compile', () => {
    const compileOnly = (): void => {
      // @ts-expect-error — not in PLATFORM_AUDIT_ACTIONS (master's scheduling action, trimmed).
      platformAuditLogger.log({ tenant_id: TENANT, ...SYSTEM_AUDIT_ACTOR, action: 'schedule.created', resource_type: 'dnc_entry' });
      // @ts-expect-error — a human row must name the user.
      platformAuditLogger.log({ tenant_id: TENANT, actor_type: 'human', action: 'dnc_entry.created', resource_type: 'dnc_entry' });
      // @ts-expect-error — there is no api_key actor (decision #5).
      platformAuditLogger.log({ tenant_id: TENANT, actor_type: 'api_key', action: 'dnc_entry.created', resource_type: 'dnc_entry' });
    };
    expect(typeof compileOnly).toBe('function');
  });

  it("core's retention horizon reads the baseline's earliest range partition", async () => {
    resetAuditRetentionCache();
    expect(await getAuditRetentionHorizon()).toEqual({
      earliest_retained_at: '2026-01-01T00:00:00.000Z',
      source: 'partition_bound',
    });
  });
});
