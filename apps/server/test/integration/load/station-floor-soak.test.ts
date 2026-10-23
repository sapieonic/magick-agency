import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

// ---------------------------------------------------------------------------
// A realistic floor, soaked: many rounds of ready → offered call → connected →
// wrap-up → disposition → ready, over real station sockets, against real
// Postgres and real Redis.
//
// Every agent action is the console's request (the real HTTP routes) and every
// call is placed by the real pacing engine through the real dialer; only the
// carrier is scripted (`ScriptedBridge`). What each agent does in a round is
// chosen by a seeded script, so the floor is mixed the way a real one is:
//
//   * WORK       — take the call, write it up, go straight back to ready;
//   * BLIP       — take the call, lose the socket during wrap-up, reconnect,
//                  find the wrap-up still there (`ready.active_wrapup`), write it up;
//   * BREAK      — take the call, write it up, then go on break for a round;
//   * (on break) — sit the round out; the pacing engine must not offer them a call.
//
// The point of a soak is the END STATE after many rounds, so the invariants are
// checked at the end against Redis and Postgres together: every attempt ended and
// dispositioned, no contact stranded `in_flight`, every agent's Redis lease equal
// to its mirror row and to what its console was last told, every call offered to
// exactly one console, and nothing left in the registry, the ownership keyspace,
// the wrap-up timers or the dialer once the floor goes home.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createFloorWorld, sessionRows } = await import('./station-floor-harness.js');
const { STATION_INTERVALS } = await import('../../../src/api/routes/agency/helpers.js');
const { scaled, createRng, LOAD_SEED } = await import('../../helpers/load-scale.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type Agent = World['fleet']['agents'][number];
type Behaviour = 'work' | 'blip' | 'break';

const TENANTS = 2;
const PER_TENANT = scaled(50);
const FLOOR = TENANTS * PER_TENANT;
const ROUNDS = scaled(5);
const CATALOG = [
  { code: 'interested', label: 'Interested' },
  { code: 'not_interested', label: 'Not interested' },
  { code: 'wrong_person', label: 'Wrong person' },
];
/** Ticks a round may spend getting every ready agent a call before it is a stall. */
const MAX_TICKS_PER_ROUND = 40;
const DEADLOCK_BOUND_MS = 240_000;

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-floor-soak] seed=${LOAD_SEED} floor=${FLOOR} rounds=${ROUNDS}`);
});
beforeEach(truncateAll);
afterEach(async () => {
  await world?.teardown();
  world = null;
});
afterAll(closeTestPool);

type Frame = Record<string, unknown>;
/** The attempt a frame is about, wherever that frame type carries it. */
function attemptOf(f: Frame | null): string | undefined {
  if (!f) return undefined;
  if (f['event'] === 'reserved') return (f['attempt'] as Frame | undefined)?.['attempt_id'] as string | undefined;
  if (f['event'] === 'wrapup') return (f['wrapup'] as Frame | undefined)?.['attempt_id'] as string | undefined;
  return f['attempt_id'] as string | undefined;
}
/** `reserved` frames this console received, across every leg, in order. */
function reservations(a: Agent): Frame[] {
  return a.allFrames().map((f) => f.frame).filter((f): f is Frame => f?.['event'] === 'reserved');
}
/** Attempt ids offered to this console, in order. */
function offered(a: Agent): string[] {
  return reservations(a).map((f) => attemptOf(f)!);
}
/** The event names this console received about one attempt, in order. */
function framesFor(a: Agent, attemptId: string): string[] {
  return a.allFrames().map((f) => f.frame).filter((f) => attemptOf(f) === attemptId).map((f) => String(f!['event']));
}
function lastAgentState(a: Agent): string | undefined {
  // The newest leg's view: its `ready`, then every `agent_state` after it.
  const leg = a.leg!;
  let state = leg.ready?.['state'] as string | undefined;
  for (const f of leg.frames) if (f.frame?.['event'] === 'agent_state') state = f.frame['state'] as string;
  return state;
}

describe('a mixed floor soaked through many call cycles (integration, load)', () => {
  it('ends with every call written up, every agent consistent, and nothing leaked', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createFloorWorld({
      tenants: TENANTS, agentsPerTenant: PER_TENANT,
      contactsPerCampaign: PER_TENANT * ROUNDS + PER_TENANT,
      campaign: {
        // A held wrap-up: a disposition is owed and the window is long enough that
        // only the agent's disposition ends it inside a round.
        wrapup_seconds: 120,
        wrapup_auto_return: true,
        disposition_catalog: JSON.stringify(CATALOG),
      },
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    const agents = w.fleet.agents;
    const script = createRng(LOAD_SEED + 7);

    await w.fleet.connectAll();
    for (const a of agents) a.leg!.startHeartbeat(STATION_INTERVALS.heartbeat_ms);
    expect((await Promise.all(agents.map((a) => a.goAvailable()))).every((s) => s === 200)).toBe(true);

    /** On break for the whole of the current round. */
    let resting = new Set<Agent>();
    /** Went on break during the current round; they rest through the next one. */
    let goingOnBreak = new Set<Agent>();
    const handled = new Set<string>();
    const tally: Record<string, number> = { work: 0, blip: 0, break: 0, sat_out: 0 };

    for (let round = 0; round < ROUNDS; round++) {
      // ── Who is ready this round ─────────────────────────────────────────
      // Last round's resters come back; last round's breakers rest this one out.
      const comingBack = [...resting];
      resting = goingOnBreak;
      goingOnBreak = new Set();
      expect((await Promise.all(comingBack.map((a) => a.goAvailable()))).every((s) => s === 200),
        `round ${round}: a returning agent could not go available`).toBe(true);
      const ready = agents.filter((a) => !resting.has(a));
      const before = new Map(agents.map((a) => [a.sessionId, offered(a).length]));

      // ── The pacing engine offers every ready agent a call ───────────────
      for (let t = 0; t < MAX_TICKS_PER_ROUND; t++) {
        if (ready.every((a) => offered(a).length > before.get(a.sessionId)!)) break;
        await w.tickAll();
        await new Promise((r) => setTimeout(r, 5));
      }
      for (const a of ready) {
        expect(offered(a).length, `round ${round}: ${a.label} was offered ${offered(a).length - before.get(a.sessionId)!} calls`)
          .toBe(before.get(a.sessionId)! + 1);
      }
      // Every tick of this round ran with the resters on break: none was offered a call.
      for (const a of resting) {
        expect(offered(a).length, `round ${round}: ${a.label} was dialed on break`).toBe(before.get(a.sessionId));
      }

      // ── Every console works its call, by script ─────────────────────────
      await Promise.all(ready.map(async (a) => {
        const attemptId = offered(a).at(-1)!;
        expect(handled.has(attemptId), `attempt ${attemptId} offered twice`).toBe(false);
        handled.add(attemptId);
        // The scripted carrier answered, bridged and completed it: the console
        // sees the release and, because a disposition is owed, the wrap-up.
        await w.fleet.waitFor(() => framesFor(a, attemptId).includes('wrapup'),
          () => `${a.label}: wrap-up for ${attemptId} (got ${framesFor(a, attemptId).join(',')})`, 30_000);
        const seen = framesFor(a, attemptId);
        expect(seen.indexOf('reserved')).toBeLessThan(seen.indexOf('bridged'));
        expect(seen.indexOf('bridged')).toBeLessThan(seen.indexOf('released'));

        const behaviour = script.pick<Behaviour>(['work', 'work', 'work', 'work', 'work', 'blip', 'break']);
        tally[behaviour]!++;
        if (behaviour === 'blip') {
          const old = a.leg!;
          old.terminate();
          await w.fleet.waitFor(() => w.runtime.stations.socketFor(a.sessionId) === undefined,
            `${a.label}: the server to notice the drop`);
          const leg = await a.connectReady();
          leg.startHeartbeat(STATION_INTERVALS.heartbeat_ms);
          // The wrap-up is an in-process timer: it survived the drop, and the new
          // socket is told where it stands.
          expect((leg.ready?.['active_wrapup'] as Record<string, unknown> | undefined)?.['attempt_id'],
            `${a.label}: reconnect lost the wrap-up`).toBe(attemptId);
        }

        const legBefore = a.leg!;
        const statesBefore = legBefore.ofEvent('agent_state').length;
        expect(await a.submitDisposition(attemptId, script.pick(CATALOG).code)).toBe(200);
        await w.fleet.waitFor(() => legBefore.ofEvent('agent_state').slice(statesBefore).some((f) => f['state'] === 'available'),
          `${a.label}: back to available after the disposition`);

        if (behaviour === 'break') {
          expect(await a.goBreak(w.tenantOf(a).breakReason)).toBe(200);
          goingOnBreak.add(a);
        }
      }));
      tally['sat_out']! += resting.size;
    }

    // ── A last pass with both break crowds out: they are not dialed ─────────
    const onBreak = new Set([...resting, ...goingOnBreak]);
    const restingOffers = new Map([...onBreak].map((a) => [a.sessionId, offered(a).length]));
    await w.tickAll();
    await w.tickAll();
    for (const a of onBreak) expect(offered(a).length, `${a.label} was dialed on break`).toBe(restingOffers.get(a.sessionId));
    // The rest were dialed again by that pass; let those calls finish so the end
    // state is quiescent, then write them up.
    const lastRound = agents.filter((a) => !onBreak.has(a) && offered(a).some((id) => !handled.has(id)));
    await Promise.all(lastRound.map(async (a) => {
      const attemptId = offered(a).find((id) => !handled.has(id))!;
      handled.add(attemptId);
      await w.fleet.waitFor(() => framesFor(a, attemptId).includes('wrapup'), `${a.label}: final wrap-up`, 30_000);
      expect(await a.submitDisposition(attemptId, 'interested')).toBe(200);
    }));
    console.log(`[station-floor-soak] behaviours: ${JSON.stringify(tally)}; calls: ${handled.size}`);

    // ── Postgres: every attempt ended and written up; no contact stranded ──
    const pool = getTestPool();
    const campaignIds = w.tenants.map((t) => t.campaignId);
    const { rows: attempts } = await pool.query<{ id: string; state: string; disposition_code: string | null; reserved_agent_id: string; bridged_at: Date | null }>(
      `SELECT id, state, disposition_code, reserved_agent_id, bridged_at FROM agency_call_attempts WHERE campaign_id = ANY($1::uuid[])`,
      [campaignIds],
    );
    expect(attempts).toHaveLength(handled.size);
    expect(new Set(attempts.map((r) => r.id))).toEqual(handled);
    for (const r of attempts) {
      expect(r.state, `attempt ${r.id}`).toBe('ended');
      expect(r.bridged_at, `attempt ${r.id}`).not.toBeNull();
      expect(CATALOG.map((c) => c.code), `attempt ${r.id} disposition`).toContain(r.disposition_code);
    }
    const { rows: stranded } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts WHERE campaign_id = ANY($1::uuid[]) AND state = 'in_flight'`, [campaignIds],
    );
    expect(stranded[0]!.n, 'contacts stranded in_flight').toBe(0);

    // Every call was offered to exactly ONE console, and it was that attempt's agent.
    const owner = new Map(attempts.map((r) => [r.id, r.reserved_agent_id]));
    const offeredTo = new Map<string, string[]>();
    for (const a of agents) for (const id of offered(a)) offeredTo.set(id, [...(offeredTo.get(id) ?? []), a.sessionId]);
    for (const [id, who] of offeredTo) {
      expect(who, `attempt ${id} offered to ${who.length} consoles`).toHaveLength(1);
      expect(who[0]).toBe(owner.get(id));
    }
    // …and only ever a call from the console's own campaign (and so tenant).
    for (const a of agents) {
      for (const f of reservations(a)) expect((f['attempt'] as Frame)['campaign_id'], a.label).toBe(a.campaignId);
    }

    // ── Every agent: Redis lease = mirror row = what the console last heard ─
    const expected = (a: Agent) => (onBreak.has(a) ? 'break' : 'available');
    await w.fleet.waitFor(async () => {
      const rows = await sessionRows(agents.map((a) => a.sessionId));
      return agents.every((a) => rows.get(a.sessionId)?.state === expected(a));
    }, 'every mirror row to settle');
    const live = await w.runtime.agents.getMany(agents.map((a) => a.sessionId));
    const rows = await sessionRows(agents.map((a) => a.sessionId));
    for (const [i, a] of agents.entries()) {
      expect(live[i]?.state, `${a.label} Redis`).toBe(expected(a));
      expect(rows.get(a.sessionId)?.state, `${a.label} row`).toBe(expected(a));
      expect(lastAgentState(a), `${a.label} console`).toBe(expected(a));
    }

    // ── The runtime holds nothing it should not ─────────────────────────────
    expect(w.runtime.stations.size()).toBe(FLOOR);
    expect(await w.keys('agency:station:*')).toHaveLength(FLOOR);
    expect(w.runtime.wrapup.active()).toBe(0);
    expect(w.runtime.dialer.activeAttemptIds()).toEqual([]);
    for (const a of agents) expect(a.legs.filter((l) => l.isOpen), a.label).toHaveLength(1);

    // ── The floor goes home ─────────────────────────────────────────────────
    await w.fleet.closeAll();
    await w.fleet.waitFor(() => w.runtime.stations.size() === 0, 'registry to drain');
    await w.fleet.waitFor(async () => [...(await sessionRows(agents.map((a) => a.sessionId))).values()].every((r) => r.state === 'offline'),
      'every row mirrored offline');
    expect(await w.keys('agency:station:*')).toEqual([]);
    expect(w.fleet.liveLegs()).toEqual([]);
    expect(w.fleet.heartbeatingLegs()).toEqual([]);
    expect(w.runtime.wrapup.active()).toBe(0);
    expect(w.runtime.breaks.peek(agents[0]!.sessionId)).toBeFalsy();
  });
});
