// An answered inbound call's wrap-up (docs/inbound.md §6, IQ52): when its owed outcome lapses
// (`inbound-wrapup.ts`, the route's window captured on the call, else the default, never past the
// 30-minute backstop), what the panel's `outcome_due_at` says, and from which states a settled call
// returns its agent to the pool (`returnsToPool`, SWE-M1).
import { describe, expect, it } from 'vitest';
import {
  AGENCY_DEFAULT_DISPOSITION_CATALOG,
  AGENCY_INBOUND_OUTCOME_LAPSE_MS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  type AgencyAgentState,
} from '@magick-agency/contracts/agency';
import {
  INBOUND_DEFAULT_WRAPUP_SECONDS,
  inboundOutcomeWindowMs,
} from '../../../../src/agency/inbound/inbound-wrapup.js';
import { inboundCallToWire } from '../../../../src/agency/inbound/inbound-call-wire.js';
import { returnsToPool } from '../../../../src/agency/inbound/inbound-disposition.js';
import type { AgencyInboundCallRecord } from '../../../../src/db/repositories/agency.repository.js';

describe('the inbound wrap-up rule (IQ52: the route\'s window, captured on the call)', () => {
  it('the captured window, always with auto-return', () => {
    expect(inboundOutcomeWindowMs({ wrapup_seconds: 45 })).toBe(45_000);
    expect(inboundOutcomeWindowMs({ wrapup_seconds: 600 })).toBe(600_000);
  });

  it('a call that captured none: the route default, 30 s (not the old unmatched 120 s)', () => {
    expect(INBOUND_DEFAULT_WRAPUP_SECONDS).toBe(AGENCY_INBOUND_ROUTE_DEFAULTS.wrapup_seconds);
    expect(INBOUND_DEFAULT_WRAPUP_SECONDS).toBe(30);
    expect(inboundOutcomeWindowMs({ wrapup_seconds: null })).toBe(30_000);
  });

  it('never past the backstop', () => {
    expect(inboundOutcomeWindowMs({ wrapup_seconds: 3 * 3600 })).toBe(AGENCY_INBOUND_OUTCOME_LAPSE_MS);
    expect(inboundOutcomeWindowMs({ wrapup_seconds: 120 }, 60_000)).toBe(60_000);
  });
});

describe('the panel`s outcome_due_at follows the window', () => {
  const ended = {
    id: 'call-1', session_id: 'sess-1', state: 'ended', outcome: 'answered', from_e164: '+441', to_e164: '+442',
    caller_dnc: false, sticky_user_id: null, sticky_reason: null, recording_requested: false,
    arrived_at: new Date('2026-11-09T11:59:00Z'), queued_at: new Date('2026-11-09T11:59:10Z'),
    offered_at: new Date('2026-11-09T11:59:40Z'), bridged_at: new Date('2026-11-09T11:59:42Z'), ended_at: new Date('2026-11-09T12:05:00Z'),
    talk_seconds: 318, settled_at: null, disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_on_behalf: false, wrapup_seconds: 45,
  } as unknown as AgencyInboundCallRecord;
  const ctx = { route: null, match: null, catalogSource: 'builtin' as const, catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], stickyCandidates: [] };

  it('the call`s captured window after the end; the default when it has none; nothing once settled', () => {
    expect(inboundCallToWire(ended, ctx, null).outcome_due_at).toBe('2026-11-09T12:05:45.000Z');
    expect(inboundCallToWire({ ...ended, wrapup_seconds: null }, ctx, null).outcome_due_at).toBe('2026-11-09T12:05:30.000Z');
    expect(inboundCallToWire({ ...ended, settled_at: new Date() }, ctx, null).outcome_due_at).toBeNull();
  });
});

describe('returnsToPool: a settled inbound call returns its agent only from the state it holds them in (SWE-M1)', () => {
  const live = (state: AgencyAgentState, inboundCallId: string | null) => ({ state, inboundCallId });

  it('the call`s own wrap-up, offer or call: returned', () => {
    expect(returnsToPool(live('wrapup', 'call-1'), 'call-1')).toBe(true);
    expect(returnsToPool(live('reserved', 'call-1'), 'call-1')).toBe(true);
    expect(returnsToPool(live('on_call', 'call-1'), 'call-1')).toBe(true);
  });

  it('a break (chosen, or the restart`s with the call re-claimed), offline, available: never moved', () => {
    expect(returnsToPool(live('break', 'call-1'), 'call-1')).toBe(false);
    expect(returnsToPool(live('break', null), 'call-1')).toBe(false);
    expect(returnsToPool(live('offline', 'call-1'), 'call-1')).toBe(false);
    expect(returnsToPool(live('available', null), 'call-1')).toBe(false);
  });

  it('a state another call or a campaign wrap-up holds, or no lease at all: never moved', () => {
    expect(returnsToPool(live('wrapup', null), 'call-1')).toBe(false);
    expect(returnsToPool(live('wrapup', 'call-2'), 'call-1')).toBe(false);
    expect(returnsToPool(live('on_call', null), 'call-1')).toBe(false);
    expect(returnsToPool(live('reserved', 'call-2'), 'call-1')).toBe(false);
    expect(returnsToPool(null, 'call-1')).toBe(false);
  });
});
