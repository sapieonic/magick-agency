import { describe, it, expect, vi } from 'vitest';
import { manualDialFailureFor, manualEndReasonFor } from '../../../../src/agency/softphone/manual-dialer.js';
import { WebRtcCallError } from '../../../../src/core/webrtc-bridge-manager.js';
import { softphoneRefusalMessage } from '../../../../src/agency/softphone/types.js';
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

describe('manualDialFailureFor — what a dial the bridge refused before the carrier answers the agent', () => {
  const refused = (code: string, status = 409) => new WebRtcCallError('refused', code as never, status);

  it('a calls-per-second limit is a busy line: retryable in a moment (PL7)', () => {
    expect(manualDialFailureFor(refused('carrier_rate_limited', 503))).toBe('concurrency_limit');
    expect(manualDialFailureFor(refused('account_concurrency_limit', 429))).toBe('concurrency_limit');
  });

  it('a carrier account that cannot dial is its own, non-retryable answer (PL2, PL3)', () => {
    expect(manualDialFailureFor(refused('telephony_credential_unavailable'))).toBe('carrier_account_unavailable');
    expect(manualDialFailureFor(refused('carrier_auth_rejected', 502))).toBe('carrier_account_unavailable');
  });

  it('a missing station is the station; anything else is the platform\'s dial_failed', () => {
    expect(manualDialFailureFor(refused('station_socket_unavailable'))).toBe('station_unavailable');
    expect(manualDialFailureFor(refused('something_new'))).toBe('dial_failed');
    expect(manualDialFailureFor(new TypeError('Invalid URL'))).toBe('dial_failed');
  });

  it('the carrier-account refusal says support, never "try again", and names no vendor', () => {
    const message = softphoneRefusalMessage({ code: 'carrier_account_unavailable' });
    expect(message).toMatch(/Contact support/);
    expect(message).not.toMatch(/try again|plivo|voicelink/i);
  });
});
