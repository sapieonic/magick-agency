import { describe, expect, it } from 'vitest';
import type { AgencyAgentState } from '@magick-agency/contracts/agency';
import {
  RELEASE_STATES,
  callerForReleasedAgent,
  candidatesFor,
  inStickyPhase,
  inboundIneligibility,
  searchOrder,
  stickyAgentStatus,
  type InboundAgentView,
  type InboundCallerView,
} from '../../../src/agency/inbound/eligibility.js';

/**
 * Who may take a waiting inbound caller (docs/inbound.md §4.3, §5.1): every row of the §4.3
 * table, the sticky modes, and the order agents and callers are served in.
 */

const T = 'tenant-1';
const A = 'account-1';
const NOW = 1_000_000;

function agent(id: string, over: Partial<InboundAgentView> & { state?: AgencyAgentState; since?: number } = {}): InboundAgentView {
  const { state = 'available', since = NOW - 10_000, ...rest } = over;
  return {
    sessionId: `s-${id}`,
    agentUserId: `u-${id}`,
    tenantId: T,
    accountId: A,
    campaignId: 'camp-1',
    clientKind: 'web',
    stationOpen: true,
    live: { state, since, manualCallId: null, softphone: false, inboundCallId: null },
    ...rest,
  };
}

function caller(id: string, over: Partial<InboundCallerView> = {}): InboundCallerView {
  return {
    callId: `c-${id}`,
    tenantId: T,
    accountId: A,
    routeAccountId: A,
    poolCampaignIds: [],
    stickyMode: 'loose',
    stickyUserId: null,
    stickyWaitMs: 30_000,
    queuedAt: NOW - 1_000,
    ...over,
  };
}

describe('inboundIneligibility (§4.3)', () => {
  const c = caller('1');
  it('an available console campaign agent of the call`s account may take it', () => {
    expect(inboundIneligibility(agent('a'), c)).toBeNull();
  });
  it.each([
    ['another account', agent('a', { accountId: 'account-2' }), 'other_account'],
    ['another tenant', agent('a', { tenantId: 'tenant-2' }), 'other_account'],
    ['a soft-phone session', agent('a', { campaignId: null }), 'not_campaign_session'],
    ['the mobile app (Q20)', agent('a', { clientKind: 'mobile' }), 'mobile'],
    ['no open station here', agent('a', { stationOpen: false }), 'no_station'],
    ['no lease (offline, lapsed)', { ...agent('a'), live: null }, 'wrong_state'],
    ['offline', agent('a', { state: 'offline' }), 'wrong_state'],
    ['on a break (soft_phone and device_away are breaks too)', agent('a', { state: 'break' }), 'wrong_state'],
    ['reserved', agent('a', { state: 'reserved' }), 'wrong_state'],
    ['on a call', agent('a', { state: 'on_call' }), 'wrong_state'],
    ['in wrap-up', agent('a', { state: 'wrapup' }), 'wrong_state'],
  ] as const)('%s: refused (%s)', (_what, a, why) => {
    expect(inboundIneligibility(a, c)).toBe(why);
  });
  it('a session holding a soft-phone call, a soft-phone session, or another inbound call: holds_call', () => {
    const base = agent('a');
    expect(inboundIneligibility({ ...base, live: { ...base.live!, manualCallId: 'm' } }, c)).toBe('holds_call');
    expect(inboundIneligibility({ ...base, live: { ...base.live!, softphone: true } }, c)).toBe('holds_call');
    expect(inboundIneligibility({ ...base, live: { ...base.live!, inboundCallId: 'x' } }, c)).toBe('holds_call');
  });
  it('the route`s pool applies only when the call is in the route`s account (Q21)', () => {
    const pooled = caller('1', { poolCampaignIds: ['camp-2'] });
    expect(inboundIneligibility(agent('a'), pooled)).toBe('not_in_pool');
    expect(inboundIneligibility(agent('a', { campaignId: 'camp-2' }), pooled)).toBeNull();
    // A caller matched into another account: that account's whole floor, whatever the route's pool.
    expect(inboundIneligibility(agent('a'), { ...pooled, routeAccountId: 'account-9' })).toBeNull();
  });
  it('the release hook asks it of an agent still reserved, on a call or in wrap-up', () => {
    for (const state of RELEASE_STATES) expect(inboundIneligibility(agent('a', { state }), c, RELEASE_STATES)).toBeNull();
    expect(inboundIneligibility(agent('a', { state: 'available' }), c, RELEASE_STATES)).toBe('wrong_state');
    expect(inboundIneligibility(agent('a', { state: 'break' }), c, RELEASE_STATES)).toBe('wrong_state');
  });
});

describe('the sticky agent`s status and phase (§4.2, §4.3, Q6)', () => {
  const c = caller('1', { stickyUserId: 'u-s' });
  it('available, busy (reserved / on a call / wrap-up, even holding another inbound call), else away', () => {
    expect(stickyAgentStatus(agent('s'), c)).toBe('available');
    for (const state of RELEASE_STATES) expect(stickyAgentStatus(agent('s', { state }), c)).toBe('busy');
    const onInbound = agent('s', { state: 'on_call' });
    expect(stickyAgentStatus({ ...onInbound, live: { ...onInbound.live!, inboundCallId: 'other' } }, c)).toBe('busy');
    expect(stickyAgentStatus(undefined, c)).toBe('away');
    expect(stickyAgentStatus(agent('s', { state: 'break' }), c)).toBe('away');
    expect(stickyAgentStatus(agent('s', { state: 'offline' }), c)).toBe('away');
    expect(stickyAgentStatus(agent('s', { clientKind: 'mobile' }), c)).toBe('away');
    expect(stickyAgentStatus(agent('s', { accountId: 'account-2' }), c)).toBe('away');
    expect(stickyAgentStatus(agent('s', { campaignId: null, state: 'break' }), c)).toBe('away');
    const onSoftphone = agent('s', { state: 'on_call' });
    expect(stickyAgentStatus({ ...onSoftphone, live: { ...onSoftphone.live!, manualCallId: 'm' } }, c)).toBe('away');
  });
  it('loose: only the sticky agent until the sticky wait; strict: until the maximum wait; off: never; away: never (Q6)', () => {
    expect(inStickyPhase(c, 'available', NOW)).toBe(true);
    expect(inStickyPhase(c, 'busy', c.queuedAt + 29_999)).toBe(true);
    expect(inStickyPhase(c, 'busy', c.queuedAt + 30_000)).toBe(false);
    const strict = { ...c, stickyMode: 'strict' as const };
    expect(inStickyPhase(strict, 'busy', c.queuedAt + 10 * 60_000)).toBe(true);
    expect(inStickyPhase(strict, 'away', NOW)).toBe(false);
    expect(inStickyPhase({ ...c, stickyMode: 'off' }, 'available', NOW)).toBe(false);
    expect(inStickyPhase({ ...c, stickyUserId: null }, 'available', NOW)).toBe(false);
  });
});

describe('candidatesFor: who to try, in order', () => {
  const floor = [
    agent('young', { since: NOW - 1_000 }),
    agent('old', { since: NOW - 60_000 }),
    agent('tie-b', { since: NOW - 30_000 }),
    agent('tie-a', { since: NOW - 30_000 }),
    agent('busy', { state: 'on_call' }),
  ];
  it('the team longest idle first, ties on the session id (planTick`s rule); busy agents left out', () => {
    expect(candidatesFor(caller('1'), floor, NOW)).toEqual(['s-old', 's-tie-a', 's-tie-b', 's-young']);
  });
  it('in the sticky phase: the sticky agent only, and nobody while they are busy', () => {
    expect(candidatesFor(caller('1', { stickyUserId: 'u-young' }), floor, NOW)).toEqual(['s-young']);
    expect(candidatesFor(caller('1', { stickyUserId: 'u-busy' }), floor, NOW)).toEqual([]);
  });
  it('after a loose sticky wait: the sticky agent still first when free, then the team', () => {
    const lapsed = caller('1', { stickyUserId: 'u-young', queuedAt: NOW - 31_000 });
    expect(candidatesFor(lapsed, floor, NOW)).toEqual(['s-young', 's-old', 's-tie-a', 's-tie-b']);
    expect(candidatesFor({ ...lapsed, stickyUserId: 'u-busy' }, floor, NOW)).toEqual(['s-old', 's-tie-a', 's-tie-b', 's-young']);
  });
  it('a sticky agent away: the team at once, under strict too (Q6)', () => {
    const awayFloor = [...floor, agent('gone', { state: 'break' })];
    expect(candidatesFor(caller('1', { stickyUserId: 'u-gone', stickyMode: 'strict' }), awayFloor, NOW))
      .toEqual(['s-old', 's-tie-a', 's-tie-b', 's-young']);
    expect(candidatesFor(caller('1', { stickyUserId: 'u-nobody', stickyMode: 'strict' }), floor, NOW))
      .toEqual(['s-old', 's-tie-a', 's-tie-b', 's-young']);
  });
  it('sticky off: the sticky agent is just one of the team', () => {
    expect(candidatesFor(caller('1', { stickyUserId: 'u-young', stickyMode: 'off' }), floor, NOW))
      .toEqual(['s-old', 's-tie-a', 's-tie-b', 's-young']);
  });
});

describe('searchOrder: callers FIFO, each sticky caller matched to their free agent first', () => {
  it('a later caller sticky to a free agent is matched to them before an earlier team caller', () => {
    const floor = [agent('a', { since: NOW - 60_000 }), agent('b', { since: NOW - 5_000 })];
    const first = caller('1');
    const second = caller('2', { stickyUserId: 'u-a', queuedAt: NOW - 500, stickyMode: 'loose' });
    const steps = searchOrder([first, second], floor, NOW);
    expect(steps[0]).toEqual({ callId: 'c-2', candidates: ['s-a'] });
    expect(steps.slice(1)).toEqual([
      { callId: 'c-1', candidates: ['s-a', 's-b'] },
      { callId: 'c-2', candidates: ['s-a'] },
    ]);
  });
});

describe('callerForReleasedAgent: the release hook`s choice', () => {
  const me = agent('me', { state: 'wrapup' });
  it('a caller sticky to them before an earlier team caller', () => {
    const callers = [caller('1'), caller('2', { stickyUserId: 'u-me' })];
    expect(callerForReleasedAgent(me, callers, [me], NOW)).toBe('c-2');
  });
  it('else the first team caller they may take', () => {
    expect(callerForReleasedAgent(me, [caller('1'), caller('2')], [me], NOW)).toBe('c-1');
  });
  it('skips a caller in another agent`s sticky phase, takes them once it lapses (loose) or the agent is away', () => {
    const other = agent('other', { state: 'on_call' });
    const theirs = caller('1', { stickyUserId: 'u-other' });
    expect(callerForReleasedAgent(me, [theirs], [me, other], NOW)).toBeNull();
    expect(callerForReleasedAgent(me, [{ ...theirs, queuedAt: NOW - 31_000 }], [me, other], NOW)).toBe('c-1');
    expect(callerForReleasedAgent(me, [{ ...theirs, stickyMode: 'strict' }], [me, other], NOW)).toBeNull();
    expect(callerForReleasedAgent(me, [{ ...theirs, stickyMode: 'strict' }], [me, agent('other', { state: 'break' })], NOW)).toBe('c-1');
  });
  it('nothing outside their reach: another account, a pool they are not on, the mobile app', () => {
    expect(callerForReleasedAgent(me, [caller('1', { accountId: 'account-2', routeAccountId: 'account-2' })], [me], NOW)).toBeNull();
    expect(callerForReleasedAgent(me, [caller('1', { poolCampaignIds: ['camp-9'] })], [me], NOW)).toBeNull();
    const phone = agent('me', { state: 'wrapup', clientKind: 'mobile' });
    expect(callerForReleasedAgent(phone, [caller('1')], [phone], NOW)).toBeNull();
  });
});
