import { describe, expect, it } from 'vitest';
import { AGENCY_WRAPUP_REDIAL_LIMIT } from '@magick-agency/contracts/agency';
import {
  redialRefusalForAttempt,
  wrapupRedialRemaining,
} from '../../../src/agency/wrapup-redial-rules.js';
import { redialRefusalForGate } from '../../../src/agency/wrapup-redial.js';

const on = { allow_wrapup_redial: true, status: 'running' as const };

function attempt(over: Partial<Parameters<typeof redialRefusalForAttempt>[0]> = {}) {
  return {
    reserved_agent_id: 'sess-1',
    state: 'ended' as const,
    disposition_code: null,
    bridged_at: new Date(),
    redial_number: 0,
    ...over,
  };
}

describe('wrapupRedialRemaining', () => {
  it('is null when the campaign does not allow it', () => {
    expect(wrapupRedialRemaining({ allow_wrapup_redial: false }, true, 0)).toBeNull();
  });
  it('is null when no outcome is owed (nobody is held to redial)', () => {
    expect(wrapupRedialRemaining({ allow_wrapup_redial: true }, false, 0)).toBeNull();
  });
  it('counts redials per ORIGINAL call: 2 after the call, 1 after the first redial, 0 after the second', () => {
    expect(AGENCY_WRAPUP_REDIAL_LIMIT).toBe(2);
    expect(wrapupRedialRemaining({ allow_wrapup_redial: true }, true, 0)).toBe(2);
    expect(wrapupRedialRemaining({ allow_wrapup_redial: true }, true, 1)).toBe(1);
    expect(wrapupRedialRemaining({ allow_wrapup_redial: true }, true, 2)).toBe(0);
    expect(wrapupRedialRemaining({ allow_wrapup_redial: true }, true, 5)).toBe(0);
  });
});

describe('redialRefusalForAttempt', () => {
  it('passes a connected, un-dispositioned call of this session on a running campaign that allows it', () => {
    expect(redialRefusalForAttempt(attempt(), on, 'sess-1')).toBeNull();
  });
  it('passes a redial that never connected (it owes the conversation\'s outcome)', () => {
    expect(redialRefusalForAttempt(attempt({ bridged_at: null, redial_number: 1 }), on, 'sess-1')).toBeNull();
  });
  it('refuses with the setting off', () => {
    expect(redialRefusalForAttempt(attempt(), { ...on, allow_wrapup_redial: false }, 'sess-1')?.code).toBe('redial_not_allowed');
  });
  it('refuses another session\'s call', () => {
    expect(redialRefusalForAttempt(attempt({ reserved_agent_id: 'sess-2' }), on, 'sess-1')?.code).toBe('redial_not_allowed');
  });
  it('refuses once an outcome is saved', () => {
    expect(redialRefusalForAttempt(attempt({ disposition_code: 'sale' }), on, 'sess-1')?.code).toBe('disposition_already_submitted');
  });
  it('refuses a paced dial that never connected', () => {
    expect(redialRefusalForAttempt(attempt({ bridged_at: null }), on, 'sess-1')?.code).toBe('redial_not_allowed');
  });
  it('refuses a live attempt', () => {
    expect(redialRefusalForAttempt(attempt({ state: 'bridged' }), on, 'sess-1')?.code).toBe('redial_not_allowed');
  });
  it('refuses the 3rd redial: the 2nd redial\'s wrap-up has none left', () => {
    expect(redialRefusalForAttempt(attempt({ redial_number: 1 }), on, 'sess-1')).toBeNull();
    expect(redialRefusalForAttempt(attempt({ redial_number: 2 }), on, 'sess-1')?.code).toBe('redial_limit_reached');
  });
  it('refuses on a campaign that is not running', () => {
    expect(redialRefusalForAttempt(attempt(), { ...on, status: 'paused' as never }, 'sess-1')?.code).toBe('redial_not_allowed');
  });
});

describe('redialRefusalForGate', () => {
  it('maps every gate decision to a named refusal', () => {
    expect(redialRefusalForGate({ action: 'dial', clearance: {} as never })).toBeNull();
    expect(redialRefusalForGate({ action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' })?.code).toBe('redial_blocked_dnc');
    expect(redialRefusalForGate({ action: 'suppress', gate: 'phone_invalid', suppressedReason: 'invalid' })?.code).toBe('redial_blocked');
    expect(redialRefusalForGate({ action: 'defer', gate: 'calling_hours', deferUntil: new Date() })?.code).toBe('redial_blocked_calling_hours');
    expect(redialRefusalForGate({ action: 'defer', gate: 'calling_hours_unresolvable', deferUntil: new Date() })?.code).toBe('redial_blocked_calling_hours');
    expect(redialRefusalForGate({ action: 'halt', gate: 'dnc_unavailable' })?.code).toBe('redial_blocked');
  });
});
