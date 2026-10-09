import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

// PORT NOTE (magick-agency): ported from core
// test/integration/repositories/audit.repository.test.ts@4850d1d9. Changes:
// tenant/account labels are wrapped in `uuidFor` (UUID columns); the logger mock
// targets `@magick-agency/observability`. `event_data.campaign_id` values stay
// core's strings (JSONB, not a UUID column).

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Mock the logger imported by audit.repository
vi.mock('@magick-agency/observability', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Must import AFTER vi.mock
const { auditRepository: typedAuditRepository } = await import('../../../src/repositories/audit.repository.js');

// PORT NOTE (magick-agency): core type-checks no test file; agency's lint does.
// These assertions read rows as `Record<string, unknown>` (snake_case, as
// Postgres returns them), so the reads are typed that way here — the runtime is
// core's exactly.
type Rows<F extends (...a: never[]) => unknown> = (...a: Parameters<F>) => Promise<Record<string, unknown>[]>;
const auditRepository = typedAuditRepository as unknown as Omit<typeof typedAuditRepository, 'findByCallId' | 'findByTenant' | 'findFiltered'> & {
  findByCallId: Rows<typeof typedAuditRepository.findByCallId>;
  findByTenant: Rows<typeof typedAuditRepository.findByTenant>;
  findFiltered: (...a: Parameters<typeof typedAuditRepository.findFiltered>) => Promise<{ rows: Record<string, unknown>[]; total: number | null }>;
};

// NOTE: The audit repository accepts camelCase AuditEvent input but
// the pg driver returns snake_case column names from the DB.
// So AuditRecord rows have snake_case fields: event_type, tenant_id, etc.

describe('auditRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('insertBatch', () => {
    it('inserts multiple audit events in a single batch', async () => {
      const tenantId = uuidFor('tenant-audit-1');
      const callId = randomUUID();

      await auditRepository.insertBatch([
        {
          callId,
          tenantId,
          accountId: uuidFor('account-1'),
          eventType: 'call.started',
          eventCategory: 'call',
          severity: 'info',
          eventData: { phone: '+919876543210' },
        },
        {
          callId,
          tenantId,
          accountId: uuidFor('account-1'),
          eventType: 'call.completed',
          eventCategory: 'call',
          severity: 'info',
          eventData: { duration: 120 },
        },
      ]);

      const records = await auditRepository.findByCallId(callId);
      expect(records).toHaveLength(2);
      // pg returns snake_case column names
      const types = records.map((r: Record<string, unknown>) => r['event_type']);
      expect(types).toContain('call.started');
      expect(types).toContain('call.completed');
    });

    it('does nothing when passed an empty array', async () => {
      await expect(auditRepository.insertBatch([])).resolves.toBeUndefined();
    });

    it('stores JSONB event_data correctly', async () => {
      const tenantId = uuidFor('tenant-jsonb');
      const callId = randomUUID();

      await auditRepository.insertBatch([
        {
          callId,
          tenantId,
          accountId: uuidFor('account-1'),
          eventType: 'ai.response',
          eventCategory: 'ai',
          severity: 'debug',
          eventData: { tokens: 250, latency_ms: 1500, model: 'gpt-4o-mini' },
        },
      ]);

      const records = await auditRepository.findByCallId(callId);
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['event_data']).toEqual({ tokens: 250, latency_ms: 1500, model: 'gpt-4o-mini' });
    });

    it('accepts events without optional fields', async () => {
      const tenantId = uuidFor('tenant-minimal');

      await auditRepository.insertBatch([
        {
          tenantId,
          accountId: uuidFor('account-1'),
          eventType: 'system.startup',
          eventCategory: 'system',
          severity: 'info',
          eventData: {},
        },
      ]);

      const records = await auditRepository.findByTenant(tenantId, uuidFor('account-1'));
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['event_type']).toBe('system.startup');
    });
  });

  describe('findByCallId', () => {
    it('returns audit records for a specific call', async () => {
      const callId1 = randomUUID();
      const callId2 = randomUUID();

      await auditRepository.insertBatch([
        {
          callId: callId1,
          tenantId: uuidFor('tenant-1'),
          accountId: uuidFor('account-1'),
          eventType: 'call.queued',
          eventCategory: 'call',
          severity: 'info',
          eventData: {},
        },
        {
          callId: callId2,
          tenantId: uuidFor('tenant-1'),
          accountId: uuidFor('account-1'),
          eventType: 'call.queued',
          eventCategory: 'call',
          severity: 'info',
          eventData: {},
        },
      ]);

      const records = await auditRepository.findByCallId(callId1);
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['call_id']).toBe(callId1);
    });

    it('returns empty array for non-existent call id', async () => {
      const records = await auditRepository.findByCallId(randomUUID());
      expect(records).toHaveLength(0);
    });

    it('respects the limit parameter', async () => {
      const callId = randomUUID();
      const events = Array.from({ length: 5 }, (_, i) => ({
        callId,
        tenantId: uuidFor('tenant-limit'),
        accountId: uuidFor('account-1'),
        eventType: `event.${i}`,
        eventCategory: 'call' as const,
        severity: 'info' as const,
        eventData: { index: i },
      }));

      await auditRepository.insertBatch(events);

      const records = await auditRepository.findByCallId(callId, 3);
      expect(records).toHaveLength(3);
    });
  });

  describe('findByTenant', () => {
    it('returns records for a specific tenant', async () => {
      await auditRepository.insertBatch([
        {
          tenantId: uuidFor('tenant-A'),
          accountId: uuidFor('account-A'),
          eventType: 'api.request',
          eventCategory: 'api',
          severity: 'info',
          eventData: { path: '/api/v1/calls' },
        },
        {
          tenantId: uuidFor('tenant-A'),
          accountId: uuidFor('account-A'),
          eventType: 'api.response',
          eventCategory: 'api',
          severity: 'info',
          eventData: { status: 200 },
        },
        {
          tenantId: uuidFor('tenant-B'),
          accountId: uuidFor('account-B'),
          eventType: 'api.request',
          eventCategory: 'api',
          severity: 'info',
          eventData: {},
        },
      ]);

      const records = await auditRepository.findByTenant(uuidFor('tenant-A'));
      expect(records).toHaveLength(2);
      expect(records.every((r: Record<string, unknown>) => r['tenant_id'] === uuidFor('tenant-A'))).toBe(true);
    });

    it('filters by accountId when provided', async () => {
      await auditRepository.insertBatch([
        {
          tenantId: uuidFor('tenant-multi'),
          accountId: uuidFor('account-1'),
          eventType: 'call.started',
          eventCategory: 'call',
          severity: 'info',
          eventData: {},
        },
        {
          tenantId: uuidFor('tenant-multi'),
          accountId: uuidFor('account-2'),
          eventType: 'call.started',
          eventCategory: 'call',
          severity: 'info',
          eventData: {},
        },
      ]);

      const records = await auditRepository.findByTenant(uuidFor('tenant-multi'), uuidFor('account-1'));
      expect(records).toHaveLength(1);
      const record = records[0] as Record<string, unknown>;
      expect(record['account_id']).toBe(uuidFor('account-1'));
    });

    it('returns empty array for non-existent tenant', async () => {
      const records = await auditRepository.findByTenant(uuidFor('no-such-tenant'));
      expect(records).toHaveLength(0);
    });
  });

  describe('findFiltered', () => {
    it('returns the agency auto-pause row for a campaign, not a sibling campaign', async () => {
      const tenantId = uuidFor('tenant-agency');
      const accountId = uuidFor('account-agency');

      await auditRepository.insertBatch([
        {
          tenantId,
          accountId,
          eventType: 'agency_campaign.auto_paused',
          eventCategory: 'call',
          severity: 'error',
          actor: 'system:abandonment-guardrail',
          eventData: { campaign_id: 'camp-target', reason: 'abandonment_ceiling', measured_pct: 5, ceiling_pct: 3 },
        },
        {
          tenantId,
          accountId,
          eventType: 'agency_campaign.created',
          eventCategory: 'call',
          severity: 'info',
          actor: 'system:api',
          eventData: { campaign_id: 'camp-other', name: 'other' },
        },
        {
          tenantId,
          accountId: uuidFor('account-other'),
          eventType: 'agency_campaign.auto_paused',
          eventCategory: 'call',
          severity: 'error',
          actor: 'system:abandonment-guardrail',
          eventData: { campaign_id: 'camp-target', reason: 'abandonment_ceiling', measured_pct: 9, ceiling_pct: 3 },
        },
      ]);

      const { rows, total } = await auditRepository.findFiltered({
        tenantId,
        accountId,
        campaignId: 'camp-target',
      });

      expect(total).toBe(1);
      expect(rows).toHaveLength(1);
      const record = rows[0] as Record<string, unknown>;
      expect(record['event_type']).toBe('agency_campaign.auto_paused');
      expect(record['actor']).toBe('system:abandonment-guardrail');
      expect(record['event_data']).toEqual({
        campaign_id: 'camp-target',
        reason: 'abandonment_ceiling',
        measured_pct: 5,
        ceiling_pct: 3,
      });
    });

    it('filters by event type, from/to, and does not treat an empty result as success of a missing filter', async () => {
      const tenantId = uuidFor('tenant-range');
      const accountId = uuidFor('account-range');
      const campaignId = 'camp-range';

      await auditRepository.insertBatch([
        {
          tenantId,
          accountId,
          eventType: 'agency_campaign.created',
          eventCategory: 'call',
          severity: 'info',
          actor: 'system:api',
          eventData: { campaign_id: campaignId, name: 'range' },
        },
        {
          tenantId,
          accountId,
          eventType: 'agency_campaign.stopped',
          eventCategory: 'call',
          severity: 'info',
          actor: 'system:pacing-leader',
          eventData: { campaign_id: campaignId, from: 'stopping', to: 'stopped' },
        },
      ]);

      const createdOnly = await auditRepository.findFiltered({
        tenantId,
        accountId,
        campaignId,
        eventTypes: ['agency_campaign.stopped'],
      });
      expect(createdOnly.total).toBe(1);
      expect((createdOnly.rows[0] as Record<string, unknown>)['event_type']).toBe('agency_campaign.stopped');
      expect((createdOnly.rows[0] as Record<string, unknown>)['actor']).toBe('system:pacing-leader');

      const future = await auditRepository.findFiltered({
        tenantId,
        accountId,
        campaignId,
        from: new Date(Date.now() + 60_000),
      });
      expect(future.total).toBe(0);
      expect(future.rows).toEqual([]);
    });
  });
});
