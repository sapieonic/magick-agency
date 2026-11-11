// The caller identification's ranking (docs/inbound.md §4.1, IB2), pure over the repository's
// rows: which roster contact is matched and which agents are sticky candidates, with why.
import { describe, expect, it } from 'vitest';
import { rankInboundCaller } from '../../../../src/agency/inbound/identify-caller.js';
import type { InboundCallSignalRow, InboundContactCandidateRow } from '../../../../src/db/repositories/agency.repository.js';

const RUNG = '+14155550101';
const OTHER = '+14155550199';
const NOW = new Date('2026-11-09T12:00:00Z');
const SINCE = new Date(NOW.getTime() - 30 * 86_400_000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function contact(o: Partial<InboundContactCandidateRow> = {}): InboundContactCandidateRow {
  return {
    contact_id: 'c-1', campaign_id: 'k-1', account_id: 'a-1', contact_state: 'pending', suppressed_reason: null,
    assigned_user_id: null, contact_created_at: daysAgo(90), campaign_status: 'running', inbound_sticky_enabled: true,
    account_may_use: true, last_attempt_at: null, last_attempt_caller_id: null, ...o,
  };
}

function call(o: Partial<InboundCallSignalRow> = {}): InboundCallSignalRow {
  return {
    channel: 'campaign', call_id: 'x-1', account_id: 'a-1', campaign_id: 'k-1', contact_id: 'c-1', agent_user_id: 'u-1',
    caller_id: OTHER, connected: false, at: daysAgo(1), sticky_enabled: true, ...o,
  };
}

const rank = (contacts: InboundContactCandidateRow[], calls: InboundCallSignalRow[] = []) =>
  rankInboundCaller({ contacts, calls, numberRungE164: RUNG, since: SINCE });

describe('the match', () => {
  it('nobody: no roster row', () => {
    expect(rank([])).toEqual({ match: null, candidates: [] });
  });

  it('a roster row whose account may not use the number rung is not the caller', () => {
    expect(rank([contact({ account_may_use: false })]).match).toBeNull();
  });

  it('a row on a live campaign matches whatever its age; one on a finished campaign only if called inside the lookback', () => {
    expect(rank([contact({ campaign_status: 'paused' })]).match?.contactId).toBe('c-1');
    expect(rank([contact({ campaign_status: 'completed' })]).match).toBeNull();
    expect(rank([contact({ campaign_status: 'completed', last_attempt_at: daysAgo(31) })]).match).toBeNull();
    expect(rank([contact({ campaign_status: 'stopped', last_attempt_at: daysAgo(29) })]).match?.contactId).toBe('c-1');
  });

  it('prefers the contact whose latest call went out from the number rung, then the most recent', () => {
    const recent = contact({ contact_id: 'c-recent', last_attempt_at: daysAgo(1), last_attempt_caller_id: OTHER });
    const fromRung = contact({ contact_id: 'c-rung', last_attempt_at: daysAgo(5), last_attempt_caller_id: RUNG });
    expect(rank([recent, fromRung]).match?.contactId).toBe('c-rung');
    const older = contact({ contact_id: 'c-older', contact_created_at: daysAgo(40) });
    const newer = contact({ contact_id: 'c-newer', contact_created_at: daysAgo(10) });
    expect(rank([older, newer]).match?.contactId).toBe('c-newer');
    // A full tie is broken by id, so the match never depends on row order.
    const a = contact({ contact_id: 'c-a' });
    const b = contact({ contact_id: 'c-b' });
    expect(rank([b, a]).match?.contactId).toBe('c-a');
  });

  it('carries what the follow-up needs', () => {
    expect(rank([contact({ contact_state: 'exhausted', assigned_user_id: 'u-9', suppressed_reason: null })]).match).toEqual({
      contactId: 'c-1', campaignId: 'k-1', accountId: 'a-1', contactState: 'exhausted', campaignStatus: 'running',
      suppressedReason: null, assignedUserId: 'u-9',
    });
  });
});

describe('the sticky candidates (signals 1–3)', () => {
  it('ranks owner, then the last call from the number rung, then the last connected call', () => {
    const { candidates } = rank([contact({ assigned_user_id: 'u-owner' })], [
      call({ call_id: 'x-conn', agent_user_id: 'u-conn', connected: true, at: daysAgo(3) }),
      call({ call_id: 'x-rung', agent_user_id: 'u-rung', caller_id: RUNG, at: daysAgo(4) }),
    ]);
    expect(candidates.map((c) => [c.userId, c.reason])).toEqual([
      ['u-owner', 'owner'], ['u-rung', 'last_from_number'], ['u-conn', 'last_connected'],
    ]);
  });

  it('takes the LATEST call for each signal, soft-phone calls included', () => {
    const { candidates } = rank([], [
      call({ call_id: 'x-old', agent_user_id: 'u-old', caller_id: RUNG, connected: true, at: daysAgo(9) }),
      call({ channel: 'softphone', call_id: 'm-new', agent_user_id: 'u-new', caller_id: RUNG, connected: true, at: daysAgo(2), contact_id: null }),
    ]);
    expect(candidates.map((c) => [c.userId, c.reason])).toEqual([['u-new', 'last_from_number']]);
  });

  it('one entry per agent, at their best rank', () => {
    const { candidates } = rank([contact({ assigned_user_id: 'u-1' })], [call({ agent_user_id: 'u-1', caller_id: RUNG, connected: true })]);
    expect(candidates).toEqual([{ userId: 'u-1', reason: 'owner', accountId: 'a-1', at: null }]);
  });

  it('ignores calls outside the lookback and campaigns that opted out (inbound_sticky_enabled)', () => {
    expect(rank([], [call({ caller_id: RUNG, at: daysAgo(31) })]).candidates).toEqual([]);
    expect(rank([contact({ assigned_user_id: 'u-owner', inbound_sticky_enabled: false })], [
      call({ caller_id: RUNG, sticky_enabled: false }),
    ]).candidates).toEqual([]);
  });

  it('no owner signal without a match', () => {
    expect(rank([contact({ assigned_user_id: 'u-owner', account_may_use: false })]).candidates).toEqual([]);
  });

  it('IQ49: an answered inbound call is a last_connected signal, the latest connected call in either direction', () => {
    const inbound = (o: Partial<InboundCallSignalRow> = {}) => call({
      channel: 'inbound', caller_id: null, connected: true, campaign_id: null, contact_id: null, ...o,
    });
    // An unmatched caller nobody dialled: the agent who took their last call is theirs.
    expect(rank([], [inbound({ call_id: 'i-1', agent_user_id: 'u-took', at: daysAgo(2) })]).candidates)
      .toEqual([{ userId: 'u-took', reason: 'last_connected', accountId: 'a-1', at: daysAgo(2) }]);
    // Newer than the last outbound conversation: the inbound call's agent.
    expect(rank([], [
      call({ call_id: 'x-out', agent_user_id: 'u-out', connected: true, at: daysAgo(5) }),
      inbound({ call_id: 'i-in', agent_user_id: 'u-in', at: daysAgo(1) }),
    ]).candidates.map((c) => [c.userId, c.reason])).toEqual([['u-in', 'last_connected']]);
    // Older: the outbound one's.
    expect(rank([], [
      call({ call_id: 'x-out', agent_user_id: 'u-out', connected: true, at: daysAgo(1) }),
      inbound({ call_id: 'i-in', agent_user_id: 'u-in', at: daysAgo(5) }),
    ]).candidates.map((c) => [c.userId, c.reason])).toEqual([['u-out', 'last_connected']]);
    // Never a last_from_number (it went out from nobody's number), whatever the number rung.
    expect(rank([], [inbound({ agent_user_id: 'u-in' })]).candidates.map((c) => c.reason)).toEqual(['last_connected']);
    // Outside the lookback, or its matched campaign opted out: nobody.
    expect(rank([], [inbound({ at: daysAgo(31) })]).candidates).toEqual([]);
    expect(rank([], [inbound({ sticky_enabled: false })]).candidates).toEqual([]);
  });
});
