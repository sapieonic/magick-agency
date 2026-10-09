import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

// Tenant/account labels are wrapped in `uuidFor` (UUID columns); the logger mock
// targets `@magick-agency/observability`. Event types and payloads are opaque audit data.

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { auditRepository: typedAuditRepository } = await import('../../../src/repositories/audit.repository.js');

// Tests are typechecked by lint. The repository types its reads as the camelCase
// `AuditRecord` while Postgres returns snake_case rows (`audit.model.ts` documents
// exactly this), so these assertions read the rows untyped.
type Untyped<F extends (...a: never[]) => unknown> = (...a: Parameters<F>) => Promise<any[]>;
const auditRepository = typedAuditRepository as unknown as Omit<typeof typedAuditRepository, 'findByCallId' | 'findByTenant'> & {
  findByCallId: Untyped<typeof typedAuditRepository.findByCallId>;
  findByTenant: Untyped<typeof typedAuditRepository.findByTenant>;
};

describe('Audit logging scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── Batch insert ──────────────────────────────────────────────────────

  describe('batch insert', () => {
    it('inserts a batch of audit events', async () => {
      await auditRepository.insertBatch([
        {
          tenantId: uuidFor('audit-t'),
          accountId: uuidFor('audit-a'),
          eventType: 'api.call.requested',
          eventCategory: 'api',
          severity: 'info',
          eventData: { externalRefId: 'ext-1' },
          requestId: 'req-001',
          actor: 'mgkv_testkey',
          ipAddress: '10.0.0.1',
        },
        {
          tenantId: uuidFor('audit-t'),
          accountId: uuidFor('audit-a'),
          eventType: 'call.initiated',
          eventCategory: 'call',
          severity: 'info',
          eventData: { provider: 'twilio', callId: 'call-1' },
        },
        {
          tenantId: uuidFor('audit-t'),
          accountId: uuidFor('audit-a'),
          eventType: 'call.completed',
          eventCategory: 'call',
          severity: 'info',
          eventData: { duration: 120, outcome: 'promise_to_pay' },
          durationMs: 120000,
        },
      ]);

      const events = await auditRepository.findByTenant(uuidFor('audit-t'), uuidFor('audit-a'));
      expect(events).toHaveLength(3);
    });

    it('handles empty batch gracefully', async () => {
      await auditRepository.insertBatch([]);
      // Should not throw
      const events = await auditRepository.findByTenant(uuidFor('audit-t'), uuidFor('audit-a'));
      expect(events).toHaveLength(0);
    });

    it('stores all event fields correctly', async () => {
      const callId = randomUUID();
      await auditRepository.insertBatch([
        {
          callId,
          tenantId: uuidFor('fields-t'),
          accountId: uuidFor('fields-a'),
          eventType: 'api.call.rejected',
          eventCategory: 'api',
          severity: 'warn',
          eventData: { reason: 'validation_failed', errors: ['phone invalid'] },
          requestId: 'req-abc',
          actor: 'mgkv_key123',
          ipAddress: '192.168.1.1',
          durationMs: 42,
        },
      ]);

      const events = await auditRepository.findByCallId(callId);
      expect(events).toHaveLength(1);

      const evt = events[0]!;
      expect(evt.call_id).toBe(callId);
      expect(evt.tenant_id).toBe(uuidFor('fields-t'));
      expect(evt.account_id).toBe(uuidFor('fields-a'));
      expect(evt.event_type).toBe('api.call.rejected');
      expect(evt.event_category).toBe('api');
      expect(evt.severity).toBe('warn');
      expect(evt.event_data.reason).toBe('validation_failed');
      expect(evt.request_id).toBe('req-abc');
      expect(evt.actor).toBe('mgkv_key123');
      expect(evt.ip_address).toBe('192.168.1.1');
      expect(evt.duration_ms).toBe(42);
    });
  });

  // ── findByCallId ──────────────────────────────────────────────────────

  describe('findByCallId', () => {
    it('returns events for a specific call ordered by timestamp DESC', async () => {
      const callId = randomUUID();

      await auditRepository.insertBatch([
        { callId, tenantId: uuidFor('t'), accountId: uuidFor('a'), eventType: 'call.initiated', eventCategory: 'call', severity: 'info', eventData: { step: 1 } },
        { callId, tenantId: uuidFor('t'), accountId: uuidFor('a'), eventType: 'call.answered', eventCategory: 'call', severity: 'info', eventData: { step: 2 } },
        { callId, tenantId: uuidFor('t'), accountId: uuidFor('a'), eventType: 'call.completed', eventCategory: 'call', severity: 'info', eventData: { step: 3 } },
      ]);

      // Another call's events should not appear
      await auditRepository.insertBatch([
        { callId: randomUUID(), tenantId: uuidFor('t'), accountId: uuidFor('a'), eventType: 'call.initiated', eventCategory: 'call', severity: 'info', eventData: {} },
      ]);

      const events = await auditRepository.findByCallId(callId);
      expect(events).toHaveLength(3);
    });

    it('returns empty for non-existent call', async () => {
      const events = await auditRepository.findByCallId(randomUUID());
      expect(events).toEqual([]);
    });

    it('respects limit parameter', async () => {
      const callId = randomUUID();
      for (let i = 0; i < 10; i++) {
        await auditRepository.insertBatch([
          { callId, tenantId: uuidFor('t'), accountId: uuidFor('a'), eventType: `event.${i}`, eventCategory: 'call', severity: 'info', eventData: {} },
        ]);
      }

      const events = await auditRepository.findByCallId(callId, 5);
      expect(events).toHaveLength(5);
    });
  });

  // ── findByTenant ──────────────────────────────────────────────────────

  describe('findByTenant', () => {
    it('returns events for a tenant ordered by timestamp DESC', async () => {
      await auditRepository.insertBatch([
        { tenantId: uuidFor('tenant-A'), accountId: uuidFor('acc-A'), eventType: 'a1', eventCategory: 'api', severity: 'info', eventData: {} },
        { tenantId: uuidFor('tenant-A'), accountId: uuidFor('acc-A'), eventType: 'a2', eventCategory: 'api', severity: 'info', eventData: {} },
        { tenantId: uuidFor('tenant-B'), accountId: uuidFor('acc-B'), eventType: 'b1', eventCategory: 'api', severity: 'info', eventData: {} },
      ]);

      const eventsA = await auditRepository.findByTenant(uuidFor('tenant-A'), uuidFor('acc-A'));
      expect(eventsA).toHaveLength(2);
      expect(eventsA.every(e => e.tenant_id === uuidFor('tenant-A'))).toBe(true);
    });

    it('filters by account when provided', async () => {
      await auditRepository.insertBatch([
        { tenantId: uuidFor('shared-t'), accountId: uuidFor('acc-X'), eventType: 'x1', eventCategory: 'api', severity: 'info', eventData: {} },
        { tenantId: uuidFor('shared-t'), accountId: uuidFor('acc-Y'), eventType: 'y1', eventCategory: 'api', severity: 'info', eventData: {} },
      ]);

      const eventsX = await auditRepository.findByTenant(uuidFor('shared-t'), uuidFor('acc-X'));
      expect(eventsX).toHaveLength(1);
      expect(eventsX[0]!.account_id).toBe(uuidFor('acc-X'));
    });

    it('returns all accounts when accountId not provided', async () => {
      await auditRepository.insertBatch([
        { tenantId: uuidFor('all-t'), accountId: uuidFor('acc-X'), eventType: 'x1', eventCategory: 'api', severity: 'info', eventData: {} },
        { tenantId: uuidFor('all-t'), accountId: uuidFor('acc-Y'), eventType: 'y1', eventCategory: 'api', severity: 'info', eventData: {} },
      ]);

      const events = await auditRepository.findByTenant(uuidFor('all-t'));
      expect(events).toHaveLength(2);
    });

    it('handles pagination', async () => {
      for (let i = 0; i < 10; i++) {
        await auditRepository.insertBatch([
          { tenantId: uuidFor('page-t'), accountId: uuidFor('page-a'), eventType: `evt-${i}`, eventCategory: 'api', severity: 'info', eventData: {} },
        ]);
      }

      const page1 = await auditRepository.findByTenant(uuidFor('page-t'), uuidFor('page-a'), 3, 0);
      const page2 = await auditRepository.findByTenant(uuidFor('page-t'), uuidFor('page-a'), 3, 3);

      expect(page1).toHaveLength(3);
      expect(page2).toHaveLength(3);
    });
  });

  // ── Complex event data ────────────────────────────────────────────────

  describe('complex event data', () => {
    it('stores nested JSONB event data', async () => {
      await auditRepository.insertBatch([
        {
          tenantId: uuidFor('json-t'),
          accountId: uuidFor('json-a'),
          eventType: 'call.analysis.completed',
          eventCategory: 'analysis' as never, // the dialer's value; not in `EventCategory` (type-only cast)
          severity: 'info',
          eventData: {
            model: 'gpt-4o-mini',
            duration_ms: 1200,
            result: {
              sentiment: { label: 'positive', score: 0.85 },
              topics: ['payment', 'commitment', 'scheduling'],
              custom: { payment_intent: true, promised_amount: 5000 },
            },
          },
        },
      ]);

      const events = await auditRepository.findByTenant(uuidFor('json-t'), uuidFor('json-a'));
      expect(events).toHaveLength(1);
      expect(events[0]!.event_data.result.sentiment.score).toBe(0.85);
      expect(events[0]!.event_data.result.topics).toContain('payment');
    });

    it('stores events with null optional fields', async () => {
      await auditRepository.insertBatch([
        {
          tenantId: uuidFor('null-t'),
          accountId: uuidFor('null-a'),
          eventType: 'system.health_check',
          eventCategory: 'system',
          severity: 'info',
          eventData: { status: 'ok' },
          // callId, requestId, actor, ipAddress, durationMs all absent
        },
      ]);

      const events = await auditRepository.findByTenant(uuidFor('null-t'), uuidFor('null-a'));
      expect(events).toHaveLength(1);
      expect(events[0]!.call_id).toBeNull();
      expect(events[0]!.request_id).toBeNull();
      expect(events[0]!.actor).toBeNull();
    });
  });

  // ── High-volume batch ─────────────────────────────────────────────────

  describe('high-volume batch', () => {
    it('inserts 100 events in a single batch', async () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        tenantId: uuidFor('vol-t'),
        accountId: uuidFor('vol-a'),
        eventType: `event.${i}`,
        eventCategory: 'api' as const,
        severity: 'info' as const,
        eventData: { index: i },
      }));

      await auditRepository.insertBatch(events);

      const found = await auditRepository.findByTenant(uuidFor('vol-t'), uuidFor('vol-a'), 200, 0);
      expect(found).toHaveLength(100);
    });
  });

  // ── Severity levels ───────────────────────────────────────────────────

  describe('severity levels', () => {
    it('stores all severity levels', async () => {
      await auditRepository.insertBatch([
        { tenantId: uuidFor('sev-t'), accountId: uuidFor('sev-a'), eventType: 'debug.event', eventCategory: 'system', severity: 'debug', eventData: {} },
        { tenantId: uuidFor('sev-t'), accountId: uuidFor('sev-a'), eventType: 'info.event', eventCategory: 'system', severity: 'info', eventData: {} },
        { tenantId: uuidFor('sev-t'), accountId: uuidFor('sev-a'), eventType: 'warn.event', eventCategory: 'system', severity: 'warn', eventData: {} },
        { tenantId: uuidFor('sev-t'), accountId: uuidFor('sev-a'), eventType: 'error.event', eventCategory: 'system', severity: 'error', eventData: {} },
      ]);

      const events = await auditRepository.findByTenant(uuidFor('sev-t'), uuidFor('sev-a'));
      expect(events).toHaveLength(4);
      const severities = events.map(e => e.severity).sort();
      expect(severities).toEqual(['debug', 'error', 'info', 'warn']);
    });
  });
});
