import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// LATE BINDING — attach the agent at the carrier ANSWER, not before the dial
// (`FF_AGENCY_LATE_BINDING`, pilot 2026-09-08).
//
// The product fault these cases pin: the console showed the agent every ringing,
// voicemail-bound and switched-off dial, and agents dismissed them. On VoiceLink
// dismissing one silently cancels nothing — traced end to end on callId
// `064836f1-8915-49f8-9c5a-c741f3cdd2af`, where the customer answered into an
// empty console 3s after the agent had hung up, and the call was billed.
//
// So the property under test is not "the bind happens later". It is:
//
//  * a dial that never connects reaches the console as NOTHING about the call —
//    no `reserved`, no `released`, no missed release, no resumable panel;
//  * a dial that DOES connect still puts `reserved` on the wire before
//    `bridged`, inside a single synchronous turn, because the abandonment
//    predicate gives the whole bind path 1000ms from the answer.
//
// The bridge double therefore emits `bridged` synchronously from inside
// `bindBorrowedBrowserLeg`, exactly as `emitBridgedIfLive` does. That
// re-entrancy — the `bridged` handler running to its first await INSIDE the
// `answered` arm — is the mechanism that orders the two frames, so a double that
// deferred it would test an implementation nobody ships.
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

/**
 * The flag, flipped per test.
 *
 * Keyed on `flag.key` rather than answering `true` to anything: a second flag
 * read added to `executeDial` later must not be silently served the
 * late-binding answer by this double.
 */
const { flags, rows, gate } = vi.hoisted(() => ({
  /**
   * Parks the NEXT `bridged` attempt write, so a test can stage the late-`bridged` race
   * on the statement it is actually about.
   *
   * This used to be staged by holding `agents.set` open, which worked only
   * because the `bridged` write sat behind it. It no longer does — the compliance
   * write was moved ahead of both agent-state writes precisely so a process death
   * in that window cannot lose `bridged_at`. Parking `agents.set` now proves
   * nothing about this race, so the gate lives on the write itself: more direct,
   * and immune to the ordering of everything around it.
   */
  gate: { bridged: null as Promise<void> | null },
  flags: { lateBinding: false },
  rows: { current: null as any },
}));

vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    isEnabled: async (flag: { key?: string }) => flag?.key === 'agency_late_binding' && flags.lateBinding,
    getValue: async () => 1800,
  }),
  FLAGS: {
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
    webrtc_max_duration_seconds: { key: 'webrtc_max_duration_seconds', type: 'number', default: 1800 },
  },
}));

/**
 * `setState` over an in-memory ROW, not a bare spy.
 *
 * The late-`bridged` race is a question about what the row ends up holding after two writes
 * race, so asserting on call arguments would pin the call and not the defect —
 * an `only_from` list that named the wrong states would pass such a test. This
 * reproduces the statement's semantics from `agency.repository.ts`: `state` is a
 * CASE guarded by `only_from`, every other column is `COALESCE($n, column)`, so a
 * non-null argument wins and a null one leaves the stored value alone.
 */
const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      setState: vi.fn(async (_id: string, state: string, patch: Record<string, unknown> = {}) => {
        // Held BEFORE the row is read, so `only_from` is evaluated against the row
        // as it stands when the statement finally runs — which is the whole
        // semantics under test.
        if (state === 'bridged' && gate.bridged) {
          const g = gate.bridged;
          gate.bridged = null;
          await g;
        }
        const row = rows.current;
        const onlyFrom = patch.only_from as string[] | undefined;
        if (!onlyFrom || onlyFrom.includes(row.state)) row.state = state;
        for (const col of ['outcome', 'dialed_at', 'answered_at', 'bridged_at', 'ended_at', 'talk_seconds']) {
          if (patch[col] !== undefined && patch[col] !== null) row[col] = patch[col];
        }
        return { ...row };
      }),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      unclaim: vi.fn().mockResolvedValue(undefined),
      markState: vi.fn().mockResolvedValue(undefined),
      chargeAttempt: vi.fn().mockResolvedValue(1),
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
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
import { AGENCY_ATTEMPT_LIVE_STATES } from '../../../src/db/models/agency.model.js';
import { DEFERRED_HANGUP_MS } from '@magick-agency/domain/timers';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false),
    cancel: vi.fn(),
    force: vi.fn(async () => false),
    stateFor: vi.fn(() => null),
    noteDisposition: vi.fn(async () => false),
    stop: vi.fn(),
    active: vi.fn(() => 0),
  };
}

function fakeBreaks() {
  return {
    queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null),
    cancel: vi.fn(), size: vi.fn(() => 0),
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

/** A promise the test resolves, for holding a handler open mid-flight. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let every already-queued microtask/continuation run. */
async function settle(turns = 6) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

/**
 * Bridge double.
 *
 * `bindBorrowedBrowserLeg` emits `bridged` synchronously, like the real one — see
 * the header. `bindSucceeds` models the refusals the real bind can return
 * (an ending call, a closed socket, an already-bound leg), all of which mean the
 * same thing to the dialer: a customer on the line with no agent.
 */
function fakeBridge(opts: { bindSucceeds?: boolean } = {}) {
  const listeners: Array<(e: any) => void> = [];
  const bridge = {
    listeners,
    bound: [] as Array<{ correlationId: string; ws: unknown }>,
    onLifecycle(fn: (e: any) => void) { listeners.push(fn); return () => { /* noop */ }; },
    // Params typed so `mock.calls[0][0]` is inspectable — the absence of
    // `browserSocket` on the unbound dial is the assertion, and an untyped double
    // gives it an empty tuple type.
    createBridgedCall: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'call-1' } as any)),
    createUnboundBridgedCall: vi.fn(async (_params: Record<string, unknown>) => ({ id: 'call-1' } as any)),
    bindBorrowedBrowserLeg: vi.fn((correlationId: string, ws: unknown) => {
      if (opts.bindSucceeds === false) return false;
      bridge.bound.push({ correlationId, ws });
      for (const l of listeners) l({ callId: 'call-1', correlationId, phase: 'bridged', answered: true });
      return true;
    }),
    reattachBorrowedBrowserLeg: vi.fn(() => true),
    // Emits `ended` like the real one: `forceEndWithOutcome` reaches `endCall`,
    // which emits the terminal lifecycle event. Faithful here because the
    // `released` frame an abandoned call owes its agent is sent by the `ended`
    // arm, so a double that swallowed the event could not show it at all.
    forceEndWithOutcome: vi.fn(async (correlationId: string, outcome: string) => {
      for (const l of listeners) {
        l({ callId: 'call-1', correlationId, phase: 'ended', status: 'completed', outcome, answered: true });
      }
      return true;
    }),
    playClipToCarrierThenHangUp: vi.fn(async () => true),
    emit(ev: any) { for (const l of listeners) l(ev); },
  };
  return bridge;
}

// No `abandon_announcement_id`, so `resolveAbandonClip` short-circuits to
// `not_configured` without a DB read and the abandoned path hangs up bare.
const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
} as any;

const CONTACT = {
  id: 'contact-1', phone_e164: '+919876543210',
  context: { 'First Name': 'Asha', 'Policy No': 'X-1' }, attempt_count: 0,
} as any;

function makeCmd(sessionId = 's1'): DialCommand {
  return {
    attemptId: 'att-1', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId, ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN, contact: CONTACT,
  };
}

/**
 * A registry that reports the reservation as still held. A bare
 * `AgentStateMachine` with no Redis fails its CAS closed, which would abort
 * every dial below and turn each case into an agent-lease test.
 */
function reservedAgents(): AgentStateMachine {
  const agents = new AgentStateMachine(null, '');
  vi.spyOn(agents, 'transition').mockResolvedValue(true);
  vi.spyOn(agents, 'set').mockResolvedValue(undefined as any);
  vi.spyOn(agents, 'renew').mockResolvedValue(true);
  return agents;
}

async function harness(opts: { lateBinding: boolean; bindSucceeds?: boolean } = { lateBinding: true }) {
  flags.lateBinding = opts.lateBinding;
  const stations = new StationRegistry(null, '', 'r1');
  const agents = reservedAgents();
  const bridge = fakeBridge({ bindSucceeds: opts.bindSucceeds });
  const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, fakeBreaks() as any);
  dialer.start();
  const ws = fakeWs();
  await stations.attach({
    sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
    agentUserId: 'user-1', ws: ws as any,
  });
  return { stations, agents, bridge, dialer, ws };
}

/** Frames the console received, by event name. */
function events(ws: { sent: any[] }): string[] {
  return ws.sent.map((f) => f.event);
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.lateBinding = false;
  // A test that threw between arming the gate and resolving it would otherwise
  // park the next test's `bridged` write forever, failing it somewhere unrelated.
  gate.bridged = null;
  rows.current = {
    state: 'queued', outcome: null, dialed_at: null,
    answered_at: null, bridged_at: null, ended_at: null, talk_seconds: null,
  };
});

// ─── The dial ───────────────────────────────────────────────────────────────

describe('late binding: the dial', () => {
  it('places the leg with NO browser socket and shows the agent nothing', async () => {
    const h = await harness({ lateBinding: true });

    await h.dialer.executeDial(makeCmd());

    // The unbound creation mode, and only it: `createBridgedCall` attaches the
    // socket before the dial, which is the behaviour being turned off.
    expect(h.bridge.createUnboundBridgedCall).toHaveBeenCalledTimes(1);
    expect(h.bridge.createBridgedCall).not.toHaveBeenCalled();
    // No socket anywhere in the params — `placeOutboundLeg` keys the browser
    // token on `borrowedBrowserLeg`, but a socket smuggled in here would still be
    // relayed to during the ring.
    expect(h.bridge.createUnboundBridgedCall.mock.calls[0]?.[0]).not.toHaveProperty('browserSocket');
    // The whole point: the phone is ringing and the console is idle.
    expect(events(h.ws)).toEqual([]);
    // The attempt is still `dialing` in the row, and still registered as live —
    // late binding hides the call from the AGENT, not from the platform.
    expect(rows.current.state).toBe('dialing');
    expect(h.dialer.hasLiveAttempt('s1')).toBe(true);
  });

  it('still refuses to dial when the agent went away first', async () => {
    // The pre-flight the bridge no longer does for us. Late binding cannot
    // un-ring a phone, so a dial for an agent who has already gone is the same
    // manufactured abandoned call reserve-before-dial exists to prevent.
    const h = await harness({ lateBinding: true });
    await h.stations.detach('s1');

    await h.dialer.executeDial(makeCmd());

    expect(h.bridge.createUnboundBridgedCall).not.toHaveBeenCalled();
    expect(rows.current.state).toBe('ended');
    expect(rows.current.outcome).toBe('orphaned');
  });

  it('sends no `released` for a dial abandoned before it was placed', async () => {
    // `abandonBeforeDial(…, notifyAgent: false)`. The agent was never shown a
    // panel, so there is nothing for a release to explain — and the socket is
    // usually gone anyway, which is why this was invisible before the parameter
    // existed.
    const h = await harness({ lateBinding: true });
    vi.spyOn(h.agents, 'transition').mockResolvedValue(false); // lost the lease

    await h.dialer.executeDial(makeCmd());

    expect(events(h.ws)).not.toContain('released');
    expect(events(h.ws)).not.toContain('reserved');
  });
});

// ─── A dial that never connects ─────────────────────────────────────────────

describe('late binding: a dial that rings out', () => {
  it('reaches the console with nothing about the call on it', async () => {
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'no_answer', answered: false,
    });
    await settle();

    // No panel, no release, and nothing held for the next connect. Before this
    // change the agent got `reserved` at the dial and then "Nobody answered." —
    // the popup they spent the pilot dismissing.
    expect(events(h.ws)).not.toContain('reserved');
    expect(events(h.ws)).not.toContain('released');
    expect(events(h.ws)).not.toContain('bridged');
    expect(h.dialer.takeMissedRelease('s1')).toBeNull();

    // What DOES arrive is the idle-state refresh from `releaseAgent` — the agent
    // going back into the pool, which is a fact about the agent and not about the
    // call. It carries no `attempt_id`, and it must keep being sent: it is the
    // frame that delivers a break the agent queued mid-ring.
    expect(events(h.ws)).toEqual(['agent_state']);
    expect(h.ws.sent[0]).toMatchObject({ event: 'agent_state', state: 'available' });
    expect(h.ws.sent.some((f) => 'attempt_id' in f)).toBe(false);
  });

  it('settles the row and releases the contact exactly as before', async () => {
    // The suppression is agent-facing ONLY. A change that also stopped settling
    // the attempt would strand the contact and hold the concurrency slot until
    // the reaper noticed.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'no_answer', answered: false,
    });
    await settle();

    expect(rows.current.state).toBe('ended');
    expect(rows.current.outcome).toBe('no_answer');
    expect(rows.current.ended_at).toBeInstanceOf(Date);
    expect(repos.contact.chargeAttempt).toHaveBeenCalledWith('contact-1', 'no_answer');
    expect(h.dialer.hasLiveAttempt('s1')).toBe(false);
  });

  it('is still announced under early binding — the suppression is flag-gated', async () => {
    // The contrast that makes this a flag and not a deletion. With the flag off
    // the agent was shown the call, so they are owed the explanation for it
    // clearing.
    const h = await harness({ lateBinding: false });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'no_answer', answered: false,
    });
    await settle();

    expect(events(h.ws)).toEqual(['reserved', 'released', 'agent_state']);
    expect(h.bridge.createBridgedCall).toHaveBeenCalledTimes(1);
    expect(h.bridge.createUnboundBridgedCall).not.toHaveBeenCalled();
  });
});

// ─── The answer ─────────────────────────────────────────────────────────────

describe('late binding: the carrier answers', () => {
  it('puts `reserved` then `bridged` on the wire, in that order, in one turn', async () => {
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());
    expect(events(h.ws)).toEqual([]);

    // Synchronous emission, deliberately: the ordering claim is about ONE turn.
    // Nothing is awaited between this line and the assertions below, so a `reserved`
    // sent from a continuation — or after the `answered` DB write — reds here.
    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date('2026-09-08T10:36:12.440Z'),
    });

    expect(events(h.ws)).toEqual(['reserved', 'bridged']);
    // The panel is the one built at dial time, contact context and all.
    expect(h.ws.sent[0].attempt).toMatchObject({
      attempt_id: 'att-1',
      phone_e164: '+919876543210',
      context: { 'First Name': 'Asha', 'Policy No': 'X-1' },
      prior_attempts: [],
    });
  });

  it('binds the socket the panel was sent to, keyed on the attempt id', async () => {
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    // The attempt id, not the call id: the answer can precede the dial's own
    // resolution, so a call-id-keyed bind is unreachable in the window that
    // matters.
    expect(h.bridge.bindBorrowedBrowserLeg).toHaveBeenCalledWith('att-1', h.ws);
    // Announcing to one socket and relaying another's audio is the failure the
    // registry's third argument exists to prevent.
    expect(h.bridge.bound).toEqual([{ correlationId: 'att-1', ws: h.ws }]);
  });

  it('records answered_at and bridged_at from the two phases, not from one', async () => {
    // The abandonment predicate is `answered_at IS NOT NULL AND bridged_at IS
    // NULL`, so collapsing the two instants makes it vacuous. Late binding puts
    // both writes in one turn, which is exactly where that collapse would hide.
    const answeredAt = new Date('2026-09-08T10:36:12.440Z');
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true, answeredAt });
    await settle();

    expect(rows.current.answered_at).toEqual(answeredAt);
    expect(rows.current.bridged_at).toBeInstanceOf(Date);
    expect(rows.current.bridged_at).not.toEqual(answeredAt);
    expect(rows.current.state).toBe('bridged');
  });

  // ── The pre-bind grace: a station that drops mid-ring must not become an
  //    ABANDONED call ────────────────────────────────────────────────────────
  //
  // `releaseStationOnClose` declines to act mid-attempt because "the deferred
  // hangup now owns the outcome" — but that hangup is installed on the BROWSER
  // socket, and an unbound dial has none. So before this grace existed, a station
  // blip during the ring let the dial run to the carrier's answer, fail the bind,
  // and record an `abandoned` attempt against the 3% ceiling — while the identical
  // blip under early binding produced a harmless `canceled`. Late binding would
  // have shipped an abandonment source of its own, against its own hardest
  // constraint.
  describe('a station that drops while an unannounced dial is ringing', () => {
    it('ends the dial as agent_disconnected once the grace lapses', async () => {
      vi.useFakeTimers();
      try {
        const h = await harness({ lateBinding: true });
        await h.dialer.executeDial(makeCmd());

        h.dialer.noteStationClosed('s1');

        // Nothing happens early — the window is the whole point.
        await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS - 1);
        expect(h.bridge.forceEndWithOutcome).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(2);
        // `agent_disconnected` is what BOTH dial paths declare as
        // `browserHangupOutcome`, so the two binding modes record the same fact.
        // The attempt outcome is `agent_disconnected` as well — that arm
        // short-circuits ahead of the status switch, so it does not become
        // `canceled` (an earlier comment here said it did). What matters is the
        // ledger, and `ourFaultBeforeBridge` names both: our-fault, never
        // `abandoned`.
        expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'agent_disconnected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves NO live attempt behind — which is the thing the grace guarantees', async () => {
      // ── This replaces a test that could not fail ─────────────────────────
      //
      // The previous version waited PAST the grace and then emitted `answered`,
      // asserting no abandonment. That is a no-op on every path, grace or not:
      // `forceEndWithOutcome` has already deleted `liveByAttempt` by then (the
      // double emits `ended`), and a late `answered` on a settled attempt does
      // nothing anywhere. Removing the timer would not have turned it red — the
      // second vacuous test in this PR, on the same fix.
      //
      // What the grace actually guarantees is narrower and checkable: an unbound
      // dial whose station stays gone does not run UNBOUNDED. Before the fix
      // nothing was watching at all — no `hangUpForBrowserClose` is installed on
      // an unbound dial — so the attempt stayed live until the carrier answered,
      // however long that took. So the assertion is on liveness, and it is
      // discriminating: without the timer the attempt is still live here.
      // Fake timers, not an 8-second real sleep. The first version of this slept
      // `DEFERRED_HANGUP_MS` for real, which adds 8s to the unit suite and makes it
      // fragile on a loaded CI container for no coverage — the window's LENGTH is
      // not what is under test here, its existence is. Safe under fake timers
      // because this case never emits `answered`, so nothing on the awaited answer
      // path can be stranded by them.
      vi.useFakeTimers();
      try {
        const h = await harness({ lateBinding: true });
        await h.dialer.executeDial(makeCmd());
        expect(h.dialer.hasLiveAttempt('s1')).toBe(true);

        await h.stations.detach('s1');
        h.dialer.noteStationClosed('s1');
        await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS + 20);

        expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'agent_disconnected');
        expect(h.dialer.hasLiveAttempt('s1')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT change answer-in-window abandonment, which is symmetric with early binding', async () => {
      // ── Stated as a test because it is a real limit, not an oversight ─────
      //
      // A pickup INSIDE the grace still abandons: a customer answered and no agent
      // was there, so the apology clip plays and the attempt counts against the 3%
      // ceiling. That is the REQUIRED behaviour — under-counting it would be the
      // same class of error as the `bridged`-vs-`answered` mislabel this PR fixes.
      //
      // It is also not new to late binding, which is why the grace matches
      // `DEFERRED_HANGUP_MS` rather than being shortened. Under EARLY binding a
      // station close arms the bridge's own `armBrowserLegGrace` with the very
      // same window, holding the dial live with a detached browser leg — so a
      // pickup there reaches `lostTheAgent` and abandons identically. Shortening
      // the pre-bind grace would make the two modes diverge and would throw away
      // the reconnect window early binding deliberately has.
      //
      // Asserted for BOTH modes in one test, because the claim is the symmetry.
      for (const lateBinding of [true, false]) {
        vi.clearAllMocks();
        const h = await harness({ lateBinding });
        await h.dialer.executeDial(makeCmd());

        await h.stations.detach('s1');
        h.dialer.noteStationClosed('s1');
        // Well inside the window — the attempt is still live in both modes.
        expect(h.dialer.hasLiveAttempt('s1'), `lateBinding=${lateBinding}`).toBe(true);

        h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
        await settle();

        expect(h.bridge.forceEndWithOutcome, `lateBinding=${lateBinding}`)
          .toHaveBeenCalledWith('att-1', 'abandoned');
      }
    });

    it('does not slide the deadline when a second observer reports the same loss', async () => {
      // Two callers see one loss: the socket's `close` handler and
      // `sweepSilentStations`, which is the only thing that notices a socket that
      // died without a close frame. Re-arming on the second would push the
      // deadline out — the one behaviour a window meant to BOUND the wait must not
      // have, and an unbounded slide if the sweep keeps firing.
      vi.useFakeTimers();
      try {
        const h = await harness({ lateBinding: true });
        await h.dialer.executeDial(makeCmd());

        h.dialer.noteStationClosed('s1');
        await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS - 100);
        // A second report, 100ms before the deadline.
        h.dialer.noteStationClosed('s1');
        await vi.advanceTimersByTimeAsync(200);

        // Fired on the ORIGINAL deadline, not 8s after the second report.
        expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'agent_disconnected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('is disarmed by a reconnect, so a brief blip still gets the call', async () => {
      vi.useFakeTimers();
      try {
        const h = await harness({ lateBinding: true });
        await h.dialer.executeDial(makeCmd());

        h.dialer.noteStationClosed('s1');
        // The agent's socket comes back inside the window. `reattachStation` is
        // reached on every station attach and returns `null` for an unannounced
        // attempt — the disarm is its other job.
        expect(h.dialer.reattachStation('s1', h.ws as never)).toBeNull();
        await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS * 2);

        expect(h.bridge.forceEndWithOutcome).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('and the reconnected socket still gets the call at the answer', async () => {
      // The other half of the disarm, on real timers because the answer path awaits
      // repository work that fake timers would strand. This is the self-healing an
      // immediate hangup would have destroyed, and the reason the fix is a timer:
      // the `answered` arm reads `socketFor` FRESH, so whatever socket the registry
      // holds by then is the one that gets bound.
      const h = await harness({ lateBinding: true });
      await h.dialer.executeDial(makeCmd());

      h.dialer.noteStationClosed('s1');
      expect(h.dialer.reattachStation('s1', h.ws as never)).toBeNull();

      h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
      await settle();

      expect(h.bridge.bindBorrowedBrowserLeg).toHaveBeenCalledWith('att-1', h.ws);
      expect(h.bridge.forceEndWithOutcome).not.toHaveBeenCalledWith('att-1', 'abandoned');
    });

    it('does nothing for an ANNOUNCED attempt — the bridge owns that one', async () => {
      vi.useFakeTimers();
      try {
        // Early binding: the browser leg is bound from the dial, so
        // `hangUpForBrowserClose` is installed and this timer must stay out of it.
        const h = await harness({ lateBinding: false });
        await h.dialer.executeDial(makeCmd());

        h.dialer.noteStationClosed('s1');
        await vi.advanceTimersByTimeAsync(DEFERRED_HANGUP_MS * 2);

        expect(h.bridge.forceEndWithOutcome).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('abandons the call when the agent went away during the ring', async () => {
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());
    await h.stations.detach('s1');

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    // No panel is sent to a socket that is gone, and no bind is attempted.
    expect(h.bridge.bindBorrowedBrowserLeg).not.toHaveBeenCalled();
    expect(events(h.ws)).toEqual([]);
    // A real customer is on the line: they get the apology-then-hangup path, and
    // the answer is still counted in the compliance denominator by the row write.
    expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'abandoned');
    expect(rows.current.answered_at).toBeInstanceOf(Date);
  });

  it('abandons the call when the bind itself is refused', async () => {
    // The bind can refuse a socket that closed between the registry read and the
    // attach, an ending call, or a second bind. All of them mean the same thing
    // and none of them may leave the customer on an open line.
    const h = await harness({ lateBinding: true, bindSucceeds: false });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'abandoned');
  });

  // ── The pair that proves `panelDelivered` asks the right question ──────────
  //
  // These two cases differ ONLY in whether the `reserved` frame made it to the
  // console before the bind was refused, and they need opposite endings. The
  // predicate that decides is `isUnannounced`, which asks "has the agent seen
  // this call" — not "did this call bridge". Set `panelDelivered` from the bind
  // instead of the send and the first of these reds: the panel is on screen, the
  // `released` is suppressed as if nothing had been announced, and the agent is
  // left on a contact card for a call they never heard and are never told about
  // — the pilot debrief's "connected but silent" complaint, manufactured by the
  // fix for it.
  it('clears the panel it already delivered when the bind is then refused', async () => {
    const h = await harness({ lateBinding: true, bindSucceeds: false });
    await h.dialer.executeDial(makeCmd());

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    // The panel WAS sent — the send is what the agent saw, and it succeeded.
    expect(events(h.ws)).toEqual(['reserved', 'released', 'agent_state']);
    // …and the release is true of the case: answered, never connected to them.
    expect(h.ws.sent[1]).toMatchObject({
      event: 'released',
      attempt_id: 'att-1',
      reason: 'abandoned',
      message: 'The call was answered but could not be connected to you.',
    });
  });

  it('says nothing at all when the agent was already gone — no panel, no release', async () => {
    // Same refused bind from the dialer's point of view, opposite ending: there
    // was no socket to send the panel to, so there is nothing to clear.
    const h = await harness({ lateBinding: true, bindSucceeds: false });
    await h.dialer.executeDial(makeCmd());
    await h.stations.detach('s1');

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    expect(events(h.ws)).toEqual([]);
    expect(h.bridge.forceEndWithOutcome).toHaveBeenCalledWith('att-1', 'abandoned');
  });

  it('reports an unbound-but-announced attempt as ANNOUNCED to the leave route', async () => {
    // The third reader of the predicate. An agent looking at a panel must be told
    // to finish or hang up the call they can see, not that one is being placed.
    const h = await harness({ lateBinding: true, bindSucceeds: false });
    await h.dialer.executeDial(makeCmd());
    expect(h.dialer.hasUnannouncedAttempt('s1')).toBe(true);

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });

    // Read synchronously, before the abandoned teardown settles the attempt: the
    // window this is wrong in is exactly the window the agent is staring at the
    // orphaned panel.
    expect(h.dialer.hasUnannouncedAttempt('s1')).toBe(false);
    await settle();
  });

  it('tells the leave route the dial is unannounced only until it binds', async () => {
    // `POST /sessions/:id/leave` refuses either way; this is what decides whether
    // the refusal talks about a call being placed or one to hang up.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    expect(h.dialer.hasUnannouncedAttempt('s1')).toBe(true);

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    expect(h.dialer.hasUnannouncedAttempt('s1')).toBe(false);
    expect(h.dialer.hasLiveAttempt('s1')).toBe(true);
  });
});

// ─── Reconnect during the ring ──────────────────────────────────────────────

describe('late binding: a station that reconnects mid-ring', () => {
  it('is not handed the ringing attempt, and the bridge is not asked', async () => {
    // The reconnect-shaped door into the popup this change removes: a resumed
    // `AgencyActiveAttempt` with `state: 'dialing'` renders the ringing panel
    // from the resume path instead of the dial one.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    const fresh = fakeWs();
    expect(h.dialer.reattachStation('s1', fresh as any)).toBeNull();
    // Not merely refused by the bridge — never asked. `reattachBorrowedBrowserLeg`
    // would also return false, at WARN, for what is an ordinary event on this
    // cohort.
    expect(h.bridge.reattachBorrowedBrowserLeg).not.toHaveBeenCalled();
  });

  it('loses the agent nothing — the answer binds whatever socket is registered', async () => {
    // Why returning null is correct rather than a lost reconnection: the
    // `answered` arm reads the registry fresh, so the replacement socket is the
    // one that gets bound.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());

    const fresh = fakeWs();
    await h.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: fresh as any,
    });
    h.dialer.reattachStation('s1', fresh as any);

    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    expect(h.bridge.bindBorrowedBrowserLeg).toHaveBeenCalledWith('att-1', fresh);
    expect(events(fresh)).toEqual(['reserved', 'bridged']);
    // …and the socket that dropped is never written to.
    expect(events(h.ws)).toEqual([]);
  });

  it('still resumes an attempt that HAS been bound', async () => {
    // The deferred-hangup window is untouched for a call the agent
    // was actually on — the suppression is about attempts they never saw.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());
    h.bridge.emit({ callId: 'call-1', correlationId: 'att-1', phase: 'answered', answered: true });
    await settle();

    const fresh = fakeWs();
    const resumed = h.dialer.reattachStation('s1', fresh as any);

    expect(h.bridge.reattachBorrowedBrowserLeg).toHaveBeenCalledWith('att-1', fresh);
    expect(resumed).toMatchObject({ attempt_id: 'att-1', state: 'bridged' });
    expect(resumed?.bridged_at).not.toBeNull();
  });
});

// ─── late `bridged` write ────────────────────────────────────────────────────────────────

describe('a late `bridged` write cannot resurrect a settled attempt', () => {
  /**
   * The race, reproduced by its real mechanism rather than by event order.
   *
   * Lifecycle listeners are invoked fire-and-forget, so the `bridged` handler's
   * awaits (the agent lease, the durable `on_call` mirror) can still be pending
   * when the `ended` handler runs to completion — a customer who picks up and
   * immediately hangs up. The `bridged` row write then lands LAST, on a row that
   * already holds its real outcome and `ended_at`.
   *
   * Held open here on the agent-lease write, which is the first await in that
   * handler. Late binding is what makes this ordinary rather than rare: the bind
   * now happens inside the answer turn, right on top of it.
   */
  async function raceBridgedWriteAfterEnded(lateBinding: boolean) {
    const h = await harness({ lateBinding });
    await h.dialer.executeDial(makeCmd());

    const held = deferred<void>();
    gate.bridged = held.promise;

    // Answer → bind → `bridged` handler starts and parks on the lease write,
    // having already stamped `live.bridgedAt`.
    //
    // Both phases are emitted in ONE turn with no await between them, because
    // that is what the bridge does: under late binding `bindBorrowedBrowserLeg`
    // emits `bridged` from inside the `answered` listener, and under early
    // binding `handleProviderStart` calls `emitAnswered` and then
    // `emitBridgedIfLive` back to back. Awaiting in between would let the
    // `answered` arm's abandoned-call fence run before `live.state` had moved.
    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date('2026-09-08T10:36:12.440Z'),
    });
    if (!lateBinding) {
      h.bridge.emit({
        callId: 'call-1', correlationId: 'att-1', phase: 'bridged',
        answered: true, answeredAt: new Date('2026-09-08T10:36:12.440Z'),
      });
    }
    await settle();
    expect(rows.current.state).not.toBe('bridged'); // its write has not run yet

    // The call ends and settles completely while that write is still in flight.
    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'ended',
      status: 'completed', answered: true, talkTimeSeconds: 16,
    });
    await settle();
    const endedAt = rows.current.ended_at;
    expect(rows.current).toMatchObject({ state: 'ended', outcome: 'connected' });

    // Now the parked `bridged` write completes.
    held.resolve();
    await settle();
    return { ...h, endedAt };
  }

  it('keeps the compliance write LAST, because moving it first corrupts agent state', async () => {
    // ── A reorder that was tried, measured, and reverted ────────────────────
    //
    // `bridged_at` is the sole discriminator between a conversation and an
    // abandoned call, so review asked for its write to be moved ahead of the
    // agent-state writes: sitting last, a process death in that window loses it
    // and nothing retries, because the `bridged` phase fires once.
    //
    // It was moved, and it broke worse things. Dispatching that UPDATE first takes
    // a row lock on `agency_call_attempts` and a pool connection AHEAD of the
    // agent-state writes, which delays the durable `on_call` mirror enough that it
    // can land after a teardown has already written the agent away. Measured on
    // the chaos suite: `main` and this ordering are 3/3 green over
    // three full runs, both reordered variants (awaited, and issued-then-awaited)
    // failed 3/3 — `restart-mid-bridge` reporting `expected 'on_call' to be
    // 'offline'`, i.e. an agent left durably on a call that had ended, which the
    // pacing tick will never reserve again.
    //
    // So the trade is a rare lost `bridged_at` on an unclean shutdown against a
    // reproducible stuck agent, and this is the safer side of it. The durability
    // gap is real and is a known gap — closing it needs the mirror
    // write made order-safe (the agent-session mirror has no `only_from`), not a
    // reshuffle of these three statements.
    //
    // This test pins the ORDER so the reorder is not attempted a third time
    // without reading the note above.
    const h = await harness({ lateBinding: true });
    await h.dialer.executeDial(makeCmd());
    const agentsSet = vi.mocked(h.agents.set);
    agentsSet.mockClear();
    repos.attempt.setState.mockClear();
    repos.session.setState.mockClear();

    h.bridge.emit({
      callId: 'call-1', correlationId: 'att-1', phase: 'answered',
      answered: true, answeredAt: new Date('2026-09-08T10:36:12.440Z'),
    });
    await settle();

    // Both happened…
    expect(agentsSet).toHaveBeenCalledWith('s1', 'on_call', expect.anything());
    const bridgedWrite = repos.attempt.setState.mock.invocationCallOrder[
      repos.attempt.setState.mock.calls.findIndex((c: unknown[]) => c[1] === 'bridged')
    ];
    // …and the durable agent mirror was written BEFORE the attempt's `bridged`
    // row, which is the ordering the chaos suite requires.
    expect(repos.session.setState).toHaveBeenCalledWith('s1', 'on_call');
    expect(repos.session.setState.mock.invocationCallOrder[0]!).toBeLessThan(bridgedWrite!);
  });

  it('leaves the row `ended`, with its outcome and ended_at intact', async () => {
    const h = await raceBridgedWriteAfterEnded(true);

    // FALSIFICATION: drop `only_from` from the `bridged` write and `state` reads
    // `bridged` here, on a call that finished 16 seconds of conversation ago.
    expect(rows.current.state).toBe('ended');
    expect(rows.current.outcome).toBe('connected');
    expect(rows.current.ended_at).toBe(h.endedAt);
    expect(rows.current.talk_seconds).toBe(16);
  });

  it('still lands the bridged_at timestamp — the guard is on `state`, not the statement', async () => {
    // The half that makes `only_from` the right tool. `bridged_at` is one of the
    // two columns the SQL abandonment predicate reads, so a guard that dropped it
    // would relabel this bridged call abandoned — trading a wrong state for a
    // wrong compliance number.
    await raceBridgedWriteAfterEnded(true);

    expect(rows.current.bridged_at).toBeInstanceOf(Date);
    expect(rows.current.answered_at).toEqual(new Date('2026-09-08T10:36:12.440Z'));
  });

  it('leaves nothing for the reaper to find', async () => {
    // Criterion 3. Both reaper paths key on `state = ANY(live)`
    // (`findNonTerminalOlderThan`, then `reapByIds` re-guarded), so a row left
    // terminal is invisible to the sweep — and a resurrected one would be found
    // and stamped `orphaned` over a call that in fact connected. The same
    // vocabulary is what `agency_live_attempts_current` counts on, where a
    // resurrected attempt would be counted live forever.
    await raceBridgedWriteAfterEnded(true);

    expect(AGENCY_ATTEMPT_LIVE_STATES).not.toContain(rows.current.state);
  });

  it('holds under early binding too — the defect predates the flag', async () => {
    // The late-`bridged` race is not a late-binding bug; late binding is what makes it likely.
    const h = await raceBridgedWriteAfterEnded(false);

    expect(rows.current.state).toBe('ended');
    expect(rows.current.ended_at).toBe(h.endedAt);
  });
});
