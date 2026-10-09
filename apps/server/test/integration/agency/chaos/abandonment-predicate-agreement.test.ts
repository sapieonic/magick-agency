import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * PORT NOTE (magick-agency, Phase 6): ported from core
 * test/integration/agency/chaos/abandonment-predicate-agreement.test.ts@4850d1d9 — 3 cases, all kept. Modified only in
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
  createChaosWorld, attempts, abandonedCount, abandonedCountByProductPredicate,
  assertAbandonmentPredicatesAgree,
} = await import('./harness.js');
const { ABANDONMENT_BRIDGE_GRACE_MS, ABANDONED_ATTEMPT_PREDICATE_SQL } =
  await import('@magick-agency/domain/abandonment-predicate');

type World = Awaited<ReturnType<typeof createChaosWorld>>;

/**
 * ─── §10's CROSS-CHECK, AS A TEST (`AD-P2-C-06` acceptance (a)) ──────────────
 *
 * `agency_abandoned_total` is only an *audit* of abandonment if some second,
 * independently written definition agrees with it. Test-plan §10 is that second
 * definition and it lives in `harness.ts`; core's is
 * `ABANDONED_ATTEMPT_PREDICATE_SQL`. Two pieces of SQL that must always return the
 * same number, which means nothing but a comparison can tell you they still do.
 *
 * ── Why this file exists rather than an assertion in the other scenarios ────
 *
 * It was an assertion in the other scenarios first, and **falsification showed it
 * could not observe the thing it was for.** Reverting my half to the pre-`8da1bea`
 * §10 predicate (no `state = 'ended'`) reddened nothing, because by the time those
 * scenarios reach their abandonment assertions every attempt is already terminal —
 * so the filter is a no-op on that data and the two halves agree either way.
 *
 * The filter is only observable on a **live** attempt that is answered and not yet
 * bridged. That state existed nowhere in the harness, which is why the gap
 * survived: the `holdAfterAnswer` script stage was added for exactly this row.
 *
 * That is the §16.6 pattern applied to a cross-check rather than an assertion, and
 * the generalisation is worth keeping: **an agreement check between two
 * definitions proves nothing unless it runs on data where they could disagree.**
 * Agreement on data both halves treat identically is the same vacuity as
 * `toBeGreaterThan(0)`.
 *
 * ── What the ratified filter is protecting ─────────────────────────────────
 *
 * Without `state = 'ended'`, `bridged_at IS NULL` is true of a call the carrier has
 * answered and the bridge is still reaching. Live traffic then inflates the
 * compliance rate in real time, and `AD-P4-C-02`'s auto-pause fires on a healthy
 * campaign at concurrency — pausing calls that were seconds from connecting, in the
 * name of a compliance guardrail. Note the shape: it only misbehaves under the
 * concurrency Phase 2 introduces, and it fails in the direction that looks like
 * caution.
 */

describe('AD-P2-C-06 (a) · §10 and the product predicate agree, on data where they could not', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(closeTestPool);

  /** One attempt the carrier has answered and the bridge has not reached. */
  async function answeredNotYetBridged() {
    world = await createChaosWorld({ agents: 1, contacts: 2, maxConcurrentCalls: 1 });
    world.bridge.setDefaultScript({
      answer: true, bridge: false, status: 'completed', holdAfterAnswer: true,
    });
    await world.bringOnline(world.agents[0]!);
    await world.tick();

    const rows = await attempts(world.campaignId);
    expect(rows).toHaveLength(1);
    const attempt = rows[0]!;
    // ── The row that makes this file work, asserted as preconditions ─────────
    // Answered, NOT bridged, NOT terminal. All three, because dropping any one of
    // them returns this to data the two halves treat identically — which is exactly
    // how the earlier version of this check came to prove nothing.
    expect(attempt.answered_at, 'the carrier never answered — the filter is unobservable').not.toBeNull();
    expect(attempt.bridged_at, 'the call bridged — the `bridged_at IS NULL` arm cannot fire').toBeNull();
    expect(attempt.state, 'the attempt is already terminal — the filter is a no-op here').not.toBe('ended');
    return { w: world, attempt };
  }

  it('a live answered-but-unbridged attempt counts ZERO in both halves, and they agree', async () => {
    const { w } = await answeredNotYetBridged();

    // Core's half.
    expect(await abandonedCountByProductPredicate(w.campaignId)).toBe(0);
    // §10's half.
    expect(await abandonedCount(w.campaignId)).toBe(0);
    // And the agreement, which is the acceptance criterion rather than either
    // number on its own.
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(0);
  });

  /**
   * The pinning assertion, and the reason it is here rather than in a comment.
   *
   * `state = 'ended'` is the substantive difference between §10 as originally
   * written and the ratified predicate, so its presence is asserted structurally.
   * Rule 3: a comment saying "the predicate filters on terminal state" is not
   * evidence that it does, and a reviewer reads the comment and stops looking.
   */
  it("core's predicate filters on terminal state, and takes no bound parameter", () => {
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toMatch(/state\s*=\s*'ended'/);
    expect(ABANDONMENT_BRIDGE_GRACE_MS).toBe(1000);
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).toContain(`${ABANDONMENT_BRIDGE_GRACE_MS} milliseconds`);

    // No `$n` placeholder — the independence guarantee, mechanically. The predicate
    // reads raw columns only; feeding a counter or any in-process value into the
    // numerator would require a bound parameter, so its absence is what makes
    // "independent of the metric" checkable rather than a convention. Borrowed from
    // core's own framing of the same rule, and it is the positive form of §16.6:
    // verify the property, do not document it.
    expect(ABANDONED_ATTEMPT_PREDICATE_SQL).not.toMatch(/\$\d/);
  });

  /**
   * The grace arm, on live data — the OTHER way the two halves could diverge.
   *
   * A call whose bridge arrived more than `N` after the answer is abandoned even
   * though it did eventually bridge. Asserted as a pair with the fast-bridge case,
   * because a predicate that counted *every* bridged call would satisfy the slow
   * case alone.
   */
  it('the grace arm fires past N and not within it, identically in both halves', async () => {
    world = await createChaosWorld({ agents: 1, contacts: 2, maxConcurrentCalls: 1 });
    const w = world;
    w.bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 5 });
    await w.bringOnline(w.agents[0]!);
    await w.tick();

    const [fast] = await attempts(w.campaignId);
    // The harness answers 40ms before it bridges, so this row is inside N.
    expect(fast!.bridged_at).not.toBeNull();
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(0);

    // Now push this row's answer instant back past N. Written directly rather than
    // waited out: N is a business threshold, and a test that slept 1s to cross it
    // would be measuring the clock rather than the predicate. An EXACT offset, not
    // a generous one — `+1ms` past the boundary is what distinguishes `>` from
    // `>=`, and a 5s offset would pass against either.
    await getTestPool().query(
      `UPDATE agency_call_attempts SET answered_at = bridged_at - ($2::int || ' milliseconds')::interval
        WHERE id = $1`,
      [fast!.id, ABANDONMENT_BRIDGE_GRACE_MS + 1],
    );
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(1);

    // …and exactly AT N it is not abandoned, which is the boundary the `>` encodes.
    await getTestPool().query(
      `UPDATE agency_call_attempts SET answered_at = bridged_at - ($2::int || ' milliseconds')::interval
        WHERE id = $1`,
      [fast!.id, ABANDONMENT_BRIDGE_GRACE_MS],
    );
    expect(await assertAbandonmentPredicatesAgree(w.campaignId)).toBe(0);
  });
});
