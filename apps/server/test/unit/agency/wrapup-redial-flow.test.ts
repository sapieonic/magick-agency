import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `startWrapupRedial`: what happens AFTER the wrap-up is taken, when something then
// refuses or fails (the reservation, the rows, a disposition racing the redial, the
// dispatch). The ticket's rule for every one of them: the agent is put back in wrap-up
// on the attempt the redial was taken from (or held out of the pool when it cannot
// be), and is NEVER released to `available` while the conversation's outcome is owed.
//
// A real `WrapupManager` (so the wrap-up entry and the set-up mark are the real
// thing) over an in-memory agent state store; the rows, the gates and the dialer are
// doubles. The dialer's `enterRedialWrapup` double re-enters the real manager the way
// the real one does.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { repos, gates } = vi.hoisted(() => ({
  repos: {
    attempt: {
      findById: vi.fn(),
      beginWrapupRedial: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
    },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn() },
    session: { setState: vi.fn().mockResolvedValue(undefined) },
    insightsPacing: { addToMinute: vi.fn().mockResolvedValue(undefined) },
    callerIds: { mapForCampaign: vi.fn() },
  },
  gates: { evaluatePreDialGates: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
  agencyInsightsPacingRepository: repos.insightsPacing,
  agencyAgentCallerIdRepository: repos.callerIds,
}));
vi.mock('../../../src/agency/pre-dial-gates.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/agency/pre-dial-gates.js')>()),
  evaluatePreDialGates: gates.evaluatePreDialGates,
}));

import { WrapupManager } from '../../../src/agency/wrapup-manager.js';
import { startWrapupRedial, type WrapupRedialDeps } from '../../../src/agency/wrapup-redial.js';
import { DedicatedCallerIdCache } from '../../../src/agency/pacing/dedicated-caller-ids.js';
import type { AgentStateMachine } from '../../../src/agency/agent-state-machine.js';
import type { StationRegistry } from '../../../src/agency/station-registry.js';

const SESSION = '00000000-0000-4000-8000-0000000000a1';
const ATTEMPT = '00000000-0000-4000-8000-0000000000b1';
const REDIAL = '00000000-0000-4000-8000-0000000000b2';

const campaign = {
  id: 'camp-1', tenant_id: 'ten-1', account_id: 'acc-1', status: 'running',
  allow_wrapup_redial: true, wrapup_seconds: 30, wrapup_auto_return: true,
  caller_ids: ['+919000000001'], disposition_catalog: [{ code: 'sale', label: 'Sale' }],
};
const original = {
  id: ATTEMPT, campaign_id: 'camp-1', contact_id: 'contact-1', reserved_agent_id: SESSION,
  state: 'ended', outcome: 'connected', disposition_code: null, bridged_at: new Date(),
  redial_number: 0, attempt_number: 1, caller_id: '+919000000001',
};
const redialRow = {
  ...original, id: REDIAL, state: 'queued', outcome: null, bridged_at: null,
  redial_number: 1, redial_of_attempt_id: ATTEMPT, attempt_number: 2,
};

/** The agent state store: the CAS steps the flow uses, over one map. */
function fakeAgents() {
  const state = new Map<string, string>();
  return {
    state,
    reserveFromWrapup: vi.fn(async (id: string): Promise<'reserved' | 'lost' | 'unavailable'> => {
      if (state.get(id) !== 'wrapup') return 'lost';
      state.set(id, 'reserved');
      return 'reserved';
    }),
    transition: vi.fn(async (id: string, from: string, to: string) => {
      if (state.get(id) !== from) return false;
      state.set(id, to);
      return true;
    }),
    set: vi.fn(async (id: string, to: string) => { state.set(id, to); return 'ok'; }),
  };
}

function harness() {
  const agents = fakeAgents();
  const stations = { send: vi.fn(() => true), ownerOf: vi.fn(async () => 'r1') };
  const wrapup = new WrapupManager(
    stations as unknown as StationRegistry,
    agents as unknown as AgentStateMachine,
    vi.fn(async () => undefined),
  );
  const dialer = {
    enterRedialWrapup: vi.fn(async (t: { sessionId: string; attemptId: string; redialNumber?: number }) =>
      wrapup.enter({
        sessionId: t.sessionId, attemptId: t.attemptId, campaignId: 'camp-1', tenantId: 'ten-1',
        wrapupSeconds: 30, autoReturn: true, requiresDisposition: true,
        redialRemaining: 2 - (t.redialNumber ?? 0),
      })),
    releaseAgent: vi.fn(async (id: string) => { agents.state.set(id, 'available'); return { state: 'available', result: 'ok' }; }),
    releaseOwingOutcome: vi.fn(async (id: string) => { agents.state.set(id, 'break'); return { state: 'break', result: 'ok' }; }),
    abandonUndispatchedRedial: vi.fn(async () => undefined),
  };
  const dispatcher = { dispatch: vi.fn(async () => undefined) };
  const deps = {
    agents, wrapup, stations, dnc: {} as never, dispatcher, dialer,
    // Unarmed: reads through to the mocked repository, as in a media worker.
    callerIds: new DedicatedCallerIdCache(),
  } as unknown as WrapupRedialDeps;
  return { agents, wrapup, dialer, dispatcher, deps };
}

async function inWrapup(h: ReturnType<typeof harness>) {
  await h.wrapup.enter({
    sessionId: SESSION, attemptId: ATTEMPT, campaignId: 'camp-1', tenantId: 'ten-1',
    wrapupSeconds: 30, autoReturn: true, requiresDisposition: true, redialRemaining: 2,
  });
  expect(h.agents.state.get(SESSION)).toBe('wrapup');
}

const go = (h: ReturnType<typeof harness>) =>
  startWrapupRedial(h.deps, { sessionId: SESSION, attemptId: ATTEMPT, actorUserId: 'user-1' });

/** The rule every failure after the take must keep. */
function expectBackInWrapupOwing(h: ReturnType<typeof harness>) {
  expect(h.agents.state.get(SESSION)).toBe('wrapup');
  expect(h.wrapup.stateFor(SESSION)).toMatchObject({ attempt_id: ATTEMPT, requires_disposition: true, redial_remaining: 2 });
  expect(h.wrapup.redialBeingSetUp(SESSION)).toBe(false);
  expect(h.dialer.releaseAgent).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.attempt.findById.mockResolvedValue(original);
  repos.campaign.findById.mockResolvedValue(campaign);
  repos.contact.findById.mockResolvedValue({ id: 'contact-1', state: 'connected', phone_e164: '+919812340001' });
  repos.attempt.beginWrapupRedial.mockResolvedValue({ ok: true, attempt: redialRow });
  // No dedicated caller IDs (DN1) unless a case says so: the rotation is the whole pool.
  repos.callerIds.mapForCampaign.mockResolvedValue(new Map());
  gates.evaluatePreDialGates.mockResolvedValue({ action: 'dial', clearance: { contactId: 'contact-1', checkedAt: new Date() } });
});

describe('startWrapupRedial — failures after the take', () => {
  it('the reservation is lost (the agent left wrap-up underneath): back in wrap-up, refused 409', async () => {
    const h = harness();
    await inWrapup(h);
    h.agents.reserveFromWrapup.mockResolvedValueOnce('lost');
    const res = await go(h);
    expect(res).toMatchObject({ ok: false, status: 409, code: 'redial_not_allowed' });
    expectBackInWrapupOwing(h);
    expect(repos.attempt.beginWrapupRedial).not.toHaveBeenCalled();
  });

  it('the state store does not answer: an honest 503, not "you left wrap-up"', async () => {
    const h = harness();
    await inWrapup(h);
    h.agents.reserveFromWrapup.mockResolvedValueOnce('unavailable');
    const res = await go(h);
    expect(res).toMatchObject({ ok: false, status: 503, code: 'redial_blocked' });
    if (res.ok) throw new Error('expected a refusal');
    expect(res.message).not.toMatch(/wrap-up/);
    expectBackInWrapupOwing(h);
  });

  it('beginWrapupRedial refuses (the customer is no longer held): unreserved, back in wrap-up', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.beginWrapupRedial.mockResolvedValueOnce({ ok: false, reason: 'contact_not_held' });
    const res = await go(h);
    expect(res).toMatchObject({ ok: false, status: 409, code: 'redial_not_allowed' });
    expect(h.agents.transition).toHaveBeenCalledWith(SESSION, 'reserved', 'wrapup', expect.anything());
    expectBackInWrapupOwing(h);
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('beginWrapupRedial throws: unreserved, back in wrap-up, and the error propagates', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.beginWrapupRedial.mockRejectedValueOnce(new Error('db down'));
    await expect(go(h)).rejects.toThrow('db down');
    expectBackInWrapupOwing(h);
  });

  it('a lost unreserve CAS (the pre-dial lease lapsed) still reopens wrap-up on a live station', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.beginWrapupRedial.mockImplementationOnce(async () => {
      h.agents.state.delete(SESSION); // the 10 s reservation lapsed during the write
      return { ok: false, reason: 'contact_not_held' };
    });
    await go(h);
    expectBackInWrapupOwing(h);
  });

  it('the wrap-up cannot be reopened (no station, or enter threw): held out of the pool, never released to available', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.beginWrapupRedial.mockResolvedValueOnce({ ok: false, reason: 'contact_not_held' });
    h.dialer.enterRedialWrapup.mockResolvedValueOnce(false);
    await go(h);
    expect(h.dialer.releaseOwingOutcome).toHaveBeenCalledWith(SESSION);
    expect(h.dialer.releaseAgent).not.toHaveBeenCalled();
    expect(h.agents.state.get(SESSION)).not.toBe('available');
  });

  it('the disposition won the race to the row: the taken wrap-up ends `disposition_submitted` and the agent is done', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.beginWrapupRedial.mockResolvedValueOnce({ ok: false, reason: 'disposition_already_submitted' });
    repos.attempt.setState.mockClear();
    const res = await go(h);
    expect(res).toMatchObject({ ok: false, status: 409, code: 'disposition_already_submitted' });
    await new Promise((r) => setTimeout(r, 0));
    // The original's wrap-up is closed with the right resolution (it was never persisted before).
    expect(repos.attempt.setState).toHaveBeenCalledWith(ATTEMPT, 'ended', expect.objectContaining({
      wrapup_resolution: 'disposition_submitted',
    }));
    // The outcome is IN: released through the one release path, with no wrap-up left behind.
    expect(h.dialer.releaseAgent).toHaveBeenCalledWith(SESSION);
    expect(h.wrapup.stateFor(SESSION)).toBeNull();
    expect(h.wrapup.redialBeingSetUp(SESSION)).toBe(false);
  });

  it('the dispatcher refuses the redial: it is abandoned through the dialer (which reopens wrap-up)', async () => {
    const h = harness();
    await inWrapup(h);
    h.dispatcher.dispatch.mockRejectedValueOnce(new Error('stale clearance'));
    const res = await go(h);
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(h.dialer.abandonUndispatchedRedial).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: REDIAL, redial: { ofAttemptId: ATTEMPT, number: 1 } })));
    expect(h.dialer.releaseAgent).not.toHaveBeenCalled();
  });

  it('while the redial is being set up (taken, not yet dispatched) the set-up mark is up', async () => {
    const h = harness();
    await inWrapup(h);
    let markDuringWrite = false;
    repos.attempt.beginWrapupRedial.mockImplementationOnce(async () => {
      markDuringWrite = h.wrapup.redialBeingSetUp(SESSION);
      return { ok: true, attempt: redialRow };
    });
    await go(h);
    expect(markDuringWrite).toBe(true);
  });
});

describe('startWrapupRedial — not this session\'s attempt', () => {
  it('a missing attempt and another session\'s (or tenant\'s) attempt are the same 404', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.findById.mockResolvedValueOnce(null);
    const missing = await go(h);
    repos.attempt.findById.mockResolvedValueOnce({ ...original, reserved_agent_id: 'another-session' });
    const theirs = await go(h);
    expect(missing).toMatchObject({ ok: false, status: 404, code: 'redial_not_allowed' });
    expect(theirs).toEqual(missing);
    // Nothing was read past the attempt, and nothing was taken.
    expect(repos.campaign.findById).not.toHaveBeenCalled();
    expect(h.wrapup.stateFor(SESSION)?.attempt_id).toBe(ATTEMPT);
  });
});

describe('startWrapupRedial — a refusal at the limit is recorded (IN2)', () => {
  const atLimit = () => expect(repos.insightsPacing.addToMinute).toHaveBeenCalledWith(expect.objectContaining({
    campaignId: 'camp-1', tenantId: 'ten-1', field: 'redials_refused_at_limit',
  }));

  it('the live wrap-up has no redials left: 409 redial_limit_reached, one minute counted', async () => {
    const h = harness();
    await h.wrapup.enter({
      sessionId: SESSION, attemptId: ATTEMPT, campaignId: 'camp-1', tenantId: 'ten-1',
      wrapupSeconds: 30, autoReturn: true, requiresDisposition: true, redialRemaining: 0,
    });
    expect(await go(h)).toMatchObject({ ok: false, status: 409, code: 'redial_limit_reached' });
    expect(repos.insightsPacing.addToMinute).toHaveBeenCalledTimes(1);
    atLimit();
  });

  it('the attempt row is already the last redial: refused by the row check, counted', async () => {
    const h = harness();
    await inWrapup(h);
    repos.attempt.findById.mockResolvedValueOnce({ ...original, redial_number: 2, redial_of_attempt_id: 'x' });
    expect(await go(h)).toMatchObject({ ok: false, code: 'redial_limit_reached' });
    expect(repos.insightsPacing.addToMinute).toHaveBeenCalledTimes(1);
    atLimit();
  });

  it('a refusal for any other reason records nothing', async () => {
    const h = harness();
    await inWrapup(h);
    gates.evaluatePreDialGates.mockResolvedValueOnce({ action: 'suppress', gate: 'dnc', suppressedReason: 'dnc' });
    expect(await go(h)).toMatchObject({ ok: false, code: 'redial_blocked_dnc' });
    const ok = await go(h);
    expect(ok.ok).toBe(true);
    expect(repos.insightsPacing.addToMinute).not.toHaveBeenCalled();
  });

  it('a pacing history write that fails does not change the answer', async () => {
    const h = harness();
    await h.wrapup.enter({
      sessionId: SESSION, attemptId: ATTEMPT, campaignId: 'camp-1', tenantId: 'ten-1',
      wrapupSeconds: 30, autoReturn: true, requiresDisposition: true, redialRemaining: 0,
    });
    repos.insightsPacing.addToMinute.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await go(h)).toMatchObject({ ok: false, status: 409, code: 'redial_limit_reached' });
  });
});

describe('startWrapupRedial — the caller ID (WR7 with dedicated caller IDs, DN4)', () => {
  const POOL = ['+919000000001', '+919000000002', '+919000000003'];
  async function redialFrom(opts: { owner: string | null; previous: string; dedicated: Array<[string, string]> }) {
    repos.campaign.findById.mockResolvedValue({ ...campaign, caller_ids: POOL });
    repos.attempt.findById.mockResolvedValue({ ...original, caller_id: opts.previous });
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', state: 'connected', phone_e164: '+919812340001', assigned_user_id: opts.owner });
    repos.callerIds.mapForCampaign.mockResolvedValue(new Map(opts.dedicated));
    const h = harness();
    await inWrapup(h);
    const res = await go(h);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(repos.callerIds.mapForCampaign).toHaveBeenCalledWith('camp-1');
    return repos.attempt.beginWrapupRedial.mock.calls[0]![0].callerId as string;
  }

  it('the owner\'s dedicated number wins over the number the customer just heard', async () => {
    expect(await redialFrom({ owner: 'agent-a', previous: '+919000000001', dedicated: [['agent-a', '+919000000002']] }))
      .toBe('+919000000002');
  });

  it('no dedication for the owner: the previous number while it is still in the rotation', async () => {
    expect(await redialFrom({ owner: 'agent-a', previous: '+919000000003', dedicated: [['agent-b', '+919000000002']] }))
      .toBe('+919000000003');
  });

  it('a previous number since dedicated to someone else is not reused for a contact that is not theirs', async () => {
    const picked = await redialFrom({ owner: null, previous: '+919000000002', dedicated: [['agent-b', '+919000000002']] });
    expect(['+919000000001', '+919000000003']).toContain(picked);
  });
});
