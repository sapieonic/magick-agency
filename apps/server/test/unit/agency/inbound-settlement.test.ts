import { describe, expect, it } from 'vitest';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, type AgencyDisposition } from '@magick-agency/contracts/agency';
import { inboundContactSettlement } from '../../../src/agency/inbound/inbound-settlement.js';
import { resolveDispositionDecision } from '../../../src/agency/disposition-policy.js';
import { resolveInboundCatalog, inboundCallToWire } from '../../../src/agency/inbound/inbound-call-wire.js';
import { unconnectedOutcome } from '../../../src/agency/inbound/inbound-connector.js';
import type { AgencyInboundCallRecord } from '../../../src/db/repositories/agency.repository.js';

/**
 * An answered inbound call's outcome (docs/inbound.md §6): what it asks of the matched contact
 * (SP6 forward only, never charged; the table in `inbound-settlement.ts`), the catalog it is
 * saved against (IQ10), the panel row, and how a call nobody took ends.
 */

const NOW = new Date('2026-11-09T12:00:00Z');
const AT = new Date('2026-11-10T09:00:00Z');

function settle(entry: AgencyDisposition, callbackAt: Date | null = null) {
  const decision = resolveDispositionDecision(entry, { now: NOW, attemptsUsed: 0, callbackAt });
  return inboundContactSettlement(entry, decision, decision.nextAttemptAt);
}

describe('inboundContactSettlement (the decision table)', () => {
  it('suppress → suppressed (dnc), whatever else the code says', () => {
    expect(settle({ code: 'dnc', label: 'DNC', suppress: true, terminal: true, is_success: true })).toEqual({ kind: 'suppressed', reason: 'dnc' });
  });
  it('terminal → completed', () => {
    expect(settle({ code: 'not_interested', label: 'No', terminal: true })).toEqual({ kind: 'completed' });
  });
  it('a success code → completed (IQ9)', () => {
    expect(settle({ code: 'sale', label: 'Sale', is_success: true })).toEqual({ kind: 'completed' });
  });
  it('a callback with its time → callback at it', () => {
    expect(settle({ code: 'callback', label: 'Call back', requires_datetime: true }, AT)).toEqual({ kind: 'callback', at: AT });
  });
  it('a retry code or a plain label → nothing: the customer rang us, so nothing is rescheduled', () => {
    expect(settle({ code: 'voicemail', label: 'VM', retry: { delay_minutes: 60, max_attempts: 3 } })).toEqual({ kind: 'none' });
    expect(settle({ code: 'note', label: 'Note' })).toEqual({ kind: 'none' });
  });
  it('every built-in code maps to one arm', () => {
    for (const entry of AGENCY_DEFAULT_DISPOSITION_CATALOG as readonly AgencyDisposition[]) {
      const kind = settle(entry, entry.requires_datetime ? AT : null).kind;
      expect(['suppressed', 'completed', 'callback', 'none']).toContain(kind);
    }
  });
});

describe('resolveInboundCatalog (IQ10)', () => {
  const campaignCatalog: AgencyDisposition[] = [{ code: 'sale', label: 'Sale' }];
  const routeCatalog: AgencyDisposition[] = [{ code: 'enquiry', label: 'Enquiry' }];
  it('a matched call: the campaign`s catalog (whatever its status), stored `campaign`', () => {
    expect(resolveInboundCatalog(true, { disposition_catalog: campaignCatalog }, { disposition_catalog: routeCatalog }))
      .toEqual({ catalog: campaignCatalog, source: 'campaign', stored: 'campaign' });
  });
  it('a matched call whose campaign has no catalog (or is gone): the built-in, still `campaign`', () => {
    expect(resolveInboundCatalog(true, { disposition_catalog: [] }, null)).toMatchObject({ source: 'campaign', stored: 'campaign' });
    expect(resolveInboundCatalog(true, null, null).catalog).toEqual([...AGENCY_DEFAULT_DISPOSITION_CATALOG]);
  });
  it('unmatched: the route`s, else the built-in (`builtin`, stored `route`)', () => {
    expect(resolveInboundCatalog(false, null, { disposition_catalog: routeCatalog })).toEqual({ catalog: routeCatalog, source: 'route', stored: 'route' });
    expect(resolveInboundCatalog(false, null, { disposition_catalog: [] })).toMatchObject({ source: 'builtin', stored: 'route' });
    expect(resolveInboundCatalog(false, null, null)).toMatchObject({ source: 'builtin', stored: 'route' });
  });
});

describe('unconnectedOutcome: a call nobody took', () => {
  it('our shutdown and a stream that never opened are failed (IQ18); the parked backstop is overflow; else the caller hung up', () => {
    expect(unconnectedOutcome('service_shutdown')).toBe('failed');
    expect(unconnectedOutcome('inbound_media_timeout')).toBe('failed');
    expect(unconnectedOutcome('max_duration_reached')).toBe('overflow');
    expect(unconnectedOutcome('pstn_stream_closed')).toBe('abandoned_in_queue');
    expect(unconnectedOutcome('remote_hangup')).toBe('abandoned_in_queue');
    expect(unconnectedOutcome(undefined)).toBe('abandoned_in_queue');
  });
});

describe('inboundCallToWire', () => {
  const base = {
    id: 'call-1', session_id: 'sess-1', state: 'offered', outcome: null, from_e164: '+441', to_e164: '+442',
    caller_dnc: false, sticky_user_id: 'u-owner', sticky_reason: 'owner', recording_requested: true,
    arrived_at: new Date('2026-11-09T11:59:00Z'), queued_at: new Date('2026-11-09T11:59:10Z'),
    offered_at: new Date('2026-11-09T11:59:40Z'), bridged_at: null, ended_at: null, talk_seconds: null,
    settled_at: null, disposition_code: null, notes: null, callback_at: null, dispositioned_by_user_id: null,
    dispositioned_on_behalf: false,
  } as unknown as AgencyInboundCallRecord;
  const ctx = {
    route: { id: 'r1', name: 'Main' }, match: null, catalogSource: 'builtin' as const,
    catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG],
    stickyCandidates: [{ userId: 'u-owner', reason: 'owner' as const }, { userId: 'u-last', reason: 'last_connected' as const }],
  };
  it('offered: connects_at the connect delay after the offer, the wait from the first queueing', () => {
    const wire = inboundCallToWire(base, ctx, 'u-owner', 1500);
    expect(wire).toMatchObject({
      state: 'offered', connects_at: '2026-11-09T11:59:41.500Z', waited_seconds: 30, recording: true,
      sticky: { reason: 'owner', is_you: true }, outcome_due_at: null, talk_seconds: null,
    });
  });
  it('the sticky reason of whichever candidate took it; another agent sees the sticky agent`s, not them', () => {
    expect(inboundCallToWire(base, ctx, 'u-last').sticky).toEqual({ reason: 'last_connected', is_you: true });
    expect(inboundCallToWire(base, ctx, 'u-team').sticky).toEqual({ reason: 'owner', is_you: false });
    expect(inboundCallToWire({ ...base, sticky_user_id: null, sticky_reason: null }, { ...ctx, stickyCandidates: [] }, 'u-team').sticky).toBeNull();
  });
  it('ended after a bridge with no outcome: owed until the lapse; once settled, nothing owed', () => {
    const ended = { ...base, state: 'ended', outcome: 'answered', bridged_at: new Date('2026-11-09T11:59:42Z'), ended_at: new Date('2026-11-09T12:05:00Z'), talk_seconds: 318 } as AgencyInboundCallRecord;
    expect(inboundCallToWire(ended, ctx, 'u-owner')).toMatchObject({
      connects_at: null, talk_seconds: 318, outcome_due_at: '2026-11-09T12:35:00.000Z',
    });
    expect(inboundCallToWire({ ...ended, settled_at: new Date() }, ctx, 'u-owner').outcome_due_at).toBeNull();
  });
});
