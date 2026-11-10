import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The in-flight clash, the dialer's half (docs/inbound.md §5.4, IQ7, IQ8): a ringing paced dial
// whose customer rings in is found, cancelled and settled as the clash (`canceled`, the system
// code `inbound_call`, the contact back uncharged, released `inbound_call`), and its agent
// released through the inbound hook; a dial the carrier answered first is kept as a call. The
// bridge is a double whose `forceEndWithOutcome` emits what a carrier would; the end-to-end
// path is `test/integration/telephony/inbound-clash-voicemail-e2e.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } } },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
      recordDisposition: vi.fn().mockResolvedValue(null),
      closeLapsedWrapup: vi.fn().mockResolvedValue(null),
      endSupersededByInbound: vi.fn(),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      parkForWriteUp: vi.fn().mockResolvedValue(true),
      chargeAttempt: vi.fn().mockResolvedValue(1),
      requeueOrphaned: vi.fn().mockResolvedValue({ state: 'pending', our_fault_attempts: 1 }),
    },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyCampaignRepository: {},
  agencyAgentSessionRepository: repos.session,
}));

import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

function fakeWs() {
  return {
    readyState: 1, OPEN: 1, sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() {}, off() {}, close() { this.readyState = 3; },
  };
}

/** A bridge whose cancel ends the call as the carrier would; `beforeEnd` lets a test land an answer first. */
function fakeBridge(opts: { beforeEnd?: Array<Record<string, unknown>>; found?: boolean } = {}) {
  const listeners: Array<(e: any) => void> = [];
  const bridge = {
    listeners,
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => {}; },
    createBridgedCall: vi.fn(async () => ({ id: 'call-1' }) as any),
    emit(ev: any) { for (const l of listeners) l(ev); },
    forceEndWithOutcome: vi.fn(async (correlationId: string, outcome: string) => {
      if (opts.found === false) return false;
      for (const ev of opts.beforeEnd ?? []) bridge.emit({ callId: 'call-1', correlationId, ...ev });
      const answered = (opts.beforeEnd ?? []).length > 0;
      bridge.emit({
        callId: 'call-1', correlationId, phase: 'ended', status: answered ? 'completed' : 'canceled', outcome, answered,
        ...(answered ? { talkTimeSeconds: 0 } : {}),
      });
      return true;
    }),
  };
  return bridge;
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1', telephony_provider: 'plivo', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'], disposition_catalog: [{ code: 'sale', label: 'Sale' }],
} as any;
const CONTACT = { id: 'contact-1', phone_e164: '+919876543210', context: {}, attempt_count: 2 } as any;

function makeCmd(campaign: any = CAMPAIGN, extra: Partial<DialCommand> = {}): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1', sessionId: 's1', ownerReplica: 'r1',
    tenantId: 't1', accountId: 'a1', callerId: '+14155550100', attemptNumber: 3, campaign, contact: CONTACT, ...extra,
  };
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false), stateFor: vi.fn(() => null),
    noteDisposition: vi.fn(async () => false), stop: vi.fn(), active: vi.fn(() => 0),
    endRedialSetup: vi.fn(), redialBeingSetUp: vi.fn(() => false), setRedialRemaining: vi.fn(),
  };
}
function fakeBreaks(queued: any = null) {
  return { queue: vi.fn(), peek: vi.fn(() => queued), take: vi.fn(() => queued), cancel: vi.fn(), size: vi.fn(() => 0) };
}

async function ringing(bridge: ReturnType<typeof fakeBridge>, opts: { campaign?: any; breaks?: any; cmd?: Partial<DialCommand> } = {}) {
  const stations = new StationRegistry(null, '', 'r1');
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  vi.spyOn(agents, 'set').mockResolvedValue('ok');
  const wrapup = fakeWrapup();
  const dialer = new AgencyDialer(bridge as any, stations, agents, wrapup as any, (opts.breaks ?? fakeBreaks()) as any);
  dialer.start();
  const ws = fakeWs();
  await stations.attach({ sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'user-1', ws: ws as any });
  const hook = vi.fn(async () => true);
  dialer.registerInboundTake(hook);
  await dialer.executeDial(makeCmd(opts.campaign, opts.cmd));
  return { dialer, ws, hook, wrapup, agents };
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.attempt.endSupersededByInbound.mockResolvedValue({ attempt: { id: 'att-1' }, contactReturned: true });
});

describe('findRingingAttemptTo', () => {
  it('finds the ringing dial to the same number on the account, digits compared; says whether its carrier can cancel it (IQ7)', async () => {
    const { dialer } = await ringing(fakeBridge());
    expect(dialer.findRingingAttemptTo('t1', 'a1', '+919876543210')).toEqual({ attemptId: 'att-1', sessionId: 's1', cancelsRinging: true });
    expect(dialer.findRingingAttemptTo('t1', 'a1', '+91 98765 43210')?.attemptId).toBe('att-1');
    expect(dialer.findRingingAttemptTo('t1', 'a1', '+919876543211')).toBeNull();
    expect(dialer.findRingingAttemptTo('t1', 'a2', '+919876543210')).toBeNull();
    expect(dialer.findRingingAttemptTo('t2', 'a1', '+919876543210')).toBeNull();
    expect(dialer.findRingingAttemptTo('t1', 'a1', '')).toBeNull();

    const voicelink = await ringing(fakeBridge(), { campaign: { ...CAMPAIGN, telephony_provider: 'voicelink' } });
    expect(voicelink.dialer.findRingingAttemptTo('t1', 'a1', '+919876543210')?.cancelsRinging).toBe(false);
  });

  it('never an answered dial (a conversation) or a wrap-up redial (an outcome owed first)', async () => {
    const bridge = fakeBridge();
    const { dialer } = await ringing(bridge);
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    expect(dialer.findRingingAttemptTo('t1', 'a1', '+919876543210')).toBeNull();
    expect(dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled: vi.fn() })).toBe(false);

    const redial = await ringing(fakeBridge(), { cmd: { redial: { ofAttemptId: 'att-0', number: 1 } } });
    expect(redial.dialer.findRingingAttemptTo('t1', 'a1', '+919876543210')).toBeNull();
  });
});

describe('supersedeForInbound', () => {
  it('cancels the dial at once and settles it as the clash: canceled + inbound_call, contact back uncharged, released inbound_call, the agent to the inbound hook, no wrap-up', async () => {
    const bridge = fakeBridge();
    const { dialer, ws, hook, wrapup } = await ringing(bridge);
    const settled = vi.fn();
    // The cancel is called synchronously, before the call returns (no answer can land between).
    expect(dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled })).toBe(true);
    expect(bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'canceled');
    await vi.waitFor(() => expect(settled).toHaveBeenCalled());

    expect(settled).toHaveBeenCalledWith(true);
    expect(repos.attempt.endSupersededByInbound).toHaveBeenCalledWith({ attemptId: 'att-1', contactId: 'contact-1', code: 'inbound_call', talkSeconds: null });
    // Nothing of the ordinary settle: no `ended` row write through the policy, no charge, no unclaim with a delay.
    expect(repos.attempt.setState.mock.calls.filter((c: any) => c[1] === 'ended')).toEqual([]);
    expect(repos.contact.chargeAttempt).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(wrapup.enter).not.toHaveBeenCalled();
    const released = ws.sent.filter((f) => f.event === 'released');
    expect(released).toEqual([expect.objectContaining({ attempt_id: 'att-1', reason: 'inbound_call', requires_disposition: false })]);
    // Released through the hook, which took the agent: nothing written to `available`.
    expect(hook).toHaveBeenCalledWith('s1');
    expect(ws.sent.some((f) => f.event === 'agent_state' && f.state === 'available')).toBe(false);
    // The settle ran after the release (the hook had its chance first).
    expect(hook.mock.invocationCallOrder[0]!).toBeLessThan(settled.mock.invocationCallOrder[0]!);
    expect(dialer.findRingingAttemptTo('t1', 'a1', '+919876543210')).toBeNull();
  });

  it('a queued break wins: the hook is not asked, and the hand-over is dropped by the settle', async () => {
    const bridge = fakeBridge();
    const { dialer, hook } = await ringing(bridge, { breaks: fakeBreaks({ code: 'lunch' }) });
    const settled = vi.fn();
    dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled });
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(true));
    expect(hook).not.toHaveBeenCalled();
  });

  it('the bridged-first race: the carrier answered before the cancel landed — kept as a call (connected, the policy\'s settle), the hand-over dropped, never the clash', async () => {
    const bridge = fakeBridge({
      beforeEnd: [{ phase: 'answered', answered: true }, { phase: 'bridged', answered: true }],
    });
    const { dialer, ws } = await ringing(bridge);
    const settled = vi.fn();
    dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled });
    await vi.waitFor(() => expect(repos.attempt.setState.mock.calls.some((c: any) => c[1] === 'ended')).toBe(true));

    expect(settled).toHaveBeenCalledWith(false);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(repos.attempt.endSupersededByInbound).not.toHaveBeenCalled();
    const ended = repos.attempt.setState.mock.calls.find((c: any) => c[1] === 'ended')!;
    expect(ended[2]).toMatchObject({ outcome: 'connected' });
    expect(ws.sent.filter((f) => f.event === 'released').map((f) => f.reason)).not.toContain('inbound_call');
  });

  it('no live call to cancel: the mark is dropped and settled(false), so a later end settles as any dial', async () => {
    const bridge = fakeBridge({ found: false });
    const { dialer } = await ringing(bridge);
    const settled = vi.fn();
    expect(dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled })).toBe(true);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(false));
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'no_answer', outcome: 'no_answer', answered: false });
    await vi.waitFor(() => expect(repos.attempt.setState.mock.calls.some((c: any) => c[1] === 'ended')).toBe(true));
    expect(repos.attempt.endSupersededByInbound).not.toHaveBeenCalled();
  });

  it('a second supersede of the same dial is refused', async () => {
    const { dialer } = await ringing(fakeBridge({ found: false }));
    const first = vi.fn();
    // Marked synchronously: until the cancel's answer comes back, nobody else may take the dial.
    expect(dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-1', settled: first })).toBe(true);
    expect(dialer.supersedeForInbound('att-1', { inboundCallId: 'ib-2', settled: vi.fn() })).toBe(false);
  });
});
