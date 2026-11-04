import { appendFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { scaled } from '../../helpers/load-scale.js';
import type { PacingTickObservation } from '../../../src/agency/pacing-engine.js';

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

const { createFloorWorld, closeFloorPool, expectedDials } = await import('./floor-harness.js');
const { PacingEngine, TICK_INTERVAL_MS, PACING_SAFETY_TICK_MS } = await import('../../../src/agency/pacing-engine.js');
const { LocalDialDispatcher } = await import('../../../src/agency/dial-dispatcher.js');
const { AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { accountSettingsRepository } = await import('@magick-agency/db/repositories/account-settings.repository');
const { agencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { getConcurrencyControl, setConcurrencyControl, resetConcurrencyControl } = await import('../../../src/seams/concurrency-control.js');
const { withPacingInvalidation } = await import('../../../src/agency/pacing/limit-invalidation.js');
const { getPacingInvalidationBus } = await import('../../../src/agency/pacing/invalidation-bus.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type Engine = InstanceType<typeof PacingEngine>;
type Obs = PacingTickObservation;

/**
 * ─── PACING ROUNDS ON A REAL FLOOR ──────────────────────────────────────────
 *
 * The engine's scheduled path (`runRound`): a campaign whose last full tick could
 * reserve nothing is SKIPPED, with no database or Redis work, until an
 * invalidation event wakes it or the safety tick comes due; the campaign row and
 * the account limit are cached between full ticks and dropped by events. These
 * cases run it over real Postgres and Redis with the real runtime and the floor
 * carrier, and pin what the skip must never cost:
 *
 *  - an agent becoming available after an idle period is dialed within ONE round;
 *  - a change no event announced is found by the safety tick, not never;
 *  - a lowered account limit reaches every engine on the bus within one round
 *    (two engines, as two replicas), and the TTL catches it when the event is lost;
 *  - a churning floor never dials past its limit, and the pacing law holds every
 *    round — a skipped tick where the law wanted a dial would be a missed wake-up.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A measurement line: printed, and appended to `PACING_HARNESS_OUT` when set. */
function report(line: string): void {
  // eslint-disable-next-line no-console
  console.log(line);
  const out = process.env['PACING_HARNESS_OUT'];
  if (out) appendFileSync(out, `${line}\n`);
}

function observe(engine: Engine): Array<Obs & { at: number }> {
  const seen: Array<Obs & { at: number }> = [];
  engine.registerTickObserver((o) => seen.push({ ...o, at: Date.now() }));
  return seen;
}

async function lead(engine: Engine, campaignIds: string[]): Promise<void> {
  const e = engine as unknown as { lease: { tryAcquire(id: string): Promise<boolean> }; beginLeading(row: unknown): void };
  for (const id of campaignIds) {
    if (!(await e.lease.tryAcquire(id))) throw new Error(`could not lead ${id}`);
    const { rows } = await getTestPool().query('SELECT * FROM agency_campaigns WHERE id = $1', [id]);
    e.beginLeading(rows[0]);
  }
}

async function attemptCount(campaignId: string, live = false): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM agency_call_attempts WHERE campaign_id = $1 ${live ? "AND state <> 'ended'" : ''}`,
    [campaignId]);
  return rows[0]!.n;
}

describe('pacing rounds: skip, wake, share (load)', () => {
  let world: World;
  const extra: Engine[] = [];

  beforeEach(truncateAll);
  afterEach(async () => {
    for (const e of extra.splice(0)) await e.stop();
    resetConcurrencyControl();
    await world?.teardown();
    world = undefined as never;
  });
  afterAll(async () => {
    await closeFloorPool();
    await closeTestPool();
  });

  it('an agent going available after an idle period is dialed within one 250 ms round (real timers)', async () => {
    world = await createFloorWorld({
      campaigns: [{ label: 'R', tenant: 't1', account: 'r1', agents: 3, contacts: 20, maxConcurrentCalls: 3 }],
    });
    const r = world.campaign('R');
    for (const a of world.agentsOf('R')) await world.goBreak(a);
    const seen = observe(world.runtime.pacing);
    await lead(world.runtime.pacing, [r.id]);

    // An idle period long enough for skips AND a safety tick. Wait for the safety tick
    // itself rather than a fixed sleep: on real timers under a loaded full run the 1 s
    // timer slips, and a fixed `SAFETY + 500 ms` sleep then misses a tick that does come.
    // The deadline (3 × the safety interval) still fails a safety tick that never fires.
    const safetySeen = (): boolean => seen.some((o) => o.mode === 'full' && o.cause === 'safety');
    const safetyDeadline = Date.now() + 3 * PACING_SAFETY_TICK_MS;
    await sleep(PACING_SAFETY_TICK_MS);
    while (!safetySeen() && Date.now() < safetyDeadline) await sleep(50);
    expect(seen.filter((o) => o.mode === 'skipped').length).toBeGreaterThan(2);
    expect(safetySeen()).toBe(true);
    expect(await attemptCount(r.id)).toBe(0);

    const agent = world.agentsOf('R')[0]!;
    // "Became available" is the instant the state write published its event: a
    // round that lands while the write is still in flight cannot know of it.
    let before = -1;
    let at = 0;
    const off = getPacingInvalidationBus().subscribe((e) => {
      if (e.type === 'agent_available' && e.sessionId === agent.sessionId && before < 0) {
        before = seen.length;
        at = Date.now();
      }
    });
    expect(await world.goAvailable(agent)).toBe(true);
    off();
    expect(before).toBeGreaterThanOrEqual(0);
    const deadline = at + 3_000;
    while ((await attemptCount(r.id)) === 0 && Date.now() < deadline) await sleep(10);
    const reacted = Date.now() - at;

    expect(await attemptCount(r.id)).toBe(1);
    // The tick is observed when it ends, after its dispatch.
    while (seen.length <= before && Date.now() < deadline) await sleep(10);
    const after = seen.slice(before);
    // The first tick after the event is FULL (woken by it), not a skip.
    expect(after[0]).toMatchObject({ mode: 'full', cause: 'event' });
    // The claim is structural (above): the first round after the event is a full one woken
    // by it, and the attempt exists when it ends; nothing waited for the safety tick. The
    // time is reported, and bounded only below the safety tick plus a round, so a loaded
    // full run cannot fail a correct engine while a dial left to the safety net still would.
    report(`PACING-REACTION available→attempt row ${reacted} ms (round ${TICK_INTERVAL_MS} ms)`);
    expect(after[0]!.at - at).toBeLessThan(PACING_SAFETY_TICK_MS + TICK_INTERVAL_MS);
    expect(reacted).toBeLessThan(PACING_SAFETY_TICK_MS + TICK_INTERVAL_MS);
  }, 60_000);

  it('a change no event announced is found by the safety tick, and only by it', async () => {
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [{ label: 'S', tenant: 't1', account: 's1', agents: 2, contacts: 20, maxConcurrentCalls: 2 }],
    });
    const s = world.campaign('S');
    for (const a of world.agentsOf('S')) await world.goBreak(a);
    const seen = observe(world.runtime.pacing);
    await world.round({ measure: false });
    expect(seen.at(-1)).toMatchObject({ mode: 'full', quiescent: true });

    // Available by a raw Redis write: no state machine, so no event.
    const agent = world.agentsOf('S')[0]!;
    await world.redis.hset(`agency:agent:${agent.sessionId}:state`, 'state', 'available', 'since', String(Date.now()));
    await world.redis.pexpire(`agency:agent:${agent.sessionId}:state`, AGENT_LEASE_MS.available);
    let rounds = 0;
    while ((await attemptCount(s.id)) === 0 && rounds < 20) {
      await sleep(TICK_INTERVAL_MS);
      await world.round({ measure: false });
      rounds++;
    }
    expect(await attemptCount(s.id)).toBe(1);
    const full = seen.filter((o) => o.mode === 'full');
    expect(full.at(-1)).toMatchObject({ cause: 'safety', plan: { toDial: 1 } });
    // Skipped in between (the skip is real), and found within the bound, counted in rounds:
    // each round waits at least one interval, so the safety tick is due by this many. (A
    // wall-clock bound failed a correct engine when a loaded run slowed the sleeps down.)
    expect(seen.slice(1, -1).every((o) => o.mode === 'skipped')).toBe(true);
    expect(rounds).toBeLessThanOrEqual(Math.ceil(PACING_SAFETY_TICK_MS / TICK_INTERVAL_MS) + 2);
  }, 60_000);

  describe('a lowered account limit', () => {
    /**
     * Two engines lead the same campaign (two "replicas": separate lease keys, the
     * same stations, agents and dialer), both on the process bus — the split brain
     * the lease cannot rule out, and the simplest way to put two engines on one
     * account with one running campaign per account. 8 agents, limit 4: one engine
     * dials 4 and the carrier holds them; both then sit at the limit, quiescent,
     * each with 4 in its cache.
     */
    async function twoEnginesAtLimit(opts: { cacheTtlMs?: number } = {}) {
      world = await createFloorWorld({
        campaigns: [{ label: 'L', tenant: 't1', account: 'l1', agents: 8, contacts: 40, maxConcurrentCalls: 4 }],
      });
      const l = world.campaign('L');
      const rt = world.runtime;
      const make = (prefix: string) => {
        const e = new PacingEngine(
          world.redis, prefix, prefix, rt.stations, rt.agents,
          new LocalDialDispatcher(rt.replicaId, (cmd, o) => rt.dialer.executeDial(cmd, o)), rt.dnc,
          opts.cacheTtlMs ? { cacheTtlMs: opts.cacheTtlMs } : {},
        );
        e.setAutoRounds(false);
        extra.push(e);
        return e;
      };
      const a = make('replica-a:');
      const b = make('replica-b:');
      const seenA = observe(a);
      const seenB = observe(b);
      await lead(a, [l.id]);
      await lead(b, [l.id]);
      await a.runRound();
      expect(await attemptCount(l.id, true)).toBe(4);
      await b.runRound();
      await a.runRound();
      for (const seen of [seenA, seenB]) {
        expect(seen.at(-1)).toMatchObject({ mode: 'full', quiescent: true, plan: { accountLimit: 4, occupied: 4, toDial: 0 } });
      }
      return { l, a, b, seenA, seenB };
    }

    /** End two live attempts (the calls the carrier holds), leaving 2 live and 6 agents idle. */
    async function endTwo(campaignId: string, viaRepository: boolean): Promise<void> {
      const { rows } = await getTestPool().query<{ id: string }>(
        `SELECT id FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended' ORDER BY created_at LIMIT 2`, [campaignId]);
      for (const { id } of rows) {
        if (viaRepository) await agencyAttemptRepository.setState(id, 'ended', { outcome: 'failed', ended_at: new Date() });
        else await getTestPool().query(`UPDATE agency_call_attempts SET state = 'ended', outcome = 'failed', ended_at = now() WHERE id = $1`, [id]);
      }
    }

    it('reaches both engines on the bus within one round (super-admin write through the seam)', async () => {
      const { l, a, b, seenA, seenB } = await twoEnginesAtLimit();
      // The voice engine's seam implementation, decorated exactly as `startAgency` does.
      const guardInvalidations: string[] = [];
      setConcurrencyControl(withPacingInvalidation({
        invalidateAccountLimit: async (t, acc) => { guardInvalidations.push(`${t}:${acc}`); },
        invalidateProviderLimits: async () => {},
        getAccountProviderCounts: async () => ({ status: 'available', counts: new Map() }),
        getAccountCount: async () => 0,
        getDistributedAccountCount: async () => ({ status: 'available', count: 0 }),
      }));

      // What the super-admin settings write does: the row, then the seam.
      await accountSettingsRepository.upsert({ tenant_id: l.tenantId, account_id: l.accountId, max_concurrent_calls: 2 });
      await getConcurrencyControl().invalidateAccountLimit(l.tenantId, l.accountId);
      expect(guardInvalidations).toEqual([`${l.tenantId}:${l.accountId}`]);
      // Two calls end (their own events): live 2, 6 agents waiting. With the stale
      // 4 each engine would dial 2 more; with 2, nothing.
      await endTwo(l.id, true);
      const attempts = await attemptCount(l.id);

      await a.runRound();
      await b.runRound();
      for (const seen of [seenA, seenB]) {
        expect(seen.at(-1)).toMatchObject({ mode: 'full', cause: 'event', plan: { accountLimit: 2, occupied: 2, toDial: 0 } });
      }
      expect(await attemptCount(l.id)).toBe(attempts);
    }, 60_000);

    it('reaches both engines through the TTL when the event is lost', async () => {
      const TTL = 400;
      const { l, a, b, seenA, seenB } = await twoEnginesAtLimit({ cacheTtlMs: TTL });
      // A raw write and raw call ends: no event of any kind.
      await getTestPool().query('UPDATE account_settings SET max_concurrent_calls = 2 WHERE tenant_id = $1 AND account_id = $2',
        [l.tenantId, l.accountId]);
      await endTwo(l.id, false);
      const attempts = await attemptCount(l.id);
      const limitSeen = (seen: typeof seenA) => (seen.filter((o) => o.mode === 'full' && o.plan).at(-1) as any)?.plan.accountLimit;
      // Counted in rounds, each at least one interval apart: the TTL and the safety tick are
      // both due within this many (a wall-clock bound failed under a loaded run).
      const maxRounds = Math.ceil((PACING_SAFETY_TICK_MS + TTL) / TICK_INTERVAL_MS) + 2;
      let rounds = 0;
      while ((limitSeen(seenA) !== 2 || limitSeen(seenB) !== 2) && rounds < 3 * maxRounds) {
        await sleep(TICK_INTERVAL_MS);
        await a.runRound();
        await b.runRound();
        rounds++;
      }
      expect([limitSeen(seenA), limitSeen(seenB)]).toEqual([2, 2]);
      expect(rounds).toBeLessThanOrEqual(maxRounds);
      expect(await attemptCount(l.id)).toBe(attempts);
    }, 60_000);
  });

  it('a churning floor on the scheduled path never dials past its limit, and the pacing law holds every round', async () => {
    world = await createFloorWorld({
      scheduled: true,
      campaigns: [
        { label: 'A', tenant: 't1', account: 'a1', agents: scaled(12), contacts: scaled(240), maxConcurrentCalls: scaled(12) },
        // The cap binds below the pool: `no_slots` quiescence, woken by call ends.
        { label: 'B', tenant: 't1', account: 'b1', agents: scaled(12), contacts: scaled(240), maxConcurrentCalls: scaled(5) },
        { label: 'C', tenant: 't2', account: 'c1', agents: scaled(8), contacts: scaled(160), maxConcurrentCalls: scaled(8) },
      ],
    });
    const { seed, rng } = world;
    const seen = observe(world.runtime.pacing);
    const violations: string[] = [];
    const back = new Map<number, Array<() => Promise<void>>>();
    const later = (round: number, fn: () => Promise<void>) => back.set(round, [...(back.get(round) ?? []), fn]);
    let lateJoins = 0;
    /** One round, with the pacing law and the limit checked for every campaign. */
    const checkedRound = async () => {
      const r = await world.round();
      violations.push(...await world.checkInvariants());
      for (const [label, s] of Object.entries(r.campaigns)) {
        const want = expectedDials(s);
        if (s.attemptsCreated !== want) {
          violations.push(`[seed ${seed}, round ${r.round}] ${label}: dialled ${s.attemptsCreated}, pacing law says ${want} `
            + `(available ${s.availableBefore}, live ${s.liveBefore}/${s.limit}, claimable ${s.claimableBefore}, ${s.status})`);
        }
        if (s.liveBefore + s.attemptsCreated > s.limit) {
          violations.push(`[seed ${seed}, round ${r.round}] ${label}: ${s.liveBefore} live + ${s.attemptsCreated} new over the limit ${s.limit}`);
        }
      }
      if (violations.length) throw new Error(violations.slice(0, 10).join('\n'));
    };

    for (let round = 1; round <= scaled(160); round++) {
      for (const fn of back.get(round) ?? []) await fn();
      // Churn between rounds, every kind of way an agent leaves and comes back.
      const present = world.agents.filter((a) => a.attached && !a.left);
      const states = await world.runtime.agents.getMany(present.map((a) => a.sessionId));
      const idle = present.filter((_, i) => states[i]?.state === 'available');
      const pick = () => (idle.length ? idle.splice(rng.int(0, idle.length - 1), 1)[0] : undefined);
      if (rng.chance(0.5)) {
        const a = pick();
        if (a && (await world.goBreak(a)) === 'applied') later(round + rng.int(2, 8), async () => { await world.goAvailable(a); });
      }
      if (rng.chance(0.3)) {
        const a = pick();
        if (a) {
          await world.dropStation(a);
          later(round + rng.int(1, 6), async () => {
            const { state } = await world.reconnect(a);
            if (state === 'break' || state === 'offline') await world.goAvailable(a);
          });
        }
      }
      if (rng.chance(0.05) && lateJoins < 4) {
        lateJoins++;
        await world.joinLate(['A', 'B', 'C'][rng.int(0, 2)]!);
      }

      await checkedRound();
    }

    // A quiet tail: every agent on break (queued behind a live call), the calls left to end.
    // The churn alone skips only when a round lands between two events and before the 1 s
    // safety tick, which a slow runner can miss entirely (0 of 392 ticks in one CI run, 2-3 in
    // others, the same seed). A floor with nothing to do must skip, so the skipped rounds
    // below are certain, and they are held to the same law and limit as the churn's.
    const tailStart = seen.length;
    for (const a of world.agents.filter((x) => x.attached && !x.left)) await world.goBreak(a);
    for (let i = 0; i < scaled(80) && !seen.slice(tailStart).some((o) => o.mode === 'skipped'); i++) {
      await checkedRound();
    }
    for (const c of world.campaigns) {
      const peak = world.carrier.peakLiveByAccount.get(`${c.tenantId}:${c.accountId}`) ?? 0;
      expect(peak, `seed ${seed}: ${c.spec.label}`).toBeLessThanOrEqual(c.spec.maxConcurrentCalls);
    }
    const skipped = seen.filter((o) => o.mode === 'skipped').length;
    const missed = seen.filter((o) => o.mode === 'full' && o.cause === 'safety' && (o.plan?.toDial ?? 0) > 0).length;
    report(`PACING-CHURN seed ${seed}: ${seen.length} ticks, ${skipped} skipped, ${missed} missed wake-ups`);
    expect(skipped, 'the skip path was never exercised').toBeGreaterThan(0);
    expect(missed, `seed ${seed}: a safety tick found work no event announced`).toBe(0);
    expect(violations).toEqual([]);
  }, 300_000);
});
