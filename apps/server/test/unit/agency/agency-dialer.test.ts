// PORT NOTE (magick-agency, Phase 6): ported from core
// test/unit/agency/agency-dialer.test.ts@4850d1d9 (28 cases → 28). Deleted: none.
// Modified (no case changed meaning):
//  - mock/import specifiers follow the path rule (logger → `@magick-agency/observability`;
//    break-manager / timers / abandonment-predicate → `@magick-agency/domain/*`);
//  - the campaign fixture drops `sip_connection_id` (SIP deleted, plan §5; the dialer
//    no longer passes `sipConnectionId`, docs/seams.md §3.1). No assertion read it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The ordering guarantee (§9) and the release contract.
//
// QA's decisive test answers the carrier SYNCHRONOUSLY inside the dial call — a
// three-second ring would hide an implementation that emits `reserved` from an
// async continuation after the dial. These tests reproduce that: the fake bridge
// fires its `bridged` lifecycle event from inside createBridgedCall, before it
// resolves. The panel must already be on the wire.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// AgencyDialer imports WebRtcCallError from the bridge, which pulls the config
// graph — and the config schema `process.exit(1)`s on anything incomplete.
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
      // Stubbed at their real home on the attempt repository so `MAG-88`
      // acceptance (b) can assert nobody stamped a code on a call that never owed
      // one. "This spy was never called" is worthless if the spy does not exist —
      // the property under test would then be "the double is incomplete", which is
      // true of any name at all.
      recordDisposition: vi.fn().mockResolvedValue(null),
      recordAutoDisposition: vi.fn().mockResolvedValue(null),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      // Returns the POST-bump budget (`AD-P3-C-01`). A number, not undefined: the
      // dial path decides the retry from whatever this returns.
      chargeAttempt: vi.fn().mockResolvedValue(1),
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
import { WrapupManager } from '../../../src/agency/wrapup-manager.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/**
 * Wrap-up double. `enter` returning FALSE is the `wrapup_seconds = 0` answer —
 * the default here, so every pre-existing test keeps asserting the straight-back-
 * to-`available` path it was written for. Tests that care about wrap-up opt in.
 */
/** Break queue double. Empty by default, so existing tests see `available`. */
function fakeBreaks(queued: any = null) {
  return {
    queue: vi.fn(),
    peek: vi.fn(() => queued),
    take: vi.fn(() => queued),
    cancel: vi.fn(),
    size: vi.fn(() => (queued ? 1 : 0)),
  };
}

function fakeWrapup(opts: { entered?: boolean } = {}) {
  return {
    enter: vi.fn(async () => opts.entered ?? false),
    cancel: vi.fn(),
    force: vi.fn(async () => false),
    stateFor: vi.fn(() => null),
    noteDisposition: vi.fn(async () => false),
    stop: vi.fn(),
    active: vi.fn(() => 0),
  };
}

function fakeWs() {
  return {
    readyState: 1,
    OPEN: 1,
    sent: [] as any[],
    send(s: string) { this.sent.push(JSON.parse(s)); },
    on() { /* the bridge attaches its own listeners; not exercised here */ },
    off() { /* ditto */ },
    close() { this.readyState = 3; },
  };
}

/** Bridge double whose lifecycle events fire at a caller-chosen moment. */
function fakeBridge(opts: { answerDuringDial?: boolean } = {}) {
  const listeners: Array<(e: any) => void> = [];
  return {
    listeners,
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => { /* noop */ }; },
    createBridgedCall: vi.fn(async () => {
      if (opts.answerDuringDial) {
        // The carrier answers INSIDE the dial, before it resolves. This is the
        // adversarial case: anything emitted after the dial loses the race.
        for (const l of listeners) l({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
      }
      return { id: 'call-1' } as any;
    }),
    emit(ev: any) { for (const l of listeners) l(ev); },
  };
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'vobiz', record_calls: false, // PORT NOTE: `sip_connection_id` dropped (SIP deleted)
  analysis_profile_id: null, caller_ids: ['+14155550100'],
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha', 'Policy No': 'X-1' }, attempt_count: 0,
} as any;

// `campaign` is a parameter, NOT a closed-over constant, because the disposition
// questions (`MAG-88`, §2.4 precedence) are decided off campaign config — an
// empty `disposition_catalog` is a different scenario from an absent one. It was
// previously fixed at `CAMPAIGN`, so a caller passing an override was silently
// given the default: the MAG-88 case ran against `disposition_catalog: undefined`
// and asserted the empty-catalog behaviour. `tsc` reported it (TS2554) but
// `npm run lint` does not typecheck tests (`AD-PLATFORM-01`), so only the red
// assertion surfaced it — and it read as an implementation gap rather than a
// harness one.
function makeCmd(sessionId: string, campaign: any = CAMPAIGN): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId, ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign, contact: CONTACT,
  };
}

async function attachStation(stations: StationRegistry, sessionId: string, ws: any) {
  await stations.attach({
    sessionId, campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws,
  });
}

beforeEach(() => vi.clearAllMocks());

/**
 * An agent registry that reports the reservation as still held.
 *
 * A bare `AgentStateMachine` with no Redis makes `transition` return
 * **false**, because the machine fails closed on an unreadable agent pool. These
 * cases are about dial ORDERING and never modelled the reservation, which was
 * invisible while `executeDial` discarded the CAS result; now that a failed CAS
 * correctly aborts the dial, a null-Redis registry would abort every one of them.
 * Stubbing the extension keeps each test on its own subject rather than turning it
 * into an agent-lease test — `agent-state-machine.test.ts` owns the CAS itself, and
 * `abandoned-call-path.test.ts` exercises it through a real fake-Redis CAS.
 */
function reservedAgents(): AgentStateMachine {
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  return agents;
}

describe('AgencyDialer ordering guarantee', () => {
  it('pushes the context panel BEFORE the dial, even when the carrier answers inside it', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const bridge = fakeBridge({ answerDuringDial: true });
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);

    // Record frame order relative to the dial.
    let framesAtDialTime: string[] = [];
    bridge.createBridgedCall.mockImplementation(async () => {
      framesAtDialTime = ws.sent.map((f) => f.event);
      for (const l of bridge.listeners) l({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
      return { id: 'call-1' } as any;
    });

    await dialer.executeDial(makeCmd('s1'));

    // The panel was already on the wire when the dial was placed.
    expect(framesAtDialTime).toContain('reserved');
    expect(framesAtDialTime.indexOf('reserved')).toBe(0);

    const reserved = ws.sent.find((f) => f.event === 'reserved');
    expect(reserved.attempt.context).toEqual({ 'First Name': 'Asha', 'Policy No': 'X-1' });
    expect(reserved.attempt.phone_e164).toBe('+919876543210');
    expect(reserved.attempt.campaign_name).toBe('Q3 Renewals');

    // And `bridged` strictly follows it.
    const order = ws.sent.map((f) => f.event);
    expect(order.indexOf('reserved')).toBeLessThan(order.indexOf('bridged'));
  });

  it('puts the `bridged` frame on the wire BEFORE any bookkeeping await', async () => {
    // Media is live the instant the bridge emits `bridged` — the customer can
    // already be speaking — and the console schedules its audible connect cue
    // inside this frame's handler against a 150ms audibility budget. Every await
    // ahead of the send spends that budget on the agent's behalf, and none of the
    // writes below make the audio any more live than it already is.
    //
    // Asserted as an ORDERING between the send and the persistence calls rather
    // than by timing it: a duration assertion passes on an idle machine and fails
    // under exactly the load this ordering exists to survive.
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);

    const seq: string[] = [];
    const origSend = ws.send.bind(ws);
    ws.send = (s: string) => {
      const frame = JSON.parse(s);
      if (frame.event === 'bridged') seq.push('frame');
      origSend(s);
    };
    repos.attempt.setState.mockImplementation(async (_id: string, state: string) => {
      if (state === 'bridged') seq.push('attempt_row');
      return null;
    });
    repos.contact.markState.mockImplementation(async () => { seq.push('contact_row'); });

    await dialer.executeDial(makeCmd('s1'));
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
    await vi.waitFor(() => expect(seq).toContain('contact_row'));

    expect(seq).toEqual(['frame', 'attempt_row', 'contact_row']);
  });

  it('never re-asserts `dialing` after the dial, so a fast answer is not clobbered', async () => {
    // The other half of the correlationId fix. onBridgeLifecycle writes `bridged`
    // from INSIDE createBridgedCall on a fast carrier; a post-dial write of
    // `dialing` would put it back and the row would read `dialing` for the whole
    // of a live conversation — wrong on the agent console, wrong on the
    // supervisor's by-state view, and wrong for anything branching on `bridged`.
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge({ answerDuringDial: true });
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    await attachStation(stations, 's1', fakeWs());

    await dialer.executeDial(makeCmd('s1'));

    // The call id is recorded WITHOUT touching state — the race is removed, not
    // narrowed, so there is no ordering left to get wrong.
    expect(repos.attempt.attachWebrtcCall).toHaveBeenCalledWith('att-1', 'call-1');
    const dialingWrites = repos.attempt.setState.mock.calls.filter((c: any) => c[1] === 'dialing');
    expect(dialingWrites).toHaveLength(1);              // only the pre-dial one
    expect(dialingWrites[0]![2]).not.toHaveProperty('webrtc_call_id');

    // And `bridged` is the last state written, not `dialing`.
    const states = repos.attempt.setState.mock.calls.map((c: any) => c[1]);
    expect(states.at(-1)).toBe('bridged');
  });

  it('still sends the panel first when prior-attempt history fails to load', async () => {
    repos.attempt.findPriorForContactLineage.mockRejectedValueOnce(new Error('db down'));
    const stations = new StationRegistry(null, '', 'r1');
    const dialer = new AgencyDialer(fakeBridge() as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);

    await dialer.executeDial(makeCmd('s1'));

    // History is nice-to-have; losing it must not cost the customer a call.
    const reserved = ws.sent.find((f) => f.event === 'reserved');
    expect(reserved).toBeTruthy();
    expect(reserved.attempt.prior_attempts).toEqual([]);
  });

  it('refuses to dial when the agent socket vanished, and says why', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    // No station attached at all.
    await dialer.executeDial(makeCmd('ghost'));

    // Dialing with no agent manufactures exactly the abandoned call that
    // reserve-before-dial exists to prevent.
    expect(bridge.createBridgedCall).not.toHaveBeenCalled();
    expect(repos.contact.unclaim).toHaveBeenCalledWith('contact-1', expect.any(Date));
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'ended', expect.objectContaining({ outcome: 'orphaned' }));
  });
});

describe('AgencyDialer carrier-answer anchor', () => {
  async function dialAndAnswer(opts: { alsoBridge?: boolean } = {}) {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));

    const answeredAt = new Date('2026-08-11T10:00:00.000Z');
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true, answeredAt });
    if (opts.alsoBridge) {
      bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true, answeredAt });
    }
    await vi.waitFor(() => expect(repos.attempt.setState).toHaveBeenCalledWith(
      'att-1', opts.alsoBridge ? 'bridged' : 'answered', expect.anything(),
    ));
    return { ws, answeredAt };
  }

  it('records the carrier answer WITHOUT ending the attempt', async () => {
    // The handler used to read "if bridged … else it must be ended". A phase added
    // to the bridge's union therefore fell into teardown — which would end a live
    // call the instant the carrier picked up, the worst possible failure here.
    const { ws } = await dialAndAnswer();

    const states = repos.attempt.setState.mock.calls.map((c: any[]) => c[1]);
    expect(states).toContain('answered');
    expect(states).not.toContain('ended');
    expect(ws.sent.map((f: any) => f.event)).not.toContain('released');
  });

  it('writes the real answer instant, never the bridge instant', async () => {
    // QA's falsifier, at the unit tier: `answered_at` and `bridged_at` collapsing to
    // one value makes the abandonment predicate ("answered, and no bridge within
    // N ms") vacuous, and leaves the compliance denominator with no source. A fix
    // that keeps collapsing them passes every other assertion in this file.
    const { answeredAt } = await dialAndAnswer({ alsoBridge: true });

    const answeredCall = repos.attempt.setState.mock.calls.find((c: any[]) => c[1] === 'answered');
    expect(answeredCall![2].answered_at).toEqual(answeredAt);

    const bridgedCall = repos.attempt.setState.mock.calls.find((c: any[]) => c[1] === 'bridged');
    // Threaded from the bridge's own anchor — NOT the local bridge timestamp, which
    // is what the column's COALESCE would otherwise have silently preserved.
    expect(bridgedCall![2].answered_at).toEqual(answeredAt);
    expect(bridgedCall![2].bridged_at).not.toEqual(answeredAt);
  });

  it('reaches the `answered` attempt state at all, which nothing did before', async () => {
    // `answered` is declared in the attempt state machine and was unreachable: the
    // only writes were `dialing`, `bridged` and `ended`. An answered-but-never-
    // bridged attempt is the ONLY path an abandoned call takes, so an unreachable
    // `answered` state means AD-P2-C-05 has nothing to key on.
    await dialAndAnswer();
    expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'answered', expect.anything());
  });
});

describe('AgencyDialer release contract', () => {
  it('always sends a reason and a message on release', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));
    ws.sent.length = 0;

    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'no_answer', outcome: 'no_answer', answered: false });
    await vi.waitFor(() => expect(ws.sent.some((f) => f.event === 'released')).toBe(true));

    const released = ws.sent.find((f) => f.event === 'released');
    expect(released.reason).toBe('no_answer');
    // A no-answer is not the agent's to describe — prompting for a disposition
    // there trains them to click through the dialog without reading it.
    expect(released.requires_disposition).toBe(false);
    expect(released.message).toBeTruthy();
  });

  it('requires a disposition only when the call actually reached the agent', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));
    // ── The `bridged` phase is now REQUIRED to model a connected call ────────
    //
    // This test used to jump straight to `ended` with `answered: true`, and it
    // passed because the `ended` handler fed the classifier `bridged:
    // ev.answered` — so the carrier's pickup WAS the bridge as far as the code
    // could tell. That was the 2026-09-08 pilot's defect, and the shortcut here
    // is what made it invisible from this file: no test distinguished "the
    // customer answered" from "an agent was attached", because the production
    // code did not either. `live.bridgedAt` is now the only source, so a scenario that means
    // "a real conversation happened" has to say so.
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
    ws.sent.length = 0;

    bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'completed',
      outcome: 'remote_hangup', answered: true, talkTimeSeconds: 42,
    });
    await vi.waitFor(() => expect(ws.sent.some((f) => f.event === 'released')).toBe(true));

    const released = ws.sent.find((f) => f.event === 'released');
    expect(released.reason).toBe('completed');
    expect(released.requires_disposition).toBe(true);
    // The contact waits for that disposition rather than being marked done.
    expect(repos.contact.markState).toHaveBeenCalledWith('contact-1', 'connected', expect.anything());
  });

  it('MAG-88: does NOT park a connected contact when no disposition is owed', async () => {
    // ─── The parking defect ─────────────────────────────────────────────────
    // `connected` holds a contact awaiting the agent's write-up, and the only two
    // things that release it are the disposition route and the reaper's
    // `no_disposition` sweep. On a campaign with an EMPTY `disposition_catalog` no
    // disposition is owed, so none is ever submitted and the contact sat in
    // `connected` until the reaper eventually noticed.
    //
    // An empty catalog is not a broken campaign — it is a legitimate configuration
    // meaning "outcome-driven retry, no human write-up step", and it is the state of
    // every campaign today since master never sends the field. So the fix is
    // `MAG-88` option (1): when none is owed, the outcome policy decides now.
    //
    // **There is no reaper in this harness at all**, which is what makes this test
    // about the fix rather than about the backstop — a test that let the sweep run
    // would go green either way.
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    // The only difference from the test above, which has no `disposition_catalog`
    // key at all (⇒ `undefined` ⇒ a disposition IS owed) and asserts the parking.
    await dialer.executeDial(makeCmd('s1', { ...CAMPAIGN, disposition_catalog: [] }));
    // A connected call must actually bridge now — see the note in the test
    // above. Emitted BEFORE the clears, so the `bridged` arm's own writes cannot
    // be mistaken for the `ended` handler's below (with an empty catalog it makes
    // no contact write at all, which is the other half of this fix).
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
    repos.contact.markState.mockClear();
    repos.contact.chargeAttempt.mockClear();

    bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'completed',
      outcome: 'remote_hangup', answered: true, talkTimeSeconds: 42,
    });
    await vi.waitFor(() => expect(repos.contact.markState).toHaveBeenCalled());

    const released = ws.sent.find((f) => f.event === 'released');
    // One function answers the question for both the frame and the contact's fate.
    expect(released.requires_disposition).toBe(false);

    const states = repos.contact.markState.mock.calls.map((c) => c[1]);
    expect(states).not.toContain('connected');
    // `completed` via the outcome policy: `connected`'s default rule is
    // `max_attempts: 0`, so the existing branch already produced the right answer —
    // only the condition guarding it moved.
    expect(states).toContain('completed');
    // Charged exactly once. The branch that now runs bumps via `chargeAttempt`
    // where the old one used `bump_attempt`, and doing both would charge a contact
    // twice for one dial.
    expect(repos.contact.chargeAttempt).toHaveBeenCalledTimes(1);
    expect(repos.contact.chargeAttempt).toHaveBeenCalledWith('contact-1', 'connected');
  });

  /**
   * Drive one whole bridged conversation and hand back every contact write it made.
   *
   * **The `bridged` attempt write is deliberately SLOW**, and that is the point of
   * the helper rather than an incidental detail. Lifecycle listeners are invoked
   * fire-and-forget, so on a call the customer picks up and immediately drops, the
   * `ended` handler runs to completion while the `bridged` handler is still parked
   * on its DB round trip. Answering the bridge instantaneously — which is what a
   * bare `mockResolvedValue` does — serialises the two handlers and hides the whole
   * defect: every ordering assertion below passes on unfixed source.
   *
   * The tests that emit only `ended` are not wrong, but they never reach the site
   * that actually parks the contact, so they cannot see this.
   */
  async function runBridgedCall(campaign: any): Promise<{
    states: string[]; patches: any[]; released: any;
  }> {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1', campaign));
    repos.contact.markState.mockClear();

    try {
      repos.attempt.setState.mockImplementation(
        (_id: string, state: string) => new Promise(
          (resolve) => setTimeout(() => resolve(null), state === 'bridged' ? 25 : 0),
        ),
      );

      bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
      // No await between them: the customer hung up the instant they were bridged.
      bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'completed',
        outcome: 'remote_hangup', answered: true, talkTimeSeconds: 1,
      });

      await vi.waitFor(() => expect(ws.sent.some((f) => f.event === 'released')).toBe(true));
      // And then wait for the SLOW handler to land its write too. Asserting before
      // it does would clear the very write this is about.
      await vi.waitFor(
        () => expect(repos.attempt.setState).toHaveBeenCalledWith('att-1', 'bridged', expect.anything()),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    } finally {
      // `vi.clearAllMocks()` clears CALLS, not implementations — without this the
      // latency above leaks into every test that runs after this one.
      repos.attempt.setState.mockResolvedValue(null);
    }

    return {
      states: repos.contact.markState.mock.calls.map((c) => c[1] as string),
      patches: repos.contact.markState.mock.calls.map((c) => c[2]),
      released: ws.sent.find((f) => f.event === 'released'),
    };
  }

  it('MAG-88 (a): an empty catalog reaches `completed` with NO reaper in the harness', async () => {
    // ─── Acceptance (a) ─────────────────────────────────────────────────────
    // **There is no reaper anywhere in this harness**, and that is the load-bearing
    // part. `sweepLapsedWrapups` rescues exactly this contact, so a test that let it
    // run would go green on unfixed source and would be proving the backstop.
    //
    // The gate below the `ended` handler is only half the fix. `bridged` parks the
    // contact in `connected` unconditionally, and on a call that ends inside that
    // handler's DB round trip the stale `connected` lands ON TOP of the `completed`
    // the outcome policy just wrote — so the campaign never completes, nothing errors,
    // and the attempt reads like a clean successful call.
    const { states, released } = await runBridgedCall({ ...CAMPAIGN, disposition_catalog: [] });

    // Asserted as an EXACT ordered list, not as `not.toContain('connected')` and not
    // as "the last one is completed". Both weaker forms are satisfied by absence —
    // zero writes passes `not.toContain` — and neither can see a `connected` that
    // lands after a `completed`, which is the whole defect.
    expect(states).toEqual(['completed']);
    expect(released.requires_disposition).toBe(false);
  });

  it('MAG-88 (b): writes no disposition code for a call that never owed one', async () => {
    // ─── Acceptance (b) ─────────────────────────────────────────────────────
    // Rescue without a verdict. Stamping `no_disposition` on a call nobody was asked
    // to write up libels the agent and poisons the Phase 3 retry input, which keys
    // off the disposition.
    const { states, patches } = await runBridgedCall({ ...CAMPAIGN, disposition_catalog: [] });

    // The ROW exists — asserted first and positively, so "no code was written" cannot
    // be satisfied by the contact never having been touched at all.
    expect(states).toEqual(['completed']);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toBeDefined();

    // …and it carries no code. `toBeUndefined` rather than a falsy check: `null` is a
    // deliberate erasure and would deserve to fail here too.
    expect(patches[0].last_disposition).toBeUndefined();
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
    expect(repos.attempt.recordAutoDisposition).not.toHaveBeenCalled();
  });

  it('MAG-88 (c): a populated catalog still holds the contact in `connected`', async () => {
    // ─── Acceptance (c) ─────────────────────────────────────────────────────
    // The regression guard. `connected` is a HOLD awaiting the agent's write-up, and
    // a campaign that HAS codes to pick must keep it — the disposition route is
    // entitled to decide this contact's fate (§2.4 precedence) and releasing it here
    // would answer a question that is not ours.
    const { states, patches, released } = await runBridgedCall({
      ...CAMPAIGN, disposition_catalog: [{ code: 'sale', label: 'Sale' }],
    });

    // Both writes land, and — the point — they AGREE, which is why a populated
    // catalog was never the broken case: whichever of the two the slow bridge write
    // lets go last, the contact is still held in `connected`. Asserted without
    // fixing their order for exactly that reason.
    expect(states).toEqual(['connected', 'connected']);
    // Exactly one of them is the settle-time re-affirm, and it still charges the
    // attempt through `bump_attempt` rather than `chargeAttempt`.
    expect(patches.filter(Boolean)).toEqual([{ last_outcome: 'connected', bump_attempt: true }]);
    expect(released.requires_disposition).toBe(true);
  });

  it('leaves no contact stranded in_flight when a call is not answered', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));
    repos.contact.markState.mockClear();

    const before = Date.now();
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'busy', outcome: 'busy', answered: false });
    await vi.waitFor(() => expect(repos.contact.markState).toHaveBeenCalled());

    // Without outcome classification a non-answered call never leaves in_flight
    // and the campaign can never reach `completed`.
    //
    // `AD-P3-C-01` changed the destination from `completed` to `pending`: a `busy`
    // contact is now RETRIED rather than abandoned after one dial. The property this
    // test is named for is unchanged and still asserted — the contact must not be
    // left `in_flight` — but "not stranded" now has a second failure mode, because a
    // `pending` contact with no `next_attempt_at` is claimable instantly and would be
    // re-dialed in a tight loop. So the delay is asserted too.
    const [contactId, state, patch] = repos.contact.markState.mock.calls[0]!;
    expect(contactId).toBe('contact-1');
    expect(state).toBe('pending');
    // 15 minutes: `busy` in the built-in policy. Bounded on both sides against a
    // clock read either side of the call rather than asserted loosely — a
    // `toBeGreaterThan(Date.now())` would pass on a 60-minute delay, a 15-second one,
    // and a doubled fake clock alike.
    const scheduled = (patch as { next_attempt_at: Date }).next_attempt_at.getTime();
    expect(scheduled).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(scheduled).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    // The budget is charged exactly once, and by `chargeAttempt` — not a second time
    // via `bump_attempt`, which would spend two retries on one dial.
    expect(repos.contact.chargeAttempt).toHaveBeenCalledTimes(1);
    expect(repos.contact.chargeAttempt).toHaveBeenCalledWith('contact-1', 'busy');
    expect(patch).not.toHaveProperty('bump_attempt');
  });

  it('ignores lifecycle events for calls it did not place', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    bridge.emit({ callId: 'someone-elses-call', correlationId: 'not-our-attempt', phase: 'ended', status: 'completed', answered: true });
    await new Promise((r) => setTimeout(r, 5));

    // An ordinary browser-dialer call must not be touched by the agency layer.
    expect(repos.attempt.setState).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });
});

describe('AgencyDialer queued break (AD-P2-C-03)', () => {
  async function releaseWith(breaks: any) {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const setSpy = vi.spyOn(agents, 'set').mockResolvedValue(undefined);
    const dialer = new AgencyDialer(
      fakeBridge() as any, stations, agents, fakeWrapup() as any, breaks as any,
    );
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.releaseAgent('s1');
    return { ws, setSpy };
  }

  it('(a) sends the agent to `break`, not `available`, when one was queued', async () => {
    // The break was requested mid-call and deliberately did NOT interrupt it. This
    // is the moment it lands — at the end of wrap-up, through the one release path
    // every route into the pool passes through.
    const lunch = { code: 'lunch', label: 'Lunch' };
    const { ws, setSpy } = await releaseWith(fakeBreaks(lunch));

    expect(setSpy).toHaveBeenCalledWith('s1', 'break', expect.anything());
    const frame = ws.sent.find((f: any) => f.event === 'agent_state');
    expect(frame.state).toBe('break');
    // (c) the reason is on the frame as well as the session row, or a supervisor
    // watching the console cannot see WHY an agent left the pool.
    expect(frame.break_reason).toBe('lunch');
  });

  it('returns to `available` when nothing is queued', async () => {
    const { ws, setSpy } = await releaseWith(fakeBreaks(null));
    expect(setSpy).toHaveBeenCalledWith('s1', 'available', expect.anything());
    expect(ws.sent.find((f: any) => f.event === 'agent_state').state).toBe('available');
  });

  it('CONSUMES the queued break so it applies exactly once', async () => {
    // `take`, not `peek`: an agent who breaks, comes back available, and takes
    // another call must not be pulled out of the pool again on that call's release.
    const breaks = fakeBreaks({ code: 'lunch', label: 'Lunch' });
    await releaseWith(breaks);
    expect(breaks.take).toHaveBeenCalledWith('s1');
  });

  it('announces a queued break on the wrap-up frame and STILL applies it afterwards', async () => {
    // ── The regression a `take()` here would cause ────────────────────────────
    //
    // The wrap-up `agent_state` frame has to carry `pending_state` — it is the only
    // transition announcement in the whole wrap-up window, and `contracts.ts` puts
    // those fields on the frame precisely so a queued break survives a lost socket.
    // But reading the queue to announce it must NOT consume it: `releaseAgent` is
    // the single place a break applies (`AD-P2-C-03` (a)), so a `take()` at
    // announce time would show the badge and then silently drop the break, leaving
    // the agent `available` and dialed into immediately.
    //
    // Deliberately wired with the REAL `BreakRegistry` and REAL `WrapupManager`:
    // doubles for either would let a `take()` pass this test, which is the one
    // mistake it exists to catch.
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const agents = reservedAgents();
    const setSpy = vi.spyOn(agents, 'set').mockResolvedValue(undefined);
    const breaks = new BreakRegistry();
    let dialer!: AgencyDialer;
    const wrapup = new WrapupManager(stations, agents as any, (sessionId) =>
      dialer.releaseAgent(sessionId));
    dialer = new AgencyDialer(bridge as any, stations, agents, wrapup, breaks);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1', {
      ...CAMPAIGN, wrapup_seconds: 30, wrapup_auto_return: true,
    }));

    // "mid-conversation" now has to be a real conversation — wrap-up is
    // reachable only from `outcome === 'connected'`, and that needs a `bridged`
    // phase rather than just a carrier answer. See the note in the release-contract
    // test above for why this file did not have to say so before.
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });

    // The agent asks for a break mid-conversation. §5.1: it must not interrupt the
    // call, so it queues.
    breaks.queue('s1', { code: 'lunch', label: 'Lunch' });
    ws.sent.length = 0;

    bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended', status: 'completed',
      outcome: 'remote_hangup', answered: true, talkTimeSeconds: 42,
    });
    await vi.waitFor(() =>
      expect(ws.sent.some((f: any) => f.event === 'agent_state')).toBe(true));

    const enteringWrapup = ws.sent.find((f: any) => f.event === 'agent_state');
    expect(enteringWrapup.state).toBe('wrapup');
    expect(enteringWrapup.pending_state).toBe('break');
    expect(enteringWrapup.pending_break_reason).toBe('lunch');
    // Announced, not consumed — the queue is still armed for `releaseAgent`.
    expect(breaks.peek('s1')).toEqual({ code: 'lunch', label: 'Lunch' });

    // End the wrap-up. `force` rather than a 30s timer: auto-return, a submitted
    // disposition and a supervisor force all funnel through the same `resolve()`
    // → `onReturn` → `releaseAgent`, so this pins the shared path without making
    // the test wall-clock dependent.
    ws.sent.length = 0;
    await wrapup.force('s1');

    const afterWrapup = ws.sent.find((f: any) => f.event === 'agent_state');
    expect(afterWrapup.state).toBe('break');
    expect(afterWrapup.break_reason).toBe('lunch');
    expect(setSpy).toHaveBeenCalledWith('s1', 'break', expect.anything());
    // And consumed exactly once, so the agent's NEXT call doesn't pull them out
    // of the pool again.
    expect(breaks.peek('s1')).toBeNull();
  });

  it('drops a pending break for an agent whose socket is gone', async () => {
    // `offline` already keeps them out of the pool, and D2 rehydrates them into
    // `break` anyway — leaving the queue armed would apply a stale break to a
    // future shift.
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const setSpy = vi.spyOn(agents, 'set').mockResolvedValue(undefined);
    const breaks = fakeBreaks({ code: 'lunch', label: 'Lunch' });
    const dialer = new AgencyDialer(
      fakeBridge() as any, stations, agents, fakeWrapup() as any, breaks as any,
    );

    await dialer.releaseAgent('gone-session');

    expect(breaks.cancel).toHaveBeenCalledWith('gone-session');
    expect(setSpy).toHaveBeenCalledWith('gone-session', 'offline', expect.anything());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The three PR-review findings on this file. Each asserts the failing half.
// ═══════════════════════════════════════════════════════════════════════════

describe('AgencyDialer · the dial is gated on still holding the agent', () => {
  /**
   * `executeDial` extends the short pre-dial lease to the dialing one with a CAS.
   * That result was discarded and the dial went out regardless — which is the
   * reserved-then-abandoned failure the lease split exists to prevent. `transition`
   * returns false when the pre-dial lease expired while prior attempts were
   * loading, when the agent moved underneath us, and when Redis is unreachable
   * (it fails closed), so "false" spans every way of not having an agent.
   */
  it('does NOT place the carrier call when the lease CAS fails', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = new AgentStateMachine(null, '');
    vi.spyOn(agents, 'transition').mockResolvedValue(false);
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));

    expect(
      bridge.createBridgedCall,
      'a real customer was dialled with no agent committed to the call',
    ).not.toHaveBeenCalled();
    // And the attempt is settled rather than left hanging.
    const ended = repos.attempt.setState.mock.calls.find((c: any[]) => c[1] === 'ended');
    expect(ended?.[2]).toMatchObject({ outcome: 'orphaned' });
  });

  it('places the call when the CAS succeeds — the negative control', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(
      bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    await attachStation(stations, 's1', fakeWs());
    await dialer.executeDial(makeCmd('s1'));
    expect(bridge.createBridgedCall).toHaveBeenCalled();
  });
});

describe('AgencyDialer · a bookkeeping failure does not end a live call', () => {
  /**
   * `attachWebrtcCall` used to share the dial's try, whose catch runs
   * `abandonBeforeDial` — a lie once the bridge has returned: the PSTN leg is live
   * and the agent may already be talking, yet the attempt is dropped from
   * `liveByAttempt`, lease renewal stops and the row settles `orphaned`. The
   * conversation then carries on with no agency lifecycle attached to it.
   */
  it('keeps the call and settles nothing when the media-leg id fails to persist', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(
      bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    await attachStation(stations, 's1', fakeWs());

    repos.attempt.attachWebrtcCall.mockRejectedValueOnce(new Error('deadlock detected'));
    await dialer.executeDial(makeCmd('s1'));

    expect(bridge.createBridgedCall).toHaveBeenCalled();
    const ended = repos.attempt.setState.mock.calls.find((c: any[]) => c[1] === 'ended');
    expect(
      ended,
      'a live bridged call was settled because a bookkeeping write failed',
    ).toBeUndefined();
    // Still owned, so the reaper's liveness arm still protects it.
    expect(dialer.activeAttemptIds()).toContain('att-1');
  });
});

describe('AgencyDialer · the release names the agent hangup (MAG-112)', () => {
  /**
   * `hangupAttempt` ends the bridge with `forceEndWithOutcome(id, 'agent_hangup')`,
   * so the lifecycle arrives as `ev.outcome === 'agent_hangup'`. Matching only the
   * browser-leg spelling (`ended_by_user`) meant the *supported* hangup API
   * classified as an ordinary completed release: the agent pressed hang up and the
   * console told them the call had merely ended.
   */
  it('classifies `agent_hangup` as an agent hangup, not a plain completion', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const dialer = new AgencyDialer(
      bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));

    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
    bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      outcome: 'agent_hangup', status: 'completed', answered: true, talkTimeSeconds: 42,
    });
    await vi.waitFor(() => expect(ws.sent.some((f) => f.event === 'released')).toBe(true));

    const released = ws.sent.find((f) => f.event === 'released');
    expect(released.reason).toBe('agent_hangup');
  });
});

describe('AgencyDialer · `bridged` beats a late `answered` into the abandon decision', () => {
  /**
   * `answered` and `bridged` arrive back-to-back on a fast carrier, and lifecycle
   * listeners are invoked fire-and-forget — so the `bridged` handler can run to
   * completion inside the `answered` handler's row write. Taking the ownership
   * decision *after* that await read a station already `detach`ed for a deferred
   * hangup and abandoned a call that had bridged in the meantime: the apology clip
   * plays over a live conversation and the customer is cut off mid-sentence.
   */
  it('does not abandon a call that bridged while the answered row was being written', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const bridge = fakeBridge();
    const forceEnd = vi.fn().mockResolvedValue(true);
    (bridge as any).forceEndWithOutcome = forceEnd;
    const dialer = new AgencyDialer(
      bridge as any, stations, reservedAgents(), fakeWrapup() as any, fakeBreaks() as any,
    );
    dialer.start();
    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    await dialer.executeDial(makeCmd('s1'));

    // Hold the `answered` write open, and let `bridged` land inside it — the exact
    // interleaving the fire-and-forget listener permits.
    let releaseWrite: () => void = () => {};
    const held = new Promise<void>((resolve) => { releaseWrite = resolve; });
    repos.attempt.setState.mockImplementation(async (_id: string, state: string) => {
      if (state === 'answered') await held;
      return null;
    });

    // The agent's socket is already gone — this is the abandon precondition.
    ws.close();
    await stations.detach('s1', ws as any);

    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
    releaseWrite();
    await vi.waitFor(() => expect(repos.attempt.setState).toHaveBeenCalled());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

    expect(
      forceEnd.mock.calls.filter((c: any[]) => c[1] === 'abandoned'),
      'an apology clip was played over a conversation that had already bridged',
    ).toHaveLength(0);
  });
});

// ─── AD-P4-C-01: the durable mirror the supervisor breakdown reads ──────────

describe('AD-P4-C-01: `on_call` reaches the durable mirror', () => {
  it('mirrors on_call to agency_agent_sessions when the bridge joins', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const bridge = fakeBridge({ answerDuringDial: true });
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    bridge.createBridgedCall.mockImplementation(async () => {
      for (const l of bridge.listeners) l({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
      return { id: 'call-1' } as any;
    });

    await dialer.executeDial(makeCmd('s1'));

    // Redis stays authoritative and `rehydrateAgent` still never reads this row.
    // The mirror exists so the supervisor's agents-by-state breakdown can see the
    // state AT ALL: before this, nothing wrote `on_call` here, so an agent on a live
    // call was reported as whatever they were mirrored to last — `available`. The
    // dashboard showed idle agents while they were talking to customers, and the
    // single `agents_live` count only dodged it by not distinguishing states.
    expect(repos.session.setState).toHaveBeenCalledWith('s1', 'on_call');
  });

  it('a failed mirror does not fail the call', async () => {
    const stations = new StationRegistry(null, '', 'r1');
    const agents = reservedAgents();
    const bridge = fakeBridge({ answerDuringDial: true });
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
    dialer.start();

    const ws = fakeWs();
    await attachStation(stations, 's1', ws);
    repos.session.setState.mockRejectedValueOnce(new Error('pg down'));
    bridge.createBridgedCall.mockImplementation(async () => {
      for (const l of bridge.listeners) l({ callId: 'call-1', correlationId: 'att-1', phase: 'bridged', answered: true });
      return { id: 'call-1' } as any;
    });

    // A live conversation must not be torn down because a dashboard column could
    // not be written. The mirror is best-effort by construction.
    await expect(dialer.executeDial(makeCmd('s1'))).resolves.not.toThrow();
    expect(ws.sent.map((f) => f.event)).toContain('bridged');
  });
});
