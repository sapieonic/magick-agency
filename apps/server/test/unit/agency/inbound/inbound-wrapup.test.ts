// An answered inbound call's wrap-up (docs/inbound.md §6): when its owed outcome lapses
// (`inbound-wrapup.ts`, the matched campaign's auto-return rule, else the account default, never
// past the 30-minute backstop), what the panel's `outcome_due_at` says, and from which states a
// settled call returns its agent to the pool (`returnsToPool`, SWE-M1).
import { describe, expect, it } from 'vitest';
import { AGENCY_DEFAULT_DISPOSITION_CATALOG, AGENCY_INBOUND_OUTCOME_LAPSE_MS, type AgencyAgentState } from '@magick-agency/contracts/agency';
import {
  INBOUND_DEFAULT_WRAPUP,
  inboundOutcomeWindowMs,
  inboundWrapupRule,
} from '../../../../src/agency/inbound/inbound-wrapup.js';
import { inboundCallToWire } from '../../../../src/agency/inbound/inbound-call-wire.js';
import { returnsToPool } from '../../../../src/agency/inbound/inbound-disposition.js';
import type { AgencyInboundCallRecord } from '../../../../src/db/repositories/agency.repository.js';

describe('the inbound wrap-up rule', () => {
  it('a matched campaign that auto-returns: its own window', () => {
    expect(inboundOutcomeWindowMs(inboundWrapupRule({ wrapup_seconds: 45, wrapup_auto_return: true }))).toBe(45_000);
  });

  it('auto-return off, or no window (`wrapup_seconds = 0`, "no timer"): only the backstop', () => {
    expect(inboundOutcomeWindowMs(inboundWrapupRule({ wrapup_seconds: 45, wrapup_auto_return: false }))).toBe(AGENCY_INBOUND_OUTCOME_LAPSE_MS);
    expect(inboundOutcomeWindowMs(inboundWrapupRule({ wrapup_seconds: 0, wrapup_auto_return: true }))).toBe(AGENCY_INBOUND_OUTCOME_LAPSE_MS);
  });

  it('never past the backstop, whatever the campaign says', () => {
    expect(inboundOutcomeWindowMs(inboundWrapupRule({ wrapup_seconds: 3 * 3600, wrapup_auto_return: true }))).toBe(AGENCY_INBOUND_OUTCOME_LAPSE_MS);
    expect(inboundOutcomeWindowMs({ wrapupSeconds: 120, autoReturn: true }, 60_000)).toBe(60_000);
  });

  it('unmatched (or the campaign row gone): its own default, 120 s with auto-return (not a new campaign`s 30 s)', () => {
    expect(inboundWrapupRule(null)).toEqual({ wrapupSeconds: 120, autoReturn: true });
    expect(inboundWrapupRule(null)).toEqual(INBOUND_DEFAULT_WRAPUP);
    expect(inboundOutcomeWindowMs(inboundWrapupRule(null))).toBe(120_000);
  });

  it('a matched campaign keeps its own rule, whatever the unmatched default', () => {
    expect(inboundWrapupRule({ wrapup_seconds: 30, wrapup_auto_return: true })).toEqual({ wrapupSeconds: 30, autoReturn: true });
  });
});

describe('the panel`s outcome_due_at follows the window', () => {
  const ended = {
    id: 'call-1', session_id: 'sess-1', state: 'ended', outcome: 'answered', from_e164: '+441', to_e164: '+442',
    caller_dnc: false, sticky_user_id: null, sticky_reason: null, recording_requested: false,
    arrived_at: new Date('2026-11-09T11:59:00Z'), queued_at: new Date('2026-11-09T11:59:10Z'),
    offered_at: new Date('2026-11-09T11:59:40Z'), bridged_at: new Date('2026-11-09T11:59:42Z'), ended_at: new Date('2026-11-09T12:05:00Z'),
    talk_seconds: 318, settled_at: null, disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_on_behalf: false,
  } as unknown as AgencyInboundCallRecord;
  const ctx = { route: null, match: null, catalogSource: 'builtin' as const, catalog: [...AGENCY_DEFAULT_DISPOSITION_CATALOG], stickyCandidates: [] };

  it('the campaign`s window after the end; the backstop when the context names none', () => {
    expect(inboundCallToWire(ended, { ...ctx, outcomeWindowMs: 45_000 }, null).outcome_due_at).toBe('2026-11-09T12:05:45.000Z');
    expect(inboundCallToWire(ended, ctx, null).outcome_due_at).toBe('2026-11-09T12:35:00.000Z');
    expect(inboundCallToWire({ ...ended, settled_at: new Date() }, { ...ctx, outcomeWindowMs: 45_000 }, null).outcome_due_at).toBeNull();
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
