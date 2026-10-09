import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/chaos/restart-mid-bridge.test.ts@4850d1d9 — 2 cases, all kept. Modified only in
 * harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * drops `telephony.vobiz` (VoBiz deleted, plan §5); import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`).
 */
import { closeTestPool, getTestPool, truncateAll } from '../../setup/test-utils.js';

// PORT NOTE: core mocked `src/db/connection.js`; agency's pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // PORT NOTE: core stubbed `telephony.vobiz` (VoBiz deleted, plan §5)
  },
}));

const {
  createChaosWorld, attempts, contactStates, agentSessionStates,
  contactsWithConcurrentLiveAttempts, agentsWithConcurrentLiveAttempts,
  abandonedCount, assertAbandonmentPredicatesAgree,
} = await import('./harness.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── AD-P2-X-01 · SCENARIO 5 — THE REPLICA RESTARTS MID-BRIDGE ──────────────
 *
 * Held on `AD-P2-C-07` (§15.9) and now unblocked. A deploy lands while agents are
 * in live conversations. The process dies with N bridged calls in flight, so no
 * terminal event is ever emitted for any of them: Postgres keeps N non-terminal
 * attempt rows, Redis keeps leases and station-ownership keys under a replica id
 * that no longer exists, and the new process has to reconstruct a truthful picture
 * from exactly that.
 *
 * ── The startup ORDER is the subject, and that is why `reap` is a parameter ──
 *
 * `runtime.start()` runs `reapOnStartup()` **before** `pacing.start()`. The reason
 * is not tidiness: `planTick` computes `occupied` as **every non-terminal attempt
 * row**, so a supervisor that starts before the reaper sees N ghost calls holding
 * N slots. `toDial = MAX(0, MIN(accountLimit − occupied, idle))` is then 0 —
 * forever, for a campaign whose status is `running`, whose agents are connected
 * and ready, and which will never dial another number. Nothing errors. Nothing is
 * stranded. The campaign simply stops working while every dashboard says it is
 * fine.
 *
 * **The wedge is narrower than it was, and this fixture sits exactly on the
 * boundary.** Before the pacing fix the target was `MIN(accountLimit, idle) −
 * occupied`, which zeroed whenever `ghosts ≥ idle`. It is now `accountLimit −
 * occupied`, so the wedge needs `ghosts ≥ accountLimit`. This scenario has
 * `ghosts == accountLimit == 2` and therefore still wedges completely; raise
 * `maxConcurrentCalls` to 3 and it would partially dial, and this test would go
 * red. That is arguably the more correct behaviour — the ghosts' account
 * concurrency slots are genuinely still held in Redis until their TTL, so
 * `accountLimit − ghosts` is the real headroom — but it means the boot-order
 * argument above now rests on the fixture's numbers, not on arithmetic that is
 * true for every configuration. Do not widen the ceiling here without deciding
 * which property this test is asserting.
 *
 * **A scenario that could only ever run the correct order cannot show the order
 * matters**, so `restartReplica({ reap: false })` reproduces the inverted boot and
 * the wedge is asserted directly. That is the whole argument for the ordering, and
 * without this case it is a comment.
 *
 * ── Why the new `replicaId` is load-bearing ─────────────────────────────────
 *
 * Station-ownership keys written by the dead replica are still in Redis under the
 * old id for up to `OWNERSHIP_TTL_MS` (30s). A restart that reused the id would
 * silently inherit them and `isLocallyOwned` would agree with `ownerOf` for
 * sockets that do not exist — skipping the one disagreement
 * `LocalDialDispatcher` refuses on. `restartReplica` throws rather than proceeding
 * if `REPLICA_ID` is pinned in the environment, because that would make these
 * assertions vacuous rather than red.
 */

describe('AD-P2-X-01 · replica restart mid-bridge (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  /**
   * Two agents in live conversations, then the replica dies **without emitting a
   * terminal event for either** — which is what a `SIGKILL` mid-bridge leaves.
   *
   * `orphanHeld()` rather than `endHeld()` is the whole fidelity of this setup: a
   * dying process does not get to tell the database its calls are over.
   */
  async function killedMidBridge(agents = 2, contacts = 6) {
    world = await createChaosWorld({ agents, contacts, maxConcurrentCalls: agents });
    world.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', hold: true });
    for (const agent of world.agents) await world.bringOnline(agent);
    await world.tick();

    const live = await attempts(world.campaignId);
    expect(live, 'the pool did not fill — there is no mid-bridge to restart through').toHaveLength(agents);
    expect(live.every((a) => a.state === 'bridged')).toBe(true);
    // Preconditions, asserted rather than assumed: every one of those contacts is
    // claimed and none has an outcome. A setup that had already settled a call
    // would make the ghost-occupancy arithmetic below come out right for the wrong
    // reason.
    expect(live.every((a) => a.outcome === null)).toBe(true);
    // `in_flight`, and which of the two it is is a property of the FIXTURE rather
    // than of the phase. Since MAG-88 the dialer marks a bridged contact
    // `connected` only when the campaign owes a write-up
    // (`requiresDisposition('connected', campaign.disposition_catalog)`); this world
    // takes migration 072's column default of `'[]'`, so nothing is owed and the
    // contact holds the `in_flight` its claim gave it for the whole live call.
    //
    // Either state serves the ghost occupancy this scenario is about: both are
    // claimed, neither is claimable again (`claimDialable` only ever claims
    // `pending`), and both count as outstanding.
    //
    // The WHOLE distribution rather than one bucket, because two very different
    // faults both show up as "one short": a contact whose post-bridge write has not
    // landed yet and two attempts dialed onto ONE contact (which leaves an extra row
    // in `pending`). Reading one bucket makes those indistinguishable — a harness
    // barrier problem and a roster-integrity problem reported identically, which is
    // how the first of these was once mistaken for the second.
    expect(await contactStates(world.campaignId)).toEqual({
      pending: contacts - agents,
      in_flight: agents,
    });

    const previousReplicaId = world.replicaId;
    world.chaos.killRenewers();
    expect(world.bridge.orphanHeld()).toBe(agents);

    return { w: world, previousReplicaId, live };
  }

  it('the correct boot order recovers everything: rows terminal, contacts requeued, agents never available', async () => {
    const { w, previousReplicaId, live } = await killedMidBridge();

    const { previousReplicaId: reported, replicaId } = await w.restartReplica();
    // A NEW id, and read through the world's live getter rather than a captured
    // copy — a captured one would make this pass against a restart that replaced
    // nothing.
    expect(reported).toBe(previousReplicaId);
    expect(replicaId).not.toBe(previousReplicaId);
    expect(w.replicaId).toBe(replicaId);

    // Nothing is locally owned on the new replica: the sockets died with the old
    // process. This is the true post-crash state and the reason the ownership
    // disagreement is reachable at all.
    for (const agent of w.agents) {
      expect(w.stations.isLocallyOwned(agent.sessionId), 'a socket survived the restart').toBe(false);
    }
    // …while Redis still carries the DEAD replica's ownership key, inside its 30s
    // TTL. `ownerOf` naming the old id next to `isLocallyOwned` being false is
    // exactly the disagreement `LocalDialDispatcher` refuses on, and it only exists
    // because the restart took a new id.
    const stillOwned = await w.stations.ownerOf(w.agents[0]!.sessionId);
    expect(stillOwned).toBe(previousReplicaId);
    expect(stillOwned).not.toBe(replicaId);

    // ── The reaper's attempt half ────────────────────────────────────────────
    const reaped = await attempts(w.campaignId);
    expect(reaped).toHaveLength(2);
    for (const a of reaped) {
      expect(a.state).toBe('ended');
      // `orphaned`, NOT `failed`: "failed" implies we tried and it did not work.
      // The distinction is what lets `AD-P3-C-02` tell a call that reached the
      // customer from one interrupted by a deploy.
      expect(a.outcome).toBe('orphaned');
      expect(a.ended_at).not.toBeNull();
      // The evidence that the customer's phone DID ring survives the reap — the
      // reaper overwrites `state`, never the instants.
      expect(a.answered_at).not.toBeNull();
      expect(a.bridged_at).not.toBeNull();
    }

    // ── The contact half, and the product decision inside it ────────────────
    const { rows: contacts } = await getTestPool().query<{ state: string; attempt_count: number; last_outcome: string }>(
      `SELECT state, attempt_count, last_outcome FROM agency_contacts
        WHERE id = ANY($1::uuid[]) ORDER BY source_row_number`,
      [live.map((a) => a.contact_id)],
    );
    expect(contacts).toHaveLength(2);
    for (const c of contacts) {
      expect(c.state).toBe('pending');
      expect(c.last_outcome).toBe('orphaned');
      // **Our crash must not consume the customer's retry allowance** — the
      // `AD-P2-C-12` decision, asserted rather than trusted to a comment. With
      // `max_attempts: 3`, three deploys would otherwise exhaust a contact who was
      // never spoken to, behind a plausible-looking audit trail.
      expect(c.attempt_count, 'a restart spent one of the customer’s attempts').toBe(0);
    }

    // ── The agent half (D2) ─────────────────────────────────────────────────
    // Every station socket died with the process, so no agent is really available.
    // Asserted as a CONTRAST, because `available` is the one value that would put a
    // real customer through to nobody.
    const rows = await agentSessionStates(w.campaignId);
    for (const agent of w.agents) {
      expect(rows[agent.sessionId]).toBe('offline');
      expect(rows[agent.sessionId]).not.toBe('available');
    }

    // A tick right now dials nothing — not because of ghosts (they are gone) but
    // because no socket has re-attached. Both reasons produce zero dials, so the
    // arm below distinguishes them by MAKING one true and not the other.
    const before = w.bridge.dialed.length;
    await w.tick();
    expect(w.bridge.dialed.length).toBe(before);

    // And the recovery completes: agents come back, the requeued contacts are
    // dialed again, exactly once each, with derived attempt numbers.
    for (const agent of w.agents) await w.bringOnline(agent);
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 11 });
    await w.runUntilQuiescent();

    const finalStates = await contactStates(w.campaignId);
    expect(finalStates['pending'] ?? 0).toBe(0);
    expect(finalStates['in_flight'] ?? 0).toBe(0);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
    expect(await agentsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
    // §10's cross-check on the hardest data this suite produces: attempts that were
    // ANSWERED and BRIDGED and then reaped to `orphaned`. Without the ratified
    // `state = 'ended'` filter these rows were counted while still live; with it
    // they are correctly zero, because a bridged call that a deploy interrupted is
    // not an abandoned call. Both halves must say so.
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(0);
    expect(await abandonedCount(w.campaignId)).toBe(0);

    // The redialed contacts carry attempt 2 — derived inside the INSERT, never
    // supplied by a caller (`AD-P2-C-12`), and gapless.
    const all = await attempts(w.campaignId);
    for (const contactId of live.map((a) => a.contact_id)) {
      const numbers = all.filter((a) => a.contact_id === contactId).map((a) => a.attempt_number).sort();
      expect(numbers).toEqual([1, 2]);
    }
  });

  /**
   * The inverted boot — the case that makes the ordering rule falsifiable.
   *
   * Supervisor first, reaper never. The ghosts hold every slot and the campaign
   * dials nothing while looking perfectly healthy.
   */
  it('supervisor before reaper: ghost occupancy wedges the campaign, and running the reaper unwedges it', async () => {
    const { w } = await killedMidBridge();

    await w.restartReplica({ reap: false });

    // The ghosts are still there. This is the precondition of the wedge, and
    // asserting it separately is what stops the zero-dial assertion below from
    // being satisfied by a system that simply had no agents.
    const ghosts = await attempts(w.campaignId);
    expect(ghosts.every((a) => a.state === 'bridged')).toBe(true);
    expect(ghosts.every((a) => a.ended_at === null)).toBe(true);

    // Agents reconnect and are ready. Both `planTick` filters are now satisfied —
    // the sockets are locally owned and Redis says `available` — so `candidates` is
    // 2 and the ONLY thing that can produce zero dials is the ghost occupancy.
    for (const agent of w.agents) await w.bringOnline(agent);
    for (const agent of w.agents) {
      expect(w.stations.isLocallyOwned(agent.sessionId)).toBe(true);
      expect((await w.agentState.get(agent.sessionId))?.state).toBe('available');
    }

    const before = w.bridge.dialed.length;
    await w.tick();
    await w.tick();
    await w.tick();
    expect(
      w.bridge.dialed.length,
      'the inverted boot dialed anyway — then ghost occupancy is not what wedges it, '
      + 'and the reaper-before-supervisor rule is protecting something else',
    ).toBe(before);

    // Still `running`, still 4 contacts waiting, no error anywhere. This is the
    // shape of the failure: it reassures.
    const wedged = await contactStates(w.campaignId);
    expect(wedged['pending']).toBe(4);
    // `in_flight`, per the note in `killedMidBridge` — the ghosts hold their
    // contacts in the state the claim gave them, this campaign owing no write-up.
    expect(wedged['in_flight']).toBe(2);

    // ── Now run the reaper, i.e. put the order back ─────────────────────────
    const recovered = await w.reaper.reapOnStartup();
    expect(recovered.attempts).toBe(2);

    // Redis leases survived the restart (Redis did not restart), and `markAllOffline`
    // writes only the mirror — so the agents must be brought back through the real
    // path before the pool can refill. That asymmetry is itself worth pinning: it is
    // why `rehydrateAgent` exists rather than the reaper clearing Redis.
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.tick();

    // EXACTLY two, not "more than zero": limit 2, two available agents and zero
    // occupancy is a determinate plan, and a floor here would pass against an
    // engine that dialed three.
    expect(
      w.bridge.dialed.length - before,
      'dialing did not resume after the reaper ran — the wedge is not the ghosts',
    ).toBe(2);
    expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
    expect(await agentsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
  });
});
