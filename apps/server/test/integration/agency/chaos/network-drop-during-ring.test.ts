import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * carries no carrier config; import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`).
 */
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';

// The DB pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

const {
  createChaosWorld, attempts, contactStates, agentSessionStates, releasedContact,
  mirroredAgentState,
  contactsWithConcurrentLiveAttempts, agentsWithConcurrentLiveAttempts,
  abandonedCount, assertAbandonmentPredicatesAgree, AGENT_DISCONNECT_OUTCOME,
} = await import('./harness.js');
const { DEFERRED_HANGUP_MS } = await import('@magick-agency/domain/timers');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── SCENARIO 4 — THE NETWORK DROPS DURING THE RING ────────────
 *
 * Previously blocked on the deferred-hangup work; now enabled. The moment under test is the
 * narrowest one in the whole feature: the customer's phone is ringing, the
 * carrier has not answered, and the agent's wifi goes away. Nothing has been
 * said, nobody is in conversation, and the attempt exists only as a `dialing`
 * row and an in-memory bridge session.
 *
 * ── Why this is a scenario and not a unit test ──────────────────────────────
 *
 * `presence-resilience.test.ts` covers the dialer's own reaction with a fake
 * bridge and no database. What only exists at this tier is the **composition**:
 * the attempt row's terminal state, the contact returning to the roster, the
 * agent's lease surviving a socket that is gone, and — the one that matters most
 * — the pacing engine's opinion of that agent on the very next tick. Three
 * separate mechanisms have to agree, and every one of them is reached through
 * Redis or Postgres.
 *
 * ── The pair, asserted separately ──────────────────────────────────────────
 *
 * is explicit that the expected end state is a **pair** the 8s window makes
 * distinct, and that asserting one proves neither:
 *
 *   - **inside the window** — the same session re-attaching re-adopts the attempt;
 *   - **past the window** — the attempt settles `agent_disconnected` and the
 *     contact is requeued.
 *
 * They are two cases below, deliberately not one parameterised case: a single
 * case that took a branch on elapsed time would make which branch ran a property
 * of the box's load. The window is driven explicitly (`bridge.expireGrace`) for
 * the same reason nothing else in this suite sleeps.
 *
 * ── `T-B7`'s warning, which applies here directly ──────────────────────────
 *
 * The supersession guard at `webrtc-bridge-manager.ts` (`session.browserWs
 * !== ws`) is **not** the window. It decides which of two *simultaneously open*
 * sockets owns a call; it says nothing about a socket that is simply gone, which
 * is every real network drop. A scenario that conflated them would pass with the
 * wifi-blip requirement unimplemented — so the window is asserted by the value
 * the dialer asked for (`graceMsFor`) and by the armed flag, not by inference
 * from a call that happened to survive.
 */

describe('network drop during the ring (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  /**
   * One agent, one contact, parked **mid-ring**.
   *
   * The preconditions are asserted rather than assumed, and that is not
   * ceremony: the first draft passed because the pool was fully occupied for
   * reasons unrelated to the chaos. Here the equivalent trap is a call that
   * quietly answered — every assertion below about a mid-ring drop would then be
   * describing an ordinary connected call, and the scenario would prove nothing
   * while reading as though it proved everything.
   */
  async function ringingAttempt() {
    world = await createChaosWorld({ agents: 1, contacts: 3, maxConcurrentCalls: 1 });
    world.bridge.setDefaultScript({ answer: false, bridge: false, status: 'no_answer', holdAtRing: true });
    await world.bringOnline(world.agents[0]!);
    await world.tick();

    const rows = await attempts(world.campaignId);
    expect(rows, 'the tick dialed nothing — there is no ring to drop').toHaveLength(1);
    const attempt = rows[0]!;
    // STILL RINGING: `dialing`, and no answer instant. If either of these moved,
    // `holdAtRing` is not parking the call and the rest of this file is measuring
    // the ordinary bridged path.
    expect(attempt.state, 'the parked call did not stay in `dialing`').toBe('dialing');
    expect(attempt.answered_at, 'the parked call answered — this is not a mid-ring drop').toBeNull();
    expect(attempt.bridged_at).toBeNull();
    expect(world.bridge.ringingCount(), 'nothing is parked mid-ring').toBe(1);
    // The agent is held by the reservation, which is what makes the drop
    // interesting: they own a customer who is about to be spoken to.
    expect((await world.agentState.get(world.agents[0]!.sessionId))?.state).toBe('reserved');

    return { w: world, sessionId: world.agents[0]!.sessionId, attempt };
  }

  it('the dialer asks for a re-attach window, and a mid-ring drop arms it rather than hanging up', async () => {
    const { w, sessionId, attempt } = await ringingAttempt();

    // The window the DIALER asked for, read from what it passed the bridge. This
    // is the assertion `T-B7` demands and the one the supersession guard cannot
    // satisfy: a dialer that stopped requesting a window would leave this 0 while
    // every "the call survived" assertion below still passed on the guard alone.
    expect(
      w.bridge.graceMsFor(attempt.id),
      'the dialer requested no re-attach window — the wifi-blip requirement is unimplemented',
    ).toBe(DEFERRED_HANGUP_MS);

    const drop = await w.chaos.dropStation(sessionId);
    expect(drop.attemptId).toBe(attempt.id);
    // Armed, not hung up. `false` here would mean the bridge ended the call the
    // instant the socket went — which would be hanging up immediately.
    expect(drop.graceArmed, 'the drop hung the call up instead of holding it').toBe(true);
    expect(w.bridge.graceArmedFor(attempt.id)).toBe(true);

    // `releaseStationOnClose` must REFUSE to write `offline`, because the deferred
    // hangup owns the outcome now. Writing it would clear the attempt binding,
    // fail the renewer's state-matched CAS, and lapse the one lease keeping a
    // second attempt off this agent.
    expect(drop.wroteOffline, 'the agent was written offline while an attempt was live').toBe(false);
    expect((await w.agentState.get(sessionId))?.state).toBe('reserved');
    expect((await w.agentState.get(sessionId))?.attemptId).toBe(attempt.id);

    // Postgres has not moved: the attempt is still `dialing`, the contact still
    // claimed. A drop is not an outcome.
    const during = (await attempts(w.campaignId))[0]!;
    expect(during.state).toBe('dialing');
    expect(during.outcome).toBeNull();
  });

  it('INSIDE the window, the same session re-attaching re-adopts the attempt — and can still be bridged', async () => {
    const { w, sessionId, attempt } = await ringingAttempt();
    const drop = await w.chaos.dropStation(sessionId);
    expect(drop.graceArmed).toBe(true);

    // A FRESH socket, as a reconnect really is. `reattachStation` is reached from a
    // socket the caller has just opened, and re-attaching the closed one would let
    // this pass against a bridge that resumed media onto a dead leg.
    const resumed = await w.chaos.reattachStation(sessionId);

    // Not merely non-null: the payload must name the attempt that was live. A
    // re-attach that returned *some* attempt would satisfy a null check while
    // handing the agent a different customer's call.
    expect(resumed, 'nothing was re-adopted inside the window').not.toBeNull();
    expect(resumed!.attempt_id).toBe(attempt.id);
    expect(resumed!.contact_id).toBe(attempt.contact_id);
    // Still ringing when it came back, so the console renders a dial in progress
    // rather than a conversation that never happened.
    expect(resumed!.bridged_at).toBeNull();
    expect(resumed!.state).toBe('dialing');

    // The window is DISARMED, or the call would still be hung up 8s later having
    // been successfully resumed — the defect a re-attach test that stopped at the
    // payload cannot see.
    expect(w.bridge.graceArmedFor(attempt.id), 'the re-attach left the deferred hangup armed').toBe(false);

    // And the resumed attempt is genuinely usable: the customer answers, media
    // bridges onto the NEW socket, and the call completes normally. A payload
    // describing a call nobody can hear is the structural-not-demonstrated gap.
    expect(await w.bridge.resumeRinging(attempt.id)).toBe(true);
    expect((await attempts(w.campaignId))[0]!.state).toBe('bridged');
    expect((await w.agentState.get(sessionId))?.state).toBe('on_call');

    await w.bridge.endHeld();
    await w.runUntilQuiescent();

    // Nothing was abandoned and nothing was double-dialed by the recovery.
    expect(await abandonedCount(w.campaignId)).toBe(0);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
  });

  it('PAST the window, the attempt settles agent_disconnected and the contact is requeued', async () => {
    const { w, sessionId, attempt } = await ringingAttempt();
    const drop = await w.chaos.dropStation(sessionId);
    expect(drop.graceArmed).toBe(true);

    // The window elapsing, driven rather than slept. `expireGrace` returns false
    // when nothing was armed, so this cannot silently become "there was never a
    // window" — which is the assertion shape that lets a re-attach test pass
    // against a bridge that held nothing.
    expect(await w.bridge.expireGrace(attempt.id), 'no window was running to expire').toBe(true);

    const settled = (await attempts(w.campaignId))[0]!;
    expect(settled.state).toBe('ended');
    // The outcome, against the constant the PRODUCT pins for agency calls rather
    // than a string written here twice.
    expect(settled.outcome).toBe(AGENT_DISCONNECT_OUTCOME);
    // Never answered, so no answer instant may have appeared — and the
    // abandonment predicate must therefore count this as zero. An
    // `agent_disconnected` on a ringing call is our fault but it is not an
    // abandoned call in the regulator's sense: nobody was ever on the line.
    expect(settled.answered_at).toBeNull();
    expect(settled.bridged_at).toBeNull();
    // the cross-check, both halves. An `agent_disconnected` on a ringing call is
    // our fault but it is NOT an abandoned call in the regulator's sense — nobody
    // was ever on the line — and this row is the sharpest test of that, because its
    // `bridged_at IS NULL` arm is true while its `answered_at IS NOT NULL` arm is
    // not. Agreement on zero plus the asserted value is the whole claim.
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(0);
    expect(await abandonedCount(w.campaignId)).toBe(0);

    // The contact left `in_flight` — nothing is stranded, which is the property
    // that keeps the campaign finishable. WHERE it went is a separate claim and it
    // is not what expects; see the standing case below.
    //
    // Barriered for the same reason is: this read has always been the same
    // race, and it passed only because the two queries above gave the contact write
    // time to land. Relying on that is relying on the box being slow.
    await releasedContact(settled.contact_id);
    const states = await contactStates(w.campaignId);
    expect(states['in_flight'] ?? 0).toBe(0);
    expect(states['connected'] ?? 0).toBe(0);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);

    // The agent is out of the pool, and never `available`: their socket is
    // gone and nothing has demonstrably re-attached.
    //
    // Barriered on the mirror for the same reason the contact read above is: the
    // `ended` chain reaches Postgres LAST, and `releaseAgent` writes Redis before
    // it, so reading the two in order lands between them.
    const live = await w.agentState.get(sessionId);
    expect(live?.state ?? 'offline').not.toBe('available');
    expect(await mirroredAgentState(sessionId)).not.toBe('available');
  });

  /**
   * ── RESOLVED by. The wrapper is gone; the test is not ──
   *
   * This stood as `it.fails` through two sessions. states the past-the-window
   * end state as *"the attempt settles `agent_disconnected` **and the contact is
   * requeued**"*. The first half always held; the second did not, because the
   * dialer marked every non-`connected` outcome `completed` with
   * `bump_attempt: true` — so an agent's wifi drop during the ring retired a
   * contact who was never answered AND spent one of that customer's
   * `max_attempts` on our own network fault.
   *
   * The inconsistency was the argument: `reaper.ts` requeues a crash-orphaned
   * contact with **no** bump, on the explicit product decision that *our crash
   * must not consume the customer's retry allowance*. Same category of fault,
   * opposite handling. The decision (2026-08-11) went the reaper's way.
   *
   * **Deliberately never relaxed to `expect(states['completed']).toBe(1)`.** That
   * relaxation was the trap it was written to avoid: it would have ratified the
   * defect as the contract and kept passing straight through this fix, quietly
   * deleting the requirement. Both assertions below are the ORIGINAL ones,
   * unchanged — only the `it.fails` wrapper was removed.
   *
   * What now satisfies it: an `agent_disconnected` outcome with `bridged_at IS
   * NULL` is charged to `agency_contacts.our_fault_attempts` instead of
   * `attempt_count`, and requeued `pending`. The redial is bounded separately by
   * `OUR_FAULT_REDIAL_BOUND`, so skipping the customer's allowance does not open
   * unbounded repeat-dialling of one number.
   *
   * Companion evidence that the requeue machinery itself is healthy is
   * `attempt-number-collision.test.ts`, where a reaper-requeued contact is redialed
   * with a derived, gapless `attempt_number` over five crash cycles.
   */
  it('past the window the contact is REQUEUED, not retired with an attempt spent', async () => {
    const { w, sessionId, attempt } = await ringingAttempt();
    await w.chaos.dropStation(sessionId);
    expect(await w.bridge.expireGrace(attempt.id)).toBe(true);

    // Through the barrier, not a bare SELECT. `expireGrace` returns when the
    // ATTEMPT row reads `ended`; the contact write is the second half of that pair
    // and is still in flight. Read directly, this case went red with
    // `expected 'in_flight' to be 'pending'` on a correct requeue — see
    // `releasedContact`.
    const contact = await releasedContact((await attempts(w.campaignId))[0]!.contact_id);
    // Both halves, and each is separately the requirement: back on the roster, and
    // the customer's allowance untouched by our fault.
    expect(contact.state, 'a never-answered contact was retired by an agent-side drop').toBe('pending');
    expect(contact.attempt_count, 'our network fault spent a customer attempt').toBe(0);
    // The ledger the requeue was charged to instead. Without this the pair above is
    // satisfied by a drop that was never accounted anywhere, which is the version of
    // this fix that redials one number forever.
    expect(contact.our_fault_attempts, 'the drop was requeued but charged to nothing').toBe(1);
  });

  /**
   * The inverse of case 2, and what stops case 2 from being satisfied by a system
   * that re-adopts unconditionally.
   *
   * **The title says which guard, because the two are not interchangeable and I got
   * this wrong first.** Once the terminal event has been absorbed the dialer has
   * already dropped the attempt from `liveByAttempt`, so `reattachStation` returns
   * `null` at its FIRST guard and never consults the bridge. Falsifying by stubbing
   * `reattachBorrowedBrowserLeg` to always return `true` reddened nothing — this
   * case was proving the dialer's bookkeeping while its prose claimed the bridge's
   * window check. The bridge arm is the case below.
   */
  it("a re-attach after the terminal event is refused by the DIALER's bookkeeping", async () => {
    const { w, sessionId, attempt } = await ringingAttempt();
    await w.chaos.dropStation(sessionId);
    expect(await w.bridge.expireGrace(attempt.id)).toBe(true);

    const late = await w.chaos.reattachStation(sessionId);
    expect(late, 'a late re-attach resurrected a settled attempt').toBeNull();

    // The settled row is untouched by the refused re-attach — no second terminal
    // write, no outcome rewritten.
    const after = (await attempts(w.campaignId))[0]!;
    expect(after.state).toBe('ended');
    expect(after.outcome).toBe(AGENT_DISCONNECT_OUTCOME);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
  });

  /**
   * The bridge's own refusal — `agency-dialer.ts`, the one guard the case above
   * cannot reach.
   *
   * The window lapses and the bridge's session dies, but the `ended` lifecycle
   * event has not been delivered yet. The dialer therefore still holds the attempt
   * and passes its first guard, so the bridge is the only thing standing between a
   * reconnecting agent and media resumed onto a dead call. That is a real
   * millisecond, and it is the millisecond the product comment names.
   *
   * Without this case the bridge's guard could be deleted with the suite green.
   */
  it("a re-attach racing the window's own expiry is refused by the BRIDGE", async () => {
    const { w, sessionId, attempt } = await ringingAttempt();
    await w.chaos.dropStation(sessionId);

    // Dead to the bridge, still live to the dialer.
    expect(w.bridge.lapseWindowSilently(attempt.id)).toBe(true);
    expect(
      (await attempts(w.campaignId))[0]!.state,
      'the terminal event landed after all — this no longer tests the race',
    ).toBe('dialing');

    const raced = await w.chaos.reattachStation(sessionId);
    expect(raced, 'media was resumed onto a call the bridge had already given up').toBeNull();
  });

  /**
   * the own regression, at the tier where it bit.
   *
   * The fix was to a bootstrap that seeded Redis from `agency_agent_sessions` —
   * and because `joinOrRehydrate` preserves any non-`offline` state, that row
   * genuinely can read `available`. An agent reloading their console mid-call had
   * `available` written over a live `on_call` lease **and the pacing tick reserved
   * them for a second customer while they were still talking to the first.**
   *
   * The unit tier pins `rehydrateAgent`'s return value. What it cannot show is the
   * consequence, which is the whole reason the bug mattered: question 2 —
   * *is the property true where it is consumed?* It is consumed by `tickOnce`, so
   * the assertion is on what the tick does, against a row deliberately made to
   * say `available`.
   */
  it('a mid-call reconnect cannot be reserved for a second customer, even with the row reading available', async () => {
    world = await createChaosWorld({ agents: 1, contacts: 4, maxConcurrentCalls: 2 });
    const w = world;
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', hold: true });
    await w.bringOnline(w.agents[0]!);
    const sessionId = w.agents[0]!.sessionId;

    await w.tick();
    const first = (await attempts(w.campaignId))[0]!;
    expect(first.state).toBe('bridged');
    expect((await w.agentState.get(sessionId))?.state).toBe('on_call');

    // The durable row made to say `available` while the agent is demonstrably
    // `on_call`. This is the faithful restart/reload signature, not a contrivance:
    // it is what the mirror holds whenever the last state written was `available`
    // and the `on_call` mirror write has not landed, and it is exactly the value
    // the old bootstrap trusted.
    await getTestPool().query(
      `UPDATE agency_agent_sessions SET state = 'available' WHERE id = $1`, [sessionId],
    );
    expect((await agentSessionStates(w.campaignId))[sessionId]).toBe('available');

    // The console reconnects — the path `POST /sessions` now takes.
    const rehydrated = await w.runtime.rehydrateAgent(sessionId);
    expect(rehydrated, 'rehydration trusted the durable row over the live lease').toBe('on_call');
    expect((await w.agentState.get(sessionId))?.state).toBe('on_call');
    // The attempt binding survived, or the lease renewer and the deferred hangup
    // would have nothing to key on.
    expect((await w.agentState.get(sessionId))?.attemptId).toBe(first.id);

    // ── The consumption assertions, and which of them actually discriminate ──
    //
    // Falsified by reverting the rehydration fix (rehydration trusting the durable row). What
    // reddens is the pair above and the binding below — NOT the attempt count. The
    // reason is worth writing down rather than discovering twice: with one agent
    // on one live call there is no IDLE agent, so `planTick` returns early on
    // `candidates.length === 0` (`no_agents`) and never reaches the arithmetic at
    // all. The world declares `agents: 1` and that agent is `on_call` in Redis.
    //
    // **This comment used to credit the occupancy subtraction instead, and that
    // reasoning is now inverted.** It claimed `toDial = min(limit, available) −
    // occupied` = `min(2,1) − 1 = 0` was "a genuine second line of defence" that
    // "masks the second dial here". That formula was the double-count bug fixed in
    // #290; the target is now `MAX(0, MIN(accountLimit − occupied, idle))`, which
    // for `limit 2, occupied 1` is `MIN(1, idle)` — so had there been a second
    // idle agent, the tick WOULD dial and the `toHaveLength(1)` assertion below
    // would redden. The masking this case relied on is gone, which makes the test
    // strictly more discriminating; what saves it is the agent count, not the
    // subtraction.
    //
    // So the tick is still run and still asserted — a regression that *did* get
    // past occupancy would be caught — but the honest claim of this case is the
    // one the assertions above make: **the live lease and its attempt binding
    // survive a reconnect.** That is the defect that fix addressed; the second
    // reservation was its downstream consequence, reachable once capacity frees.
    await w.tick();

    const afterTick = await attempts(w.campaignId);
    expect(
      afterTick,
      'the tick reserved a reconnecting agent who was already on a call',
    ).toHaveLength(1);
    // The binding again, AFTER a full controller pass — the discriminating
    // assertion. Cleared, the lease renewer's state-matched CAS starts failing and
    // the one lease keeping a second attempt off this agent lapses on its own.
    expect(
      (await w.agentState.get(sessionId))?.attemptId,
      'a controller pass cleared the reconnecting agent’s attempt binding',
    ).toBe(first.id);
    expect((await w.agentState.get(sessionId))?.state).toBe('on_call');

    // Both conservation laws, per contact AND per agent. The per-agent one is not a
    // restatement: one agent bridged to two DIFFERENT customers is invisible to the
    // per-contact query, and that is exactly this bug's shape.
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
    expect(await agentsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);

    await w.bridge.endHeld();
  });
});
