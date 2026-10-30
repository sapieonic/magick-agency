import { describe, it, expect, vi } from 'vitest';
import { manualEndReasonFor } from '../../../../src/agency/softphone/manual-dialer.js';
import { DncRegistry } from '../../../../src/agency/dnc-registry.js';

describe('manualEndReasonFor — why a manual call ended', () => {
  it('a hang-up names who asked for it', () => {
    expect(manualEndReasonFor('connected', 'agent_hangup', 'agent')).toBe('agent_hangup');
    expect(manualEndReasonFor('canceled', 'agent_hangup', 'supervisor')).toBe('supervisor_released');
  });

  it('otherwise follows the classified outcome', () => {
    expect(manualEndReasonFor('connected', 'browser_hangup', null)).toBe('remote_hangup');
    expect(manualEndReasonFor('connected', 'max_duration_reached', null)).toBe('completed');
    expect(manualEndReasonFor('connected', 'service_shutdown', null)).toBe('completed');
    expect(manualEndReasonFor('no_answer', null, null)).toBe('no_answer');
    expect(manualEndReasonFor('busy', null, null)).toBe('busy');
    expect(manualEndReasonFor('invalid', null, null)).toBe('invalid');
    expect(manualEndReasonFor('agent_disconnected', null, null)).toBe('agent_disconnected');
    expect(manualEndReasonFor('orphaned', null, null)).toBe('orphaned');
    expect(manualEndReasonFor('canceled', 'ended_by_user', null)).toBe('agent_hangup');
    expect(manualEndReasonFor('failed', null, null)).toBe('failed');
    expect(manualEndReasonFor('abandoned', null, null)).toBe('failed');
    expect(manualEndReasonFor('machine', null, null)).toBe('failed');
  });
});

describe('DncRegistry.checkEntry — the entry behind a suppression (SP1)', () => {
  const row = (over: Record<string, unknown>) => ({
    id: 'e1', tenant_id: 't1', account_id: null, campaign_id: null, phone_e164: '+919811100001',
    source: 'agent', reason: 'asked', added_by: null, created_at: new Date('2026-10-01T00:00:00Z'), ...over,
  });

  it('answers the entry with its scope label, on the normalised number and the full scope', async () => {
    const findMatchingEntry = vi.fn().mockResolvedValue(row({ campaign_id: 'c1' }));
    const r = await new DncRegistry({ findSuppressed: vi.fn(), findMatchingEntry } as never)
      .checkEntry('t1', '+91 98111 00001', { accountId: 'a1', campaignId: 'c1' });
    expect(r).toEqual({ result: 'suppressed', entry: { id: 'e1', scope: 'campaign', reason: 'asked', created_at: new Date('2026-10-01T00:00:00Z') } });
    expect(findMatchingEntry).toHaveBeenCalledWith({ tenantId: 't1', accountId: 'a1', campaignId: 'c1' }, '+919811100001');
    const account = await new DncRegistry({ findSuppressed: vi.fn(), findMatchingEntry: vi.fn().mockResolvedValue(row({ account_id: 'a1' })) } as never)
      .checkEntry('t1', '+919811100001', { accountId: 'a1', campaignId: null });
    expect(account.result === 'suppressed' && account.entry.scope).toBe('account');
    const tenant = await new DncRegistry({ findSuppressed: vi.fn(), findMatchingEntry: vi.fn().mockResolvedValue(row({})) } as never)
      .checkEntry('t1', '+919811100001', { accountId: null, campaignId: null });
    expect(tenant.result === 'suppressed' && tenant.entry.scope).toBe('tenant');
  });

  it('clear when nothing matches; unverifiable for a non-E.164 number', async () => {
    const reg = new DncRegistry({ findSuppressed: vi.fn(), findMatchingEntry: vi.fn().mockResolvedValue(null) } as never);
    expect(await reg.checkEntry('t1', '+919811100001', { accountId: null, campaignId: null })).toEqual({ result: 'clear' });
    expect(await reg.checkEntry('t1', 'not a number', { accountId: null, campaignId: null })).toEqual({ result: 'unverifiable' });
  });

  it('FAILS CLOSED: a read that throws, or a registry with no entry lookup, is unavailable', async () => {
    const throwing = new DncRegistry({ findSuppressed: vi.fn(), findMatchingEntry: vi.fn().mockRejectedValue(new Error('pool down')) } as never);
    expect(await throwing.checkEntry('t1', '+919811100001', { accountId: null, campaignId: null })).toEqual({ result: 'unavailable' });
    const bare = new DncRegistry({ findSuppressed: vi.fn() });
    expect(await bare.checkEntry('t1', '+919811100001', { accountId: null, campaignId: null })).toEqual({ result: 'unavailable' });
  });
});
