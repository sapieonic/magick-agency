import { describe, expect, it } from 'vitest';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, type AgencyDisposition } from '@magick-agency/contracts/agency';
import { inboundContactSettlement } from '../../../src/agency/inbound/inbound-settlement.js';
import { resolveDispositionDecision } from '../../../src/agency/disposition-policy.js';
import { campaignRequiredFor, resolveInboundCatalog, inboundCallToWire } from '../../../src/agency/inbound/inbound-call-wire.js';
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
  // docs/call-log.md §5 (CL4, CL12, CL20): an unknown caller's call filed under a campaign.
  it('filed under a campaign the caller is not on: that campaign`s catalog, shown `campaign`, stored `route`; the route`s own is not used', () => {
    expect(resolveInboundCatalog(false, null, { disposition_catalog: routeCatalog }, { campaign: { disposition_catalog: campaignCatalog } }))
      .toEqual({ catalog: campaignCatalog, source: 'campaign', stored: 'route' });
  });
  it('filed: an outcome that asks for a promise is left out (no contact to keep it on); with nothing left, or the campaign gone, the built-in', () => {
    const withPromise: AgencyDisposition[] = [
      { code: 'sale', label: 'Sale' },
      { code: 'will_pay', label: 'Will pay', requires_promise: true },
    ];
    expect(resolveInboundCatalog(false, null, null, { campaign: { disposition_catalog: withPromise } }).catalog).toEqual([{ code: 'sale', label: 'Sale' }]);
    for (const campaign of [{ disposition_catalog: [withPromise[1]!] }, { disposition_catalog: [] }, null]) {
      expect(resolveInboundCatalog(false, null, { disposition_catalog: routeCatalog }, { campaign }))
        .toEqual({ catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], source: 'campaign', stored: 'route' });
    }
  });
  it('a matched caller keeps every outcome of their campaign, promise included, whatever is passed as filed', () => {
    const withPromise: AgencyDisposition[] = [{ code: 'will_pay', label: 'Will pay', requires_promise: true }];
    expect(resolveInboundCatalog(true, { disposition_catalog: withPromise }, null, { campaign: { disposition_catalog: campaignCatalog } }))
      .toEqual({ catalog: withPromise, source: 'campaign', stored: 'campaign' });
  });
});

describe('campaignRequiredFor (CL19): the setting applies to calls that arrive once it is on', () => {
  const at = (iso: string) => ({ arrived_at: new Date(iso) });
  it('off: never', () => {
    expect(campaignRequiredFor(at('2026-11-22T10:00:00Z'), { on: false, since: null })).toBe(false);
  });
  it('on: a call that arrived at or after the switch, not one that arrived before it', () => {
    const since = new Date('2026-11-22T10:00:00Z');
    expect(campaignRequiredFor(at('2026-11-22T09:59:59.999Z'), { on: true, since })).toBe(false);
    expect(campaignRequiredFor(at('2026-11-22T10:00:00Z'), { on: true, since })).toBe(true);
    expect(campaignRequiredFor(at('2026-11-22T10:00:01Z'), { on: true, since })).toBe(true);
  });
  it('on with no instant recorded: every call', () => {
    expect(campaignRequiredFor(at('2020-01-01T00:00:00Z'), { on: true, since: null })).toBe(true);
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
    route: { id: 'r1', name: 'Main' }, match: null, campaign: null, requireCampaign: { on: false, since: null }, catalogSource: 'builtin' as const,
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
  it('the campaign it is filed under: named from the context; changeable only for an unknown caller at wrap-up; required by the setting', () => {
    const ended = { ...base, state: 'ended', outcome: 'answered', bridged_at: new Date('2026-11-09T11:59:42Z'), ended_at: new Date('2026-11-09T12:05:00Z') };
    const filed = { campaign_id: 'c-gen', campaign_name: 'General enquiries', source: 'route' as const };
    const on = { on: true, since: new Date('2026-11-09T00:00:00Z') };
    // An unknown caller at wrap-up, filed by the route.
    expect(inboundCallToWire({ ...ended, matched_campaign_id: null, campaign_id: 'c-gen' } as unknown as AgencyInboundCallRecord,
      { ...ctx, campaign: filed, requireCampaign: on }, 'u-owner'))
      .toMatchObject({ campaign: filed, campaign_changeable: true, campaign_required: true });
    // Still on the line: not yet.
    expect(inboundCallToWire({ ...base, matched_campaign_id: null, campaign_id: 'c-gen' } as unknown as AgencyInboundCallRecord,
      { ...ctx, campaign: filed }, 'u-owner')).toMatchObject({ campaign: filed, campaign_changeable: false, campaign_required: false });
    // A matched caller, and a settled call: fixed.
    expect(inboundCallToWire({ ...ended, matched_campaign_id: 'c-own', campaign_id: 'c-own' } as unknown as AgencyInboundCallRecord,
      { ...ctx, campaign: { campaign_id: 'c-own', campaign_name: 'Own', source: 'contact' } }, 'u-owner').campaign_changeable).toBe(false);
    expect(inboundCallToWire({ ...ended, matched_campaign_id: null, campaign_id: 'c-gen', settled_at: new Date() } as unknown as AgencyInboundCallRecord,
      { ...ctx, campaign: filed }, 'u-owner').campaign_changeable).toBe(false);
    // A context read before the call was moved never names the old campaign for the new one.
    expect(inboundCallToWire({ ...ended, matched_campaign_id: null, campaign_id: 'c-other' } as unknown as AgencyInboundCallRecord,
      { ...ctx, campaign: filed }, 'u-owner').campaign).toBeNull();
    // Under none, with the setting on: required, and nothing to show.
    expect(inboundCallToWire({ ...ended, matched_campaign_id: null, campaign_id: null } as unknown as AgencyInboundCallRecord,
      { ...ctx, requireCampaign: on }, 'u-owner')).toMatchObject({ campaign: null, campaign_changeable: true, campaign_required: true });
  });
  it('BE-13: an outcome\'s icon the contract does not list is dropped from the catalog the agent is sent; a known one is kept', () => {
    const catalog = [
      { code: 'paid', label: 'Paid', icon: 'rupee' },
      { code: 'odd', label: 'Odd', icon: 'unicorn' },
      { code: 'plain', label: 'Plain' },
    ] as unknown as AgencyDisposition[];
    const wire = inboundCallToWire(base, { ...ctx, catalog }, 'u-owner');
    expect(wire.disposition_catalog).toEqual([
      { code: 'paid', label: 'Paid', icon: 'rupee' },
      { code: 'odd', label: 'Odd' },
      { code: 'plain', label: 'Plain' },
    ]);
  });
  it('Mode B (IQ66): every offer this build makes is a station offer with no ring; none before an offer', () => {
    expect(inboundCallToWire(base, ctx, 'u-owner')).toMatchObject({ offer_channel: 'station', ring_expires_at: null, accepted_at: null });
    const queued = { ...base, state: 'queued', session_id: null, offered_at: null } as unknown as AgencyInboundCallRecord;
    expect(inboundCallToWire(queued, ctx, null)).toMatchObject({ offer_channel: null, ring_expires_at: null, accepted_at: null });
    // A station offer keeps its connect delay.
    expect(inboundCallToWire(base, ctx, 'u-owner', 1500).connects_at).toBe('2026-11-09T11:59:41.500Z');
  });
    it('the sticky reason of whichever candidate took it; another agent sees the sticky agent`s, not them', () => {
    expect(inboundCallToWire(base, ctx, 'u-last').sticky).toEqual({ reason: 'last_connected', is_you: true });
    expect(inboundCallToWire(base, ctx, 'u-team').sticky).toEqual({ reason: 'owner', is_you: false });
    expect(inboundCallToWire({ ...base, sticky_user_id: null, sticky_reason: null }, { ...ctx, stickyCandidates: [] }, 'u-team').sticky).toBeNull();
  });
  it('ended after a bridge with no outcome: owed until the route`s window ends (IQ52); once settled, nothing owed', () => {
    const ended = {
      ...base, state: 'ended', outcome: 'answered', bridged_at: new Date('2026-11-09T11:59:42Z'), ended_at: new Date('2026-11-09T12:05:00Z'),
      talk_seconds: 318, wrapup_seconds: 90,
    } as AgencyInboundCallRecord;
    expect(inboundCallToWire(ended, ctx, 'u-owner')).toMatchObject({
      connects_at: null, talk_seconds: 318, outcome_due_at: '2026-11-09T12:06:30.000Z',
    });
    // A call that captured no window: the default, 30 s.
    expect(inboundCallToWire({ ...ended, wrapup_seconds: null }, ctx, 'u-owner').outcome_due_at).toBe('2026-11-09T12:05:30.000Z');
    expect(inboundCallToWire({ ...ended, settled_at: new Date() }, ctx, 'u-owner').outcome_due_at).toBeNull();
  });
});
