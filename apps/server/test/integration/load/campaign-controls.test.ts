import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';

await vi.hoisted(async () => {
  process.env['LOG_LEVEL'] ??= 'warn';
});

vi.mock('@magick-agency/db', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('@magick-agency/db/connection', async () => {
  const { floorPool } = await import('./floor-pool.js');
  return { getPool: () => floorPool() };
});
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { createFloorWorld, closeFloorPool, attemptRows, pacingViolations, contactStateCounts } = await import('./floor-harness.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;

/**
 * ─── PAUSE, RESUME AND STOP A CAMPAIGN MID-FLIGHT, AT SCALE ─────────────────
 *
 * A supervisor's controls land on a campaign with sixty calls in every phase —
 * ringing, talking, just ended — while a neighbouring campaign on the same floor
 * keeps working. The controls are the route's own `transitionStatus` writes; the
 * leader learns of them on its next tick, exactly as in production.
 *
 *  - **Pause** stops new dials from the next tick, and nothing else: calls already
 *    placed ring, answer, bridge and end normally (a pause does not hang up on a
 *    customer), agents come back to the pool and wait.
 *  - **Resume** restarts dialing on the next tick, with no pause flag to go stale —
 *    the pacing law simply has a running status again.
 *  - **Stop** stops new dials at once, lets every in-flight call settle on its own
 *    terms (no attempt is orphaned by the stop), and the leader finalizes
 *    `stopping → stopped` once the last call has ended — with the undialled roster
 *    left `pending`, untouched, rather than drained or lost.
 *  - Every agent on the campaign is told each change (`campaign_state`).
 *
 * The floor invariants and the pacing law (status included) are checked every
 * round throughout.
 */

describe('campaign controls mid-flight at scale (load)', () => {
  let world: World;

  beforeEach(truncateAll);
  afterEach(async () => {
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(async () => {
    await closeFloorPool();
    await closeTestPool();
  });

  it('pause holds new dials but not live calls, resume restarts them, stop drains to stopped with nothing orphaned', async () => {
    const AGENTS = scaled(60);
    world = await createFloorWorld({
      campaigns: [
        { label: 'C', tenant: 't1', account: 'c1', agents: AGENTS, contacts: scaled(1500), maxConcurrentCalls: AGENTS,
          // Long calls dominate, so every control lands on a floor full of live calls.
          mix: { connected_long: 50, connected_short: 15, no_answer: 25, busy: 10 } },
        { label: 'M', tenant: 't2', account: 'm1', agents: scaled(20), contacts: scaled(300), maxConcurrentCalls: scaled(20) },
      ],
    });
    const seed = world.seed;
    const c = world.campaign('C');
    const db = getTestPool();
    const violations: string[] = [];
    const round = async () => {
      const r = await world.round();
      violations.push(...await world.checkInvariants(), ...pacingViolations(r, seed));
      if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
      return r;
    };
    const live = () => world.carrier.liveCalls().filter((x) => x.campaignId === c.id);
    const now = async () => (await db.query<{ t: Date }>('SELECT clock_timestamp() AS t')).rows[0]!.t;

    for (let i = 0; i < 6; i++) await round();
    expect(live().length, `seed ${seed}`).toBeGreaterThan(AGENTS / 2);

    // ── Pause, with calls in every phase ────────────────────────────────────
    const inFlightAtPause = live().map((x) => x.attemptId);
    expect(new Set(live().map((x) => x.phase)).size, `seed ${seed}: want ringing AND talking calls`).toBeGreaterThan(1);
    expect(await world.transition('C', ['running'], 'paused')).toBe(true);
    const pausedAt = await now();
    let r = await round();
    expect(r.campaigns['C']!.status).toBe('paused');
    expect(r.campaigns['C']!.attemptsCreated).toBe(0);
    while (live().length > 0) {
      r = await round();
      expect(r.campaigns['C']!.attemptsCreated, `seed ${seed}: dialled while paused`).toBe(0);
    }
    const afterPause = await attemptRows([c.id]);
    expect(afterPause.filter((a) => a.created_at > pausedAt).map((a) => a.id), `seed ${seed}`).toEqual([]);
    // The calls in flight at the pause ended on their own terms — none cut off.
    for (const id of inFlightAtPause) {
      const a = afterPause.find((x) => x.id === id)!;
      expect(a.state).toBe('ended');
      expect(['connected', 'no_answer', 'busy'], `seed ${seed}: ${id} ended ${a.outcome}`).toContain(a.outcome);
    }
    // The pool waits, available, and is not dialled.
    const states = await world.runtime.agents.getMany(world.agentsOf('C').map((a) => a.sessionId));
    expect(states.every((s) => s?.state === 'available'), `seed ${seed}`).toBe(true);
    await round();
    expect((await attemptRows([c.id])).length).toBe(afterPause.length);

    // ── Resume: the very next tick dials the whole idle pool ───────────────
    expect(await world.transition('C', ['paused'], 'running')).toBe(true);
    r = await round();
    expect(r.campaigns['C']!.attemptsCreated, `seed ${seed}`).toBe(AGENTS);
    for (let i = 0; i < 5; i++) await round();

    // ── Stop, mid-flight ────────────────────────────────────────────────────
    const inFlightAtStop = live().map((x) => x.attemptId);
    expect(inFlightAtStop.length, `seed ${seed}`).toBeGreaterThan(AGENTS / 2);
    const pendingAtStop = (await contactStateCounts(c.id))['pending'] ?? 0;
    expect(pendingAtStop).toBeGreaterThan(0);
    expect(await world.transition('C', ['running', 'paused'], 'stopping')).toBe(true);
    const stoppedAt = await now();
    let sawStopping = false;
    await world.runUntilDrained({
      maxRounds: scaled(2000),
      onRound: async (rr) => {
        violations.push(...await world.checkInvariants(), ...pacingViolations(rr, seed));
        if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
        if (rr.campaigns['C']!.status === 'stopping') sawStopping = true;
        // Still draining while any of its calls is live — never finalized early.
        if (live().length > 0) expect(await world.status('C'), `seed ${seed}`).toBe('stopping');
      },
    });
    expect(sawStopping).toBe(true);
    expect(await world.status('C'), `seed ${seed}`).toBe('stopped');
    expect(await world.status('M'), `seed ${seed}`).toBe('completed');
    const final = await attemptRows([c.id]);
    expect(final.filter((a) => a.created_at > stoppedAt).map((a) => a.id), `seed ${seed}: dialled after stop`).toEqual([]);
    for (const id of inFlightAtStop) {
      const a = final.find((x) => x.id === id)!;
      expect(a.state).toBe('ended');
      expect(a.outcome, `seed ${seed}: the stop orphaned ${id}`).not.toBe('orphaned');
    }
    // The undialled roster is left exactly as it was — not drained, not lost.
    const after = await contactStateCounts(c.id);
    expect(after['in_flight'] ?? 0).toBe(0);
    expect(after['pending'] ?? 0, `seed ${seed}`).toBeGreaterThanOrEqual(pendingAtStop);
    const audit = await world.finalAudit();
    expect(audit, audit.slice(0, 20).join('\n')).toEqual([]);

    // ── Every agent was told each change ────────────────────────────────────
    for (const a of world.agentsOf('C')) {
      const seen = a.socket.ofType('campaign_state').map((f) => f['status']);
      expect(seen, `agent ${a.label}, seed ${seed}`).toEqual(expect.arrayContaining(['paused', 'running', 'stopped']));
    }
  }, 300_000);
});
