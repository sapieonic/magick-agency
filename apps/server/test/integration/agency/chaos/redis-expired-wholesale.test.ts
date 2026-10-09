import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * carries no carrier config; import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`). Decision B8: in "an agent who re-attaches after the flush is dialable again, and exactly one contact per dial" the list is `dnc_entries` in Postgres and survives a Redis loss, so there is no fail-closed interim after the flush; the case asserts that with the pool back the next tick dials, no `dnc_unavailable` halt is counted, and the dials were `cleared` by the gate (see the note in the case). `resyncDnc` is a no-op re-proof (harness).
 */
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';

// A real meter provider, installed before any product module creates its
// instruments (vi.hoisted runs ahead of every import), so the harness's
// `metricValue` reads what an export would actually carry.
await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../../helpers/otel-metric-reader.js');
  installMetricReader();
});

// The DB pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
// `AgencyDialer` value-imports `WebRtcCallError` from the bridge, which drags in
// the whole config graph, and `loadConfig` calls `process.exit(1)` on a schema
// the repo `.env` does not fully satisfy. Without this the FILE dies at import
// with zero tests run — the same mock the lease suite and the unit tier use.
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

const {
  createChaosWorld, attempts, contactStates, agentSessionStates,
  contactsWithConcurrentLiveAttempts, abandonedCount, agencyKeys, metricValue,
} = await import('./harness.js');
const { agencyAgentSessionRepository } = await import('../../../../src/db/repositories/agency.repository.js');
const { AgencyReaper } = await import('../../../../src/agency/reaper.js');
const { noLiveAttempts } = await import('../agency-factories.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── SCENARIO 1 — REDIS EXPIRED WHOLESALE ──────────────────────
 *
 * **Uncovered anywhere before this file.** Every existing lease test removes one
 * key, or lets one lease lapse. Nothing asked what happens when the entire
 * coordination substrate comes back empty — a Redis restarted without
 * persistence, an `allkeys-lru` eviction storm, a failover to a cold replica.
 * That is not an exotic failure; it is the ordinary consequence of the way
 * managed Redis is operated, and the agency dialer keeps FOUR distinct things
 * there: agent leases, station ownership, campaign leadership, and station
 * tokens.
 *
 * **The property under test, stated once.** Redis holds *liveness*; Postgres
 * holds *truth*. Losing Redis must therefore lose availability and nothing else
 * — it must not lose a contact, must not mutate a durable row, and above all
 * must not let the pacing loop fall back to the database's opinion of who is
 * available. puts it as "presence is the heartbeat, not a state", and total
 * Redis loss is the one failure that separates the two cleanly: every agent's DB
 * row still says `available` while not one of them has a lease.
 *
 * **Why this suite can assert that non-vacuously.** The trap is a scenario where
 * no agent was available anyway, in which case "dialed nothing" proves nothing.
 * So the arm asserts the DB mirror explicitly — `available` for every agent,
 * read back from Postgres — and *then* asserts zero dials. Those two facts
 * together are satisfiable only by a Redis-authoritative reader. A tick that
 * consulted `agency_agent_sessions.state` would dial, and would put real
 * customers through to agents whose sockets are gone.
 *
 * Assertions read Postgres and Redis. No log, no metric, no counter.
 */

describe('Redis expired wholesale (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);
  // Cleanup in `afterEach`, never at the end of a test body: T-L2 once went red
  // purely because a failing case leaked a live dialer and pending
  // timers into the next one, which then flushed the database underneath it.
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  /** Bring a world to steady state with `held` calls genuinely in flight. */
  async function withCallsInFlight(opts: { agents: number; contacts: number }) {
    world = await createChaosWorld({ ...opts, maxConcurrentCalls: opts.agents });
    world.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', hold: true });
    for (const agent of world.agents) await world.bringOnline(agent);
    await world.tick();
    return world;
  }

  /**
   * A world that has dialed a round and finished it — every agent back in the
   * pool, **zero occupancy**, roster still deep.
   *
   * This distinction cost a false green and is worth stating plainly. The
   * obvious setup is `withCallsInFlight`, which leaves N held calls occupying
   * all N slots — and since `withCallsInFlight` sets `maxConcurrentCalls: agents`
   * with every agent `on_call`, `toDial` is 0 both because there is no idle agent
   * and because `accountLimit − occupied` is 0. Either way the engine declines to
   * dial for reasons that have nothing to do with Redis. (This said
   * `min(limit, available) - occupied`, which was the double-count fixed in #290;
   * the conclusion is unchanged, the arithmetic quoted was not.) Any
   * "the flush stopped the dialing" assertion built on it is vacuous, and stays
   * green against a pacing engine that reads availability from the database.
   * Verified by patching exactly that regression in and watching it pass.
   */
  async function withPoolIdleAndRosterDeep(opts: { agents: number; contacts: number }) {
    world = await createChaosWorld({ ...opts, maxConcurrentCalls: opts.agents });
    for (const agent of world.agents) await world.bringOnline(agent);
    await world.tick();
    // Precondition, asserted rather than assumed: a round completed, nothing is
    // occupied, and there is work left.
    const live = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_call_attempts
        WHERE campaign_id = $1 AND state <> 'ended'`, [world.campaignId],
    );
    expect(Number(live.rows[0]!.n)).toBe(0);
    expect((await contactStates(world.campaignId))['pending']).toBeGreaterThan(opts.agents);
    return world;
  }

  it('loses every agency key and nothing else — Postgres is byte-for-byte untouched by the flush', async () => {
    const w = await withCallsInFlight({ agents: 3, contacts: 12 });

    const attemptsBefore = await attempts(w.campaignId);
    const contactsBefore = await contactStates(w.campaignId);
    const sessionsBefore = await agentSessionStates(w.campaignId);
    expect(attemptsBefore.length).toBe(3);
    expect(attemptsBefore.every((a) => a.state === 'bridged')).toBe(true);
    expect(await agencyKeys(w.redis)).not.toHaveLength(0);

    await w.chaos.expireRedisWholesale();

    // Redis: gone. Every namespace, not just the leases.
    expect(await agencyKeys(w.redis)).toEqual([]);

    // Postgres: identical. A coordination-store failure that mutated durable
    // state would mean the two stores are not actually layered the way the
    // design claims, and every recovery argument built on that layering would be
    // unsound.
    expect(await attempts(w.campaignId)).toEqual(attemptsBefore);
    expect(await contactStates(w.campaignId)).toEqual(contactsBefore);
    expect(await agentSessionStates(w.campaignId)).toEqual(sessionsBefore);
  });

  // ── The two guards, separated ─────────────────────────────────────────────
  //
  // Total Redis loss is refused by TWO independent mechanisms, and the first
  // draft of this file asserted only their combined effect — "the DB says
  // available and nothing was dialed". That passed against a deliberately
  // broken pacing engine whose candidate read used the DB mirror, because the
  // reservation CAS caught it one layer down. A green suite, a real regression,
  // and no way to tell which mechanism was holding the line.
  //
  // So they are tested apart, the same way `agency-duplicate-dial.test.ts`
  // separates the leader lease from the uniqueness index and for exactly the
  // same reason: a test that exercises both at once cannot tell you which one
  // fired, and cannot notice when one of them stops working.

  it('guard 1 — availability is read from Redis, so a leaseless agent is never even a candidate', async () => {
    // Falsified by spying on the reservation, not on the dial. If the candidate
    // read consulted `agency_agent_sessions.state`, every agent would still be a
    // candidate and the engine WOULD attempt to reserve them — losing the CAS
    // and dialing nothing. Identical end state, completely different system.
    // "Reserve was never called" is the only observation that separates them.
    const w = await withPoolIdleAndRosterDeep({ agents: 4, contacts: 40 });
    await w.chaos.expireRedisWholesale();

    // Postgres is emphatic that these agents are available — so a DB-authoritative
    // reader has everything it needs to get this wrong.
    const sessions = await agentSessionStates(w.campaignId);
    expect(Object.values(sessions)).toHaveLength(4);
    expect(Object.values(sessions).every((s) => s === 'available')).toBe(true);
    // And their sockets are still attached in-process, so station ownership
    // cannot be what is stopping the dial either.
    expect(w.agents.every((a) => w.stations.isLocallyOwned(a.sessionId))).toBe(true);

    const reserve = vi.spyOn(w.agentState, 'reserve');
    for (let i = 0; i < 10; i++) await w.tick();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('guard 2 — the reservation CAS refuses a lease that is gone, independently of who asked', async () => {
    // The backstop, in isolation. Driven directly rather than through the tick,
    // because reaching it through the tick requires guard 1 to have already
    // failed — and a test that can only run in a broken system is not coverage.
    const w = await withPoolIdleAndRosterDeep({ agents: 2, contacts: 10 });
    const sessionId = w.agents[0]!.sessionId;

    // Before the flush: a genuine available agent reserves.
    await w.agentState.set(sessionId, 'available');
    expect(await w.agentState.reserve(sessionId, 'attempt-pre')).toBe('reserved');

    await w.chaos.expireRedisWholesale();

    // After: the CAS finds no key, so `HGET state` is nil, so it refuses. This
    // is the `EXISTS`-first discipline requires — a CAS that recreated the
    // key would resurrect an agent whose replica is gone.
    expect(await w.agentState.reserve(sessionId, 'attempt-post')).toBe('lost');
    expect(await w.agentState.get(sessionId)).toBeNull();
  });

  it('and the end state, which is what actually matters: not one dial, with the roster still full', async () => {
    // The combined property. Deliberately kept as its own case AFTER the two
    // guards rather than instead of them: this is the thing we care about, and
    // the two above are why it is true.
    const w = await withPoolIdleAndRosterDeep({ agents: 4, contacts: 40 });
    const dialsBefore = w.bridge.dialed.length;

    await w.chaos.expireRedisWholesale();

    // Ten full controller passes rather than one, because a single tick could be
    // swallowed by the `ticking` re-entrancy guard and look like restraint.
    for (let i = 0; i < 10; i++) await w.tick();
    expect(w.bridge.dialed.length).toBe(dialsBefore);

    // The carrier saw nothing; the ledger also grew nothing. A dial that failed
    // after the attempt row was written would be invisible to the first check.
    expect((await attempts(w.campaignId)).length).toBe(dialsBefore);
    // And the roster was nowhere near exhausted, so "nothing left to dial"
    // cannot explain the restraint.
    expect((await contactStates(w.campaignId))['pending']).toBeGreaterThan(30);
  });

  it('an agent who re-attaches after the flush is dialable again, and exactly one contact per dial', async () => {
    // The inverse arm. Without it this file cannot distinguish "the tick
    // correctly refused a pool with no leases" from "the tick is broken and
    // dials nothing ever" — and the second passes every assertion above.
    // Calls that COMPLETE rather than hold, so occupancy is zero when the flush
    // lands. With held calls the tick would correctly decline to dial for a
    // reason that has nothing to do with Redis — `occupied` still counts them —
    // and the arm would pass while proving the opposite of what it claims.
    world = await createChaosWorld({ agents: 2, contacts: 10, maxConcurrentCalls: 2 });
    const w = world;
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.tick();
    expect(w.bridge.dialed.length).toBe(2);

    await w.chaos.expireRedisWholesale();
    for (let i = 0; i < 3; i++) await w.tick();
    const dialsWhileDark = w.bridge.dialed.length;
    expect(dialsWhileDark).toBe(2);

    // ── RECOVERY IS TWO INDEPENDENT HALVES, AND THIS ARM ONLY MODELLED ONE ────
    //
    // Decision B8: a flush used to take the tenant's DNC version key with everything
    // else, leaving a fail-closed interim (zero dials with the pool back, and a
    // `dnc_unavailable` halt counted) until the list was re-published. That second
    // half of recovery does not exist: the DNC list is `dnc_entries` in
    // Postgres, which a total Redis loss does not touch, so there is no interim to
    // assert and nothing to re-publish. The B8 equivalent is asserted instead — the
    // list SURVIVES the flush: with the pool back the very next tick dials, the gate
    // counted no `dnc_unavailable` halt (an absent series, not a zero), and every
    // dial still went through a gate that answered `clear` from the table. The
    // fail-closed arm on a table READ FAULT is `dnc-self-heal-loop.test.ts`.
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.tick();
    expect(
      await metricValue('agency_predial_gate_total', {
        campaign_id: w.campaignId, gate: 'dnc_unavailable', action: 'halt',
      }),
      'the DNC gate halted after a Redis flush — the list lives in Postgres (B8) and a '
      + 'Redis loss must not make it unanswerable',
    ).toBeUndefined();
    expect(
      await metricValue('agency_predial_gate_total', {
        campaign_id: w.campaignId, gate: 'cleared', action: 'dial',
      }),
      'the dials after recovery must have been cleared by the DNC gate',
    ).toBeGreaterThan(2);

    // `resyncDnc` is a no-op that re-proves the gate answers `clear` (see the harness).
    await w.chaos.resyncDnc();
    await w.tick();

    expect(w.bridge.dialed.length).toBeGreaterThan(dialsWhileDark);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
  });

  it('the campaign survives: leadership is re-derivable and the run still completes with each contact dialed exactly once', async () => {
    // Losing Redis mid-run must cost throughput, never correctness. The campaign
    // row is the durable authority on "this is running", and the leader lease is
    // re-derivable state — so a flush is a stall, not a stop.
    world = await createChaosWorld({ agents: 5, contacts: 30, maxConcurrentCalls: 5 });
    const w = world;
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 9 });
    for (const agent of w.agents) await w.bringOnline(agent);

    await w.tick();
    await w.tick();
    expect(w.bridge.dialed.length).toBeGreaterThan(0);

    await w.chaos.expireRedisWholesale();
    // The campaign is still running in the store that decides that.
    const { rows } = await getTestPool().query<{ status: string }>(
      'SELECT status FROM agency_campaigns WHERE id = $1', [w.campaignId],
    );
    expect(rows[0]!.status).toBe('running');
    // And no leader key survives, so any replica may take it — including this
    // one, which is what makes the stall self-clearing rather than a wedge.
    //
    // NOTE this reads `agency:*` only, so it deliberately says nothing about the
    // `dnc:*` keyspace the flush also emptied — see the recovery below.
    expect(await agencyKeys(w.redis)).toEqual([]);

    // Both halves of recovery: the humans reconnect, and the public API layer re-publishes the
    // DNC list. Restoring only the agents leaves the pre-dial gate halting on
    // `dnc_unavailable` and this case counting 10 attempts instead of 30 — the
    // shape it failed in when the gate landed. The fail-closed interim is asserted
    // in its own arm above rather than twice.
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.chaos.resyncDnc();
    await w.runUntilQuiescent();

    const all = await attempts(w.campaignId);
    // Exactly one attempt per contact: nothing was dialed twice across the
    // flush, and nothing was dropped by it.
    const byContact = new Map<string, number>();
    for (const a of all) byContact.set(a.contact_id, (byContact.get(a.contact_id) ?? 0) + 1);
    expect(byContact.size).toBe(30);
    expect([...byContact.values()].every((n) => n === 1)).toBe(true);
    expect(all.every((a) => a.state === 'ended')).toBe(true);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
    expect(await abandonedCount(w.campaignId)).toBe(0);
  });

  it('recovery lands every agent in `break`, never `available` — and the reaper is what makes that true', async () => {
    // The Redis-loss route into `break`. The chain is
    // reap → `offline` → rejoin → `break`, and the ORDER is the mechanism:
    // `joinOrRehydrate`'s CASE only promotes `offline` to `break`, so an agent
    // who rejoins before the reaper has run keeps whatever state they had.
    // Asserted as a contrast below rather than asserted once, because "they
    // ended up in break" is satisfied by a rehydrate that never had anything
    // to fix.
    const w = await withCallsInFlight({ agents: 3, contacts: 12 });
    await w.chaos.expireRedisWholesale();

    // Pre-reap, the rows are in SOME non-`offline` state — that is the whole
    // precondition, because a non-`offline` row is what a rejoin preserves and
    // therefore what makes the reaper's ordering load-bearing.
    //
    // This asserted `=== 'available'` until the durable mirror was changed to
    // record `on_call`. That was never the property under test: these agents are
    // mid-call by construction (`withCallsInFlight`), so `available` was only
    // ever true because the mirror had no `on_call` write — i.e. the assertion
    // was pinning the absence of a feature, and it went red the moment the
    // feature landed. `!== 'offline'` is the invariant that was actually meant,
    // and it holds under either mirror.
    expect(Object.values(await agentSessionStates(w.campaignId)).every((s) => s !== 'offline')).toBe(true);

    const reaper = new AgencyReaper(noLiveAttempts());
    const reaped = await reaper.reapOnStartup();
    expect(reaped.attempts).toBe(3);
    expect(reaped.agents).toBeGreaterThanOrEqual(3);

    // Reaped: offline, and the in-flight contacts are back on the roster rather
    // than stranded — a contact left `in_flight` is a contact the campaign can
    // never finish, and `completed` requires zero outstanding.
    expect(Object.values(await agentSessionStates(w.campaignId)).every((s) => s === 'offline')).toBe(true);
    const states = await contactStates(w.campaignId);
    expect(states['in_flight'] ?? 0).toBe(0);
    expect(states['pending']).toBe(12);

    // Rejoin: break. Never available.
    for (const agent of w.agents) {
      const join = await agencyAgentSessionRepository.joinOrRehydrate({
        tenantId: w.tenantId,
        accountId: w.accountId,
        campaignId: w.campaignId,
        agentUserId: agent.agentUserId,
        replicaId: w.replicaId,
      });
      // Every agent here rejoins the campaign they were reaped from, so the
      // per-tenant live-session uniqueness has nothing to refuse —
      // asserted rather than destructured blindly, because an `ok:false` would
      // mean the reaper left a live row somewhere else and the `break` assertion
      // below would then be reading a session this rejoin never touched.
      expect(join.ok).toBe(true);
      expect(join.session.state).toBe('break');
    }
    const after = await agentSessionStates(w.campaignId);
    expect(Object.values(after).every((s) => s === 'break')).toBe(true);
    expect(Object.values(after)).not.toContain('available');

    // An agent in `break` is never reserved, so the tick stays quiet even though
    // the sockets are back — the pool re-opens on a human click, not on a
    // reconnect. This is the assertion that would catch a "helpfully" restored
    // `available` on rehydrate.
    for (const agent of w.agents) {
      await w.stations.attach({
        sessionId: agent.sessionId, campaignId: w.campaignId, tenantId: w.tenantId,
        accountId: w.accountId, agentUserId: agent.agentUserId, ws: agent.socket as never,
      });
    }
    const dialsBefore = w.bridge.dialed.length;
    for (let i = 0; i < 5; i++) await w.tick();
    expect(w.bridge.dialed.length).toBe(dialsBefore);
  });

  it('the flush cannot produce an abandoned call, because it cannot reach a live bridge', async () => {
    // Worth pinning explicitly rather than inferring. The only route to
    // abandonment is reserved-agent loss, and Redis holds the reservation — so
    // "the reservations all vanished" is exactly the shape that *looks* like it
    // should abandon a call. It does not, because the bridge already owns the
    // media and the reservation is not consulted again after `bridged`.
    const w = await withCallsInFlight({ agents: 3, contacts: 12 });
    await w.chaos.expireRedisWholesale();

    // The held calls end normally after the flush — the carrier does not care
    // that our coordination store restarted.
    await w.bridge.endHeld();

    const all = await attempts(w.campaignId);
    expect(all).toHaveLength(3);
    expect(all.every((a) => a.state === 'ended' && a.outcome === 'connected')).toBe(true);
    expect(await abandonedCount(w.campaignId)).toBe(0);

    // the standing falsifier, asserted on this suite's own data: if the
    // harness or the product ever collapses the two timestamps again, every
    // abandonment assertion in every scenario silently becomes vacuous and
    // nothing else in the suite would notice.
    expect(all.every((a) => a.answered_at !== null && a.bridged_at !== null)).toBe(true);
    expect(all.some((a) => a.answered_at!.getTime() !== a.bridged_at!.getTime())).toBe(true);
  });
});
