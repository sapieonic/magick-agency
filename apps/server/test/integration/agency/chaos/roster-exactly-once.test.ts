import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/chaos/roster-exactly-once.test.ts@4850d1d9 — 8 cases, all kept. Modified only in
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
  createChaosWorld, attempts, contactStates, campaignStatus,
  contactsWithConcurrentLiveAttempts, abandonedCount,
  hasOutstandingDialWorkFor, QUIESCENCE_SETTLE_TICKS,
} = await import('./harness.js');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── AD-P2-X-01 · SCENARIO 2 — ROSTER-LEVEL EXACTLY-ONCE ────────────────────
 *
 * **Phase 2 exit criterion 1, run as written**: five agents on one account with
 * `max_concurrent_calls = 5` work a 200-contact list to completion; no contact
 * is dialed twice and no answered call reaches an agent who was not reserved
 * for it, verified against the attempt table rather than by observation.
 *
 * **Why the existing suite does not already cover this.** T-D5/D5b/D5c and T-D6
 * are excellent and they are all *single-contact* or *single-mechanism*: D5 is
 * one contact and two connections, D5c asserts four concurrent claims are
 * disjoint, D6 races two bare claim+create loops over 60 contacts with no
 * pacing engine, no agent pool, no reservation and no carrier. None of them
 * exercise the property the criterion actually states, which is a **roster-level
 * conservation law over a complete run**: 200 contacts in, 200 attempts out,
 * one each, campaign `completed`. A roster can satisfy every pairwise
 * uniqueness check in the suite and still lose a contact to a claim that was
 * never released, or dial one twice across two separate rounds — neither of
 * which any single-contact test can see.
 *
 * The second clause is the one that is easy to assert weakly. "No answered call
 * reaches an agent who was not reserved for it" is not a property of the
 * attempt table alone: the table records who was *reserved*, and the thing that
 * could go wrong is the frame going to a *different socket*. So it is asserted
 * where the divergence would actually appear — on the sockets — by requiring
 * that the set of attempts each station was told about is exactly the set of
 * attempts the database says it was reserved for.
 */

describe('AD-P2-X-01 · roster-level exactly-once over a full run (chaos)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  const AGENTS = 5;
  const CONTACTS = 200;

  /**
   * ─── WHY CRITERION 1's HEADLINE PINS ITS RETRY POLICY ────────────────────────
   *
   * `AD-P3-C-01` (`4ff3126`) gave `agency_campaigns.retry_policy` a **built-in
   * default** — and it had to, because the column is `JSONB NOT NULL DEFAULT '{}'`
   * and nothing in either repo seeds it, so reading an absent key as "no retry"
   * would have shipped the whole ticket inert. That default requeues `no_answer` at
   * 60 minutes and `failed` at 120.
   *
   * Which quietly invalidated this file's evidence for **Phase 2 exit criterion 1**.
   * The criterion is a conservation law over the *dialing engine* — 200 contacts in,
   * 200 attempts out, one each, roster worked — and under the default policy a
   * `no_answer` contact returns to `pending` with `next_attempt_at` an hour away, so
   * the roster is never drained inside a test and "to completion" becomes
   * unmeasurable without a fake clock. This case burned all 400 ticks and reported
   * a tick-budget failure that named nothing.
   *
   * **Not a defect in `4ff3126`, and not a fixture inheriting a bad default.** It is
   * Phase 2 evidence written before a Phase 3 default existed. So the headline names
   * the policy it means, rather than depending on one it does not control:
   * `max_attempts: 0` is §2.4's own vocabulary for "never retried" (it is what the
   * shipped default says for `invalid` and `connected`), so this is a legitimate
   * operator configuration and not a test-only escape hatch.
   *
   * **The default is not thereby left untested** — see the companion case
   * `the DEFAULT retry policy defers rather than spins`, which supplies no policy at
   * all. Splitting them is the point: one case proves the dialing engine's
   * conservation law, the other proves the retry engine's deferral, and a single
   * case over both would fail without saying which.
   */
  const NO_RETRY_POLICY = {
    no_answer: { max_attempts: 0 },
    failed: { max_attempts: 0 },
    busy: { max_attempts: 0 },
    abandoned: { max_attempts: 0 },
  } as const;

  /**
   * §4.2's hazard, as a predicate: a `pending` contact this campaign could claim on
   * the very next tick. Must be empty while a retry delay is outstanding.
   *
   * `next_attempt_at IS NULL` is included deliberately — `claimDialable`'s own
   * predicate treats a null as immediately dialable, so a retry that scheduled
   * nothing at all is the same hazard as one that scheduled `now()`, and a query
   * checking only `<= now()` would miss it.
   */
  const CLAIMABLE_NOW_SQL = `
    SELECT COUNT(*)::text AS n FROM agency_contacts
     WHERE campaign_id = $1 AND state = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())`;

  /**
   * {@link CLAIMABLE_NOW_SQL} minus the time predicate, and nothing else.
   *
   * The permanent control for the zero that query is asserted to return. Kept
   * verbatim-parallel on purpose: if the two ever stop differing by exactly the
   * `next_attempt_at` clause, the control has stopped controlling for it.
   */
  const UNDEFERRED_SQL = `
    SELECT COUNT(*)::text AS n FROM agency_contacts
     WHERE campaign_id = $1 AND state = 'pending'`;

  async function countPending(campaignId: string, sql: string): Promise<number> {
    const { rows } = await getTestPool().query<{ n: string }>(sql, [campaignId]);
    return Number(rows[0]!.n);
  }

  /**
   * Every contact's dial fate, keyed by contact id, from the attempt table.
   * Returned rather than asserted here so each case can state its own law.
   */
  async function attemptsPerContact(campaignId: string): Promise<Map<string, number>> {
    const byContact = new Map<string, number>();
    for (const a of await attempts(campaignId)) {
      byContact.set(a.contact_id, (byContact.get(a.contact_id) ?? 0) + 1);
    }
    return byContact;
  }

  it('200 contacts, 5 agents, concurrency 5 — exactly one attempt per contact and the campaign completes', async () => {
    world = await createChaosWorld({
      agents: AGENTS, contacts: CONTACTS, maxConcurrentCalls: AGENTS,
      // See `NO_RETRY_POLICY` — the conservation law is about the dialing engine,
      // and the shipped default's 60-minute deferral makes "to completion"
      // unmeasurable here.
      campaign: { retry_policy: NO_RETRY_POLICY },
    });
    const w = world;
    // A realistic spread of carrier outcomes rather than a uniform happy path.
    // Uniform `completed` would mean every contact takes the same code path out
    // of `in_flight`, and the two paths that DON'T (`no_answer`, `failed`) are
    // the ones that strand a contact if the outcome classifier ever regresses.
    for (const agent of w.agents) await w.bringOnline(agent);

    let dialIndex = 0;
    const originalCreate = w.bridge.createBridgedCall.bind(w.bridge);
    w.bridge.createBridgedCall = async (params) => {
      const i = dialIndex++;
      w.bridge.scriptFor(
        params.agencyAttemptId,
        i % 5 === 0 ? { answer: false, bridge: false, status: 'no_answer' }
          // A carrier failure BEFORE answer. Deliberately not `answer: true,
          // bridge: false` — that is an answered call with no agent on it, i.e.
          // a genuinely abandoned one, and manufacturing 23 of them on the happy
          // path would make the zero-abandonment assertion below meaningless.
          // It gets its own case instead.
          : i % 7 === 0 ? { answer: false, bridge: false, status: 'failed' }
            : { answer: true, bridge: true, status: 'completed', talkTimeSeconds: 30 + (i % 60) },
      );
      return originalCreate(params);
    };

    // Drive to completion, checking the one invariant no failure mode may break
    // even transiently after EVERY tick — not only at the end. A run that
    // double-dialed for three ticks and then tidied up would satisfy a
    // terminal-only assertion.
    let ticks = 0;
    let settled = 0;
    for (; ticks < 400; ticks++) {
      const before = w.bridge.dialed.length;
      await w.tick();
      expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
      if (w.bridge.dialed.length !== before) {
        settled = 0;
        continue;
      }
      // A tick that dialled nothing is NOT yet quiescence. `hasOutstandingDialWorkFor`
      // counts `pending` AND `in_flight`, and only the pair means the campaign is
      // done: a contact whose call has already settled on the attempt row is still
      // `in_flight` until the fire-and-forget lifecycle write lands, and until then
      // it holds the concurrency slot, so the pacer correctly dials nothing. Read on
      // dials-plus-`pending` alone that is indistinguishable from "finished" — which
      // is how this loop could exit with a contact still `in_flight` and fail the
      // assertion below. Bounded exactly as `runUntilQuiescent` bounds it, so a
      // genuinely stuck roster still fails fast instead of spinning to 400.
      if (settled < QUIESCENCE_SETTLE_TICKS && (await hasOutstandingDialWorkFor(w.campaignId))) {
        settled++;
        continue;
      }
      // Roster drained; give the leader its idle finalization tick.
      await w.tick();
      break;
    }
    expect(ticks).toBeLessThan(399);

    // ── The conservation law ────────────────────────────────────────────────
    const byContact = await attemptsPerContact(w.campaignId);
    expect(byContact.size).toBe(CONTACTS);                       // none lost
    expect([...byContact.values()].every((n) => n === 1)).toBe(true); // none dialed twice
    const all = await attempts(w.campaignId);
    expect(all).toHaveLength(CONTACTS);
    expect(all.every((a) => a.state === 'ended')).toBe(true);
    expect(all.every((a) => a.outcome !== null)).toBe(true);

    // No contact is left holding a claim, and the roster is fully worked.
    // `in_flight` is the state that makes a campaign unable to finish.
    const states = await contactStates(w.campaignId);
    expect(states['in_flight'] ?? 0).toBe(0);
    expect(states['pending'] ?? 0).toBe(0);
    expect((states['connected'] ?? 0) + (states['completed'] ?? 0)).toBe(CONTACTS);

    // Criterion 4's threshold for a non-deliberate scenario: zero.
    expect(await abandonedCount(w.campaignId)).toBe(0);
    // And the absorption barrier never timed out, so every assertion above is
    // reading a settled system rather than a half-applied one.
    expect(w.bridge.absorbTimeouts).toEqual([]);
  }, 120_000);

  it('the §10 abandonment predicate is no longer vacuous, and is independent of the outcome the code stamps', async () => {
    // §10.1's whole finding was that this predicate could not fire. `answered_at`
    // was written once from `bridgedAt`, so the interval clause was 0 by
    // construction; an abandoned call never reached `phase === 'bridged'`, so
    // `answered_at` was never written and the predicate's own
    // `answered_at IS NOT NULL` gate excluded exactly the rows it hunted. Only
    // `outcome = 'abandoned'` survived, which made the SQL a circular audit of
    // the code path it exists to check.
    //
    // Core's `e4ec019` added the `answered` phase. This case is the standing
    // proof that the fix works, and it belongs in the chaos suite rather than
    // beside the unit tests because EVERY zero-abandonment assertion in every
    // scenario here rests on it. If this goes vacuous again, the rest of the
    // suite reports zero abandonment forever and nothing notices.
    world = await createChaosWorld({ agents: 1, contacts: 1, maxConcurrentCalls: 1 });
    const w = world;
    // The carrier picks up and the bridge never completes: an answered call with
    // no agent on it. This is the shape §10 exists to count.
    w.bridge.setDefaultScript({ answer: true, bridge: false, status: 'failed' });
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    const [row] = await attempts(w.campaignId);
    expect(row).toBeDefined();

    // The two facts that were impossible before the fix, asserted directly on
    // the row rather than through the predicate — so this cannot be satisfied by
    // a predicate that happens to count something else.
    expect(row!.answered_at).not.toBeNull();
    expect(row!.bridged_at).toBeNull();

    // And the predicate sees it.
    expect(await abandonedCount(w.campaignId)).toBe(1);

    // The independence claim, stated as a query. The predicate fired via its
    // `bridged_at IS NULL` arm, NOT via `outcome = 'abandoned'` — so it is an
    // audit of the data rather than an echo of the classifier, which is exactly
    // what §10 needs it to be for the metric cross-check to mean anything.
    const { rows: outcomeOnly } = await getTestPool().query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM agency_call_attempts
        WHERE campaign_id = $1 AND outcome = 'abandoned'`, [w.campaignId],
    );
    expect(Number(outcomeOnly[0]!.n)).toBe(0);
  }, 30_000);

  // ── Criterion 1 says "to completion", and that word now holds ─────────────
  //
  // It did not always. Found by running the case above: the conservation law was
  // satisfied — 200 in, 200 out, one each, nothing stranded `in_flight` — but the
  // campaign stayed `running`. `countOutstanding` counts `pending`, `in_flight`
  // AND `connected`, and a bridged attempt parked its contact in `connected`
  // awaiting a disposition **unconditionally**, including on a campaign with an
  // empty `disposition_catalog` that would never be asked for one. Nothing then
  // moved it out: the disposition route needs an agent to submit, and the
  // `no_disposition` sweep is the reaper's, so an ordinary run could not finish
  // without a backstop.
  //
  // MAG-88 closed that: the `bridged` phase now asks
  // `requiresDisposition('connected', campaign.disposition_catalog)` before
  // writing the hold, so a campaign owing no write-up leaves the contact
  // `in_flight` and the `ended` handler's outcome policy retires it to
  // `completed`. The case below is the chaos-scale standing proof, and it
  // replaces an `it.fails` that encoded the gap.
  //
  // The other half of the claim — a roster whose contacts REALLY ARE held in
  // `connected` reaching `completed` — is deliberately not asserted here and is
  // not a gap in the product: it needs an agent to submit a disposition, and this
  // harness has no agent-side disposition path to drive. Its coverage lives in the
  // integration tier (`agency-agent-state-cycle.test.ts` walks the held wrap-up
  // and its supervisor exit) and in the reaper's own suite.

  it('the finalization path itself works — a roster with no connections reaches `completed`', async () => {
    // Establishes that `maybeFinalize` is healthy, so the failing case below is
    // specifically about `connected`, not about finalization being broken. A
    // single `it.fails` with no companion cannot distinguish those two.
    world = await createChaosWorld({
      agents: 3, contacts: 30, maxConcurrentCalls: 3,
      // Every contact here is `no_answer`, which the shipped default requeues for an
      // hour — so without pinning the policy this case measures the retry engine,
      // not finalization, and reports `{ pending: 30 }`.
      campaign: { retry_policy: NO_RETRY_POLICY },
    });
    const w = world;
    w.bridge.setDefaultScript({ answer: false, bridge: false, status: 'no_answer' });
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    const states = await contactStates(w.campaignId);
    // Asserted as the WHOLE map rather than one key. `states['completed']` alone
    // reports `undefined` and names no cause; the map prints where the 30 actually
    // went, which is how the retry-policy interaction below was found rather than
    // guessed at.
    expect(states).toEqual({ completed: 30 });
    expect(await campaignStatus(w.campaignId)).toBe('completed');
  }, 60_000);

  it('the DEFAULT retry policy defers rather than spins — supplying no policy at all', async () => {
    // ── The companion the two pinned cases above owe ─────────────────────────
    //
    // §16.6: *any config with a documented default deserves a test that supplies
    // nothing at all*, and `retry_policy` is the sharpest instance in the project —
    // `JSONB NOT NULL DEFAULT '{}'`, never sent by master, so the **empty** policy is
    // the ordinary case and every test that passes an explicit one stays green while
    // production runs on the fallback. Two cases above now pass an explicit one, so
    // this case exists to keep the fallback covered.
    //
    // What it asserts is §4.2's hazard, not merely "a retry was scheduled":
    // `next_attempt_at` must be **strictly in the future**. Returned at `now()`, the
    // contact is re-claimable on the very next tick and a fully-deferred roster spins
    // at four claims a second all night — the failure mode `resolveRetryDecision`'s
    // `delay_minutes` exists to prevent, and one that looks like healthy throughput
    // in every metric except the carrier's.
    world = await createChaosWorld({ agents: 2, contacts: 20, maxConcurrentCalls: 2 });
    const w = world;
    // Uniform `no_answer`: one policy rule, so the expected count is exact rather
    // than a sum over branches.
    w.bridge.setDefaultScript({ answer: false, bridge: false, status: 'no_answer' });
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    // Dialed exactly once each — the deferral held every contact off for the rest of
    // the run, which is the property. A `next_attempt_at` of `now()` would show up
    // here as a second attempt on the same contact, not as a slow test.
    const byContact = await attemptsPerContact(w.campaignId);
    expect(byContact.size).toBe(20);
    expect([...byContact.values()].every((n) => n === 1)).toBe(true);

    // And they are parked `pending`, not retired. `DEFAULT_RETRY_POLICY.no_answer` is
    // `{delay_minutes: 60, max_attempts: 3}` and one attempt is used, so the whole
    // roster is retryable.
    expect(await contactStates(w.campaignId)).toEqual({ pending: 20 });

    // The exact clause §4.2 names, read from the column rather than inferred from
    // the dial count.
    const claimableNow = await countPending(w.campaignId, CLAIMABLE_NOW_SQL);
    expect(
      claimableNow,
      'a deferred contact is claimable NOW — the roster will spin at four claims a '
      + 'second until the delay is respected',
    ).toBe(0);

    // ── DIFFERENTIAL CONTROL, and it is why the zero above is evidence ────────
    //
    // `toBe(0)` on a COUNT is the classic vacuous assertion: it is equally satisfied
    // by a correct deferral, by a typo in the campaign id, by `state = 'pending'`
    // never matching, and by a WHERE clause that excludes every row for a reason
    // nobody intended. All four look identical in a green run.
    //
    // So the SAME query runs with **only the time predicate removed**, against the
    // same rows, and must find all 20. That pins everything the guarded query depends
    // on except the one clause under test — which is exactly what a falsification of
    // this assertion would have had to establish, and unlike a falsification it is
    // permanent, self-documenting, cannot be forgotten, and does not red the shared
    // worktree for every other agent. (`UNGUARDED_REAP_SQL` / `UNCOALESCED_CLOCK_SQL`
    // in `21fa0fa` are the established pattern.)
    expect(
      await countPending(w.campaignId, UNDEFERRED_SQL),
      'the guarded query above found zero because it matches NO rows at all, not '
      + 'because the deferral holds — the assertion is vacuous',
    ).toBe(20);

    // The campaign is still `running`, and correctly: there is outstanding work.
    // Asserted so this case cannot be read as "the default policy strands a roster".
    expect(await campaignStatus(w.campaignId)).toBe('running');
  }, 60_000);

  it('MAG-88: a worked roster of BRIDGED calls on an empty catalog reaches `completed`, no reaper', async () => {
    // ── Why this is not the `no connections` case above with a different script ─
    //
    // That one is a roster of `no_answer`, which never reaches the `bridged` phase
    // and so never touches the write MAG-88 changed. Every contact here is
    // answered AND bridged, which is the only path that used to park a contact in
    // `connected`. Uniform on purpose: a mixed script would let a single stuck
    // contact hide inside a bucket that had other legitimate occupants.
    //
    // Migration 072's `disposition_catalog JSONB NOT NULL DEFAULT '[]'` is left
    // alone rather than overridden — the empty catalog IS the case under test, and
    // it is also what every campaign in production currently has, since master
    // does not send the field.
    world = await createChaosWorld({ agents: 3, contacts: 12, maxConcurrentCalls: 3 });
    const w = world;
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 20 });
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    // ── "WITHOUT the reaper" is a property of this harness, and it is the point ─
    //
    // `createChaosWorld` deliberately never calls `reaper.start()`, and nothing in
    // this case calls `reapOnStartup()`. So `completed` here cannot have been
    // reached by the lapsed-wrap-up sweep rescuing a stranded contact — which is
    // exactly MAG-88's acceptance (a), and the distinction between a fix and a
    // backstop. Asserted as prose rather than a spy because the absence of a call
    // nobody makes is not mockable; see the reaper's own suite for the sweep.
    //
    // The WHOLE distribution rather than `states['connected'] ?? 0`, for the reason
    // the `no connections` case gives: a bare zero on one bucket is satisfied by a
    // roster that went somewhere else entirely, and the map names where.
    expect(await contactStates(w.campaignId)).toEqual({ completed: 12 });
    expect(await campaignStatus(w.campaignId)).toBe('completed');

    // And the calls really did bridge — without this the assertion above is
    // satisfied by 12 contacts that failed before answer, i.e. by the case that
    // was already passing before MAG-88 existed.
    const all = await attempts(w.campaignId);
    expect(all).toHaveLength(12);
    expect(all.every((a) => a.bridged_at !== null)).toBe(true);
    expect(all.every((a) => a.outcome === 'connected')).toBe(true);
  }, 60_000);

  it('no answered call reaches an agent who was not reserved for it — asserted on the sockets, not the table', async () => {
    // The attempt table records who was RESERVED. What could actually go wrong
    // is the frame reaching a different socket, which the table cannot see. So
    // the assertion is a two-way set equality between what each station was
    // told and what the database says it owned: neither a missing frame nor a
    // stray one can hide.
    world = await createChaosWorld({ agents: AGENTS, contacts: 60, maxConcurrentCalls: AGENTS });
    const w = world;
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    const all = await attempts(w.campaignId);
    expect(all).toHaveLength(60);
    expect(all.every((a) => a.reserved_agent_id !== null)).toBe(true);

    for (const agent of w.agents) {
      const reservedForMe = new Set(
        all.filter((a) => a.reserved_agent_id === agent.sessionId).map((a) => a.id),
      );
      const toldAbout = new Set(
        agent.socket.ofType('reserved').map((f) => (f['attempt'] as { attempt_id: string }).attempt_id),
      );
      const bridgedToMe = new Set(
        agent.socket.ofType('bridged').map((f) => f['attempt_id'] as string),
      );

      // Every attempt reserved for this agent was pushed to this agent's socket,
      // and this socket was pushed nothing else.
      expect([...toldAbout].sort()).toEqual([...reservedForMe].sort());
      // And every `bridged` frame it received belongs to an attempt it was
      // reserved for — the clause the criterion actually names.
      for (const id of bridgedToMe) expect(reservedForMe.has(id)).toBe(true);
    }

    // Cross-check the partition is total: every attempt landed on exactly one
    // socket. Per-agent equality alone would still hold if some attempt reached
    // no socket at all.
    const framesEverywhere = w.agents.flatMap((a) =>
      a.socket.ofType('reserved').map((f) => (f['attempt'] as { attempt_id: string }).attempt_id));
    expect(framesEverywhere).toHaveLength(60);
    expect(new Set(framesEverywhere).size).toBe(60);
  }, 60_000);

  it('two forced leaders over one 200-contact roster still dial every contact exactly once', async () => {
    // Phase 2 exit criterion 3's third clause, at roster scale. T-D6 races two
    // bare claim+create loops; this races two real pacing engines with a real
    // agent pool, real reservations and a real carrier — and deliberately WITHOUT
    // a leader lease, because the lease is the efficiency mechanism and the
    // design is explicit that it is not what prevents double-dialing.
    world = await createChaosWorld({ agents: AGENTS, contacts: CONTACTS, maxConcurrentCalls: AGENTS });
    const w = world;
    const rival = w.forkLeader();
    for (const agent of w.agents) await w.bringOnline(agent);

    let settled = 0;
    for (let i = 0; i < 400; i++) {
      const before = w.bridge.dialed.length;
      // Genuinely concurrent: both engines plan against the same pool and the
      // same roster before either has finished dialing. Each has its own
      // re-entrancy guard, so neither suppresses the other.
      await Promise.all([w.pacing.tickOnce(w.campaignId), rival.tickOnce(w.campaignId)]);
      await w.bridge.flush();
      expect(await contactsWithConcurrentLiveAttempts(w.campaignId)).toEqual([]);
      if (w.bridge.dialed.length !== before) {
        settled = 0;
        continue;
      }
      // See the note on the single-leader loop above: `bridge.flush()` absorbs on
      // the ATTEMPT row, but the CONTACT's transition out of `in_flight` lands
      // later through the fire-and-forget lifecycle subscription. Breaking on
      // `pending` alone exits while that write is still in flight and fails the
      // `in_flight === 0` assertion below with a 1 — the observed CI flake, and
      // more likely under the CPU contention of a full parallel run.
      if (settled < QUIESCENCE_SETTLE_TICKS && (await hasOutstandingDialWorkFor(w.campaignId))) {
        settled++;
        continue;
      }
      break;
    }

    const byContact = await attemptsPerContact(w.campaignId);
    expect(byContact.size).toBe(CONTACTS);
    expect([...byContact.values()].every((n) => n === 1)).toBe(true);
    expect((await contactStates(w.campaignId))['in_flight'] ?? 0).toBe(0);
    expect(await abandonedCount(w.campaignId)).toBe(0);

    // The two engines really did overlap. Reported rather than asserted — the
    // run is still valid if they serialised, just less informative — but a
    // permanently-zero contention count means this case has quietly become a
    // duplicate of the single-leader one.
    const dials = w.bridge.dialed.length;
    expect(dials).toBe(CONTACTS);
  }, 180_000);

  it('fairness holds over the run — no agent is starved and none takes the lion’s share', async () => {
    // `AD-P2-C-01` acceptance (c): no agent's idle time diverges over a 200-call
    // run. Idle time is not directly observable here, but its cause is — the
    // longest-idle-first ORDER — and an order that had degenerated to "whatever
    // the database returned" shows up as a skewed dial count. Asserted as a
    // band rather than an exact split, because the pool genuinely rotates.
    world = await createChaosWorld({ agents: AGENTS, contacts: CONTACTS, maxConcurrentCalls: AGENTS });
    const w = world;
    for (const agent of w.agents) await w.bringOnline(agent);
    await w.runUntilQuiescent();

    const all = await attempts(w.campaignId);
    expect(all).toHaveLength(CONTACTS);

    const perAgent = new Map<string, number>();
    for (const agent of w.agents) perAgent.set(agent.sessionId, 0);
    for (const a of all) perAgent.set(a.reserved_agent_id!, (perAgent.get(a.reserved_agent_id!) ?? 0) + 1);

    const counts = [...perAgent.values()];
    expect(counts).toHaveLength(AGENTS);
    // Nobody starved. This is the assertion that fails against the pre-fix
    // engine, which took `findLiveForCampaign`'s row order verbatim and handed
    // the early rows nearly everything.
    expect(Math.min(...counts)).toBeGreaterThan(0);
    // And nobody dominated: a fair share is 40, so half-share is the floor and
    // double-share the ceiling. Deliberately loose — this is a divergence check,
    // not a scheduler benchmark, and a tight bound would be a flaky test.
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(CONTACTS / AGENTS / 2);
    expect(Math.max(...counts)).toBeLessThanOrEqual((CONTACTS / AGENTS) * 2);
  }, 120_000);
});
