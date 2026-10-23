import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

// ---------------------------------------------------------------------------
// A full floor on the station socket, against real Postgres and real Redis.
//
// The unit tier (`test/unit/load/`) proves the transport rules at scale over a
// Redis double. This file is the composition: a floor of agents across several
// tenants joins over the real HTTP route, mints real tokens over the real re-mint
// route, connects through the real station route all at once, goes available
// over the real route — and then the network blips under them. Every assertion is
// read back from the three places that must agree: what each console received,
// the Redis keyspace (ownership keys, agent leases) and the `agency_agent_sessions`
// rows.
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
const { STATION_HEARTBEAT_GRACE_MS } = await import('@magick-agency/domain/timers');
const { AGENCY_STATION_CLOSE } = await import('@magick-agency/contracts/agency');
const { scaled, createRng, LOAD_SEED, LOAD_SCALE } = await import('../../helpers/load-scale.js');

type World = Awaited<ReturnType<typeof createFloorWorld>>;
type Agent = World['fleet']['agents'][number];

const TENANTS = 3;
const PER_TENANT = scaled(50);
const FLOOR = TENANTS * PER_TENANT;
/** Per-test deadlock bound. Generous on purpose: a healthy run is well under it. */
const DEADLOCK_BOUND_MS = 120_000 * Math.max(1, LOAD_SCALE);

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-floor] seed=${LOAD_SEED} tenants=${TENANTS} floor=${FLOOR}`);
});
beforeEach(truncateAll);
afterEach(async () => {
  await world?.teardown();
  world = null;
});
afterAll(closeTestPool);

async function newWorld(seedOffset = 0): Promise<World> {
  world = await createFloorWorld({
    tenants: TENANTS, agentsPerTenant: PER_TENANT, contactsPerCampaign: 1,
    heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(LOAD_SEED + seedOffset),
  });
  return world;
}

function sendTagged(w: World, agents: readonly Agent[], tag: string): void {
  for (const a of w.rng.shuffle(agents)) {
    w.runtime.stations.send(a.sessionId, { event: 'error', code: 'invalid_frame', message: `${tag}:${a.sessionId}` });
  }
}
function tagged(leg: NonNullable<Agent['leg']>, tag: string): string[] {
  return leg.ofEvent('error').map((f) => String(f['message'])).filter((m) => m.startsWith(`${tag}:`)).map((m) => m.slice(tag.length + 1));
}

async function agentStates(w: World, agents: readonly Agent[]): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  const live = await w.runtime.agents.getMany(agents.map((a) => a.sessionId));
  agents.forEach((a, i) => out.set(a.sessionId, live[i]?.state));
  return out;
}

/** Everyone leaves; nothing may be left in the registry or the ownership keyspace. */
async function disconnectAndAssertNoLeaks(w: World): Promise<void> {
  await w.fleet.closeAll();
  await w.fleet.waitFor(() => w.runtime.stations.size() === 0,
    () => `registry to drain (${w.runtime.stations.size()} left)`);
  // The close handler's writes (Redis, then the row mirror) are async; wait for
  // the last of them — the mirror — on every agent.
  const ids = w.fleet.agents.map((a) => a.sessionId);
  await w.fleet.waitFor(async () => [...(await sessionRows(ids)).values()].every((r) => r.state === 'offline'),
    'every session row to be mirrored offline');
  expect(await w.keys('agency:station:*')).toEqual([]);
  const states = await agentStates(w, w.fleet.agents);
  for (const a of w.fleet.agents) expect(states.get(a.sessionId), a.label).toBe('offline');
  expect(w.fleet.liveLegs()).toEqual([]);
  expect(w.fleet.heartbeatingLegs()).toEqual([]);
  expect(w.runtime.wrapup.active()).toBe(0);
  expect(w.runtime.dialer.activeAttemptIds()).toEqual([]);
}

describe('a full floor connecting at once (integration, load)', () => {
  it('joins, connects and goes available across tenants: once each, no cross-talk, three stores agreeing', { timeout: DEADLOCK_BOUND_MS }, async () => {
    const w = await newWorld();
    const agents = w.fleet.agents;
    expect(agents).toHaveLength(FLOOR);

    // ── The storm ─────────────────────────────────────────────────────────
    const legs = await w.fleet.connectAll();
    for (const [i, leg] of legs.entries()) {
      const a = agents[i]!;
      expect(leg.closed, `${a.label} closed in the storm`).toBeNull();
      expect(leg.ofEvent('ready'), a.label).toHaveLength(1);
      expect(leg.ready?.['session_id']).toBe(a.sessionId);
      expect(leg.ready?.['state']).toBe('break');
    }

    expect(w.runtime.stations.size()).toBe(FLOOR);
    expect(await w.keys('agency:station:*')).toEqual(agents.map((a) => `agency:station:${a.sessionId}`).sort());
    const owners = await w.redis.mget(...agents.map((a) => `agency:station:${a.sessionId}`));
    for (const raw of owners) expect(JSON.parse(raw!)).toEqual({ replicaId: w.runtime.replicaId });
    // Every token consumed by its own upgrade; none left replayable.
    expect(await w.keys('agency:station-token:*')).toEqual([]);
    for (const t of w.tenants) {
      expect(new Set(w.runtime.stations.sessionIdsForCampaign(t.campaignId)))
        .toEqual(new Set(agents.filter((a) => a.tenantId === t.tenantId).map((a) => a.sessionId)));
    }
    const rows = await sessionRows(agents.map((a) => a.sessionId));
    for (const a of agents) {
      expect(rows.get(a.sessionId)?.state, a.label).toBe('break');
      expect(rows.get(a.sessionId)?.left_at).toBeNull();
      expect(rows.get(a.sessionId)?.tenant_id).toBe(a.tenantId);
    }

    // ── No cross-talk: by session, and by campaign (= tenant here) ────────
    sendTagged(w, agents, 'direct');
    for (const t of w.tenants) {
      w.runtime.stations.broadcast(t.campaignId, {
        event: 'campaign_state', campaign_id: t.campaignId, status: 'paused',
        reason: 'paused_by_supervisor', dialing: false, message: t.tenantId,
      });
    }
    await w.fleet.waitForAll((a) => tagged(a.leg!, 'direct').length === 1 && a.leg!.has('campaign_state'),
      'every direct frame and broadcast to land');
    for (const a of agents) {
      expect(tagged(a.leg!, 'direct')).toEqual([a.sessionId]);
      const cs = a.leg!.ofEvent('campaign_state');
      expect(cs).toHaveLength(1);
      expect(cs[0]!['message'], `${a.label} heard another tenant's campaign`).toBe(a.tenantId);
    }

    // ── Tenant isolation on the HTTP side of the station ──────────────────
    // Tenant B's headers cannot mint tenant A's station token (the session is not
    // in B's account), nor make tenant A's agent available.
    const [ta, tb] = w.tenants;
    const victim = agents.find((a) => a.tenantId === ta!.tenantId)!;
    expect((await w.post(`/sessions/${victim.sessionId}/station-token`, tb!, { agent_user_id: victim.agentUserId })).statusCode).toBe(404);
    expect((await w.post(`/sessions/${victim.sessionId}/available`, tb!, { agent_user_id: victim.agentUserId })).statusCode).toBe(404);
    expect(victim.leg!.isOpen).toBe(true);

    // ── Everyone goes available at once ───────────────────────────────────
    const statuses = await Promise.all(agents.map((a) => a.goAvailable()));
    expect(statuses.every((s) => s === 200), `available statuses: ${[...new Set(statuses)]}`).toBe(true);
    await w.fleet.waitForAll((a) => a.leg!.ofEvent('agent_state').some((f) => f['state'] === 'available'),
      'every console to be told it is available');
    const live = await agentStates(w, agents);
    const mirrored = await sessionRows(agents.map((a) => a.sessionId));
    for (const a of agents) {
      expect(live.get(a.sessionId), a.label).toBe('available');
      expect(mirrored.get(a.sessionId)?.state, a.label).toBe('available');
      // Exactly one state frame, and it is this agent's.
      expect(a.leg!.ofEvent('agent_state'), a.label).toHaveLength(1);
    }

    await disconnectAndAssertNoLeaks(w);
  });
});

describe('a network blip under a full floor (integration, load)', () => {
  it('reconnect storm: no ghost stations, no stomped state, and Redis consistent with every console', { timeout: DEADLOCK_BOUND_MS }, async () => {
    const w = await newWorld(1);
    const agents = w.fleet.agents;
    await w.fleet.connectAll();
    expect((await Promise.all(agents.map((a) => a.goAvailable()))).every((s) => s === 200)).toBe(true);
    await w.fleet.waitForAll((a) => a.leg!.has('agent_state'), 'every console available');
    for (const a of agents) a.leg!.startHeartbeat(STATION_INTERVALS.heartbeat_ms);

    // Three populations, picked by the seed:
    //  - DROPPED: the TCP connection dies with no close frame, the server notices,
    //    and the console reconnects after a seeded jitter;
    //  - OVERLAP: the console reconnects BEFORE the server has noticed anything —
    //    the old socket is still open from the server's side, so the new one
    //    supersedes it (the console's own blip detection firing early);
    //  - WANDERED: the console's heartbeat dies and the socket stays up — nothing
    //    reconnects until the heartbeat sweep has reaped it.
    const shuffled = w.rng.shuffle(agents);
    const third = Math.floor(FLOOR / 3);
    const dropped = shuffled.slice(0, third);
    const overlap = shuffled.slice(third, 2 * third);
    const wandered = shuffled.slice(2 * third);
    const oldLegs = new Map(agents.map((a) => [a.sessionId, a.leg!]));

    // ── The blip, all at once ─────────────────────────────────────────────
    for (const a of dropped) a.leg!.terminate();
    for (const a of wandered) a.leg!.stopHeartbeat();
    // Everything attached or pinged before this instant predates the blip;
    // everything after is a reconnect. The sweep below selects on exactly that.
    await new Promise((r) => setTimeout(r, 5));
    const blipAt = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await Promise.all(overlap.map(async (a) => {
      await new Promise((r) => setTimeout(r, w.rng.int(0, 50)));
      return a.connect();
    }));
    await w.fleet.waitFor(() => dropped.every((a) => !w.runtime.stations.isLocallyOwned(a.sessionId)),
      'the server to notice every dropped socket');
    await Promise.all(dropped.map(async (a) => {
      await new Promise((r) => setTimeout(r, w.rng.int(0, 200)));
      return a.connect();
    }));

    await w.fleet.waitForAll((a) => a.leg !== oldLegs.get(a.sessionId) && (a.leg!.ready !== undefined || a.leg!.closed !== null),
      'every reconnecting console to get its ready', { agents: [...dropped, ...overlap] });
    for (const a of [...dropped, ...overlap]) a.leg!.startHeartbeat(STATION_INTERVALS.heartbeat_ms);
    for (const a of [...dropped, ...overlap]) a.leg!.ping();
    await w.fleet.waitForAll((a) => a.leg!.pongs() >= 1, 'a pong on every new leg', { agents: [...dropped, ...overlap] });

    // The sweep pass that runs once the wandered consoles' grace has lapsed and
    // nobody else's has: its grace is "everything silent since the blip". Both
    // `graceMs` and `now` are the sweep's own parameters, so this is the
    // production pass, run at the instant that matters rather than waited for.
    const now = Date.now();
    expect(now - blipAt).toBeLessThan(STATION_HEARTBEAT_GRACE_MS);
    const reaped = w.runtime.sweepSilentStations(now - blipAt, now);
    expect(reaped, 'the sweep reaped a console that had reconnected, or missed a silent one').toBe(wandered.length);
    await w.fleet.waitForAll((a) => a.leg!.closed !== null, 'every wandered console to be closed', { agents: wandered });
    for (const a of wandered) expect(a.leg!.closed!.code, a.label).toBe(AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT);
    await w.fleet.waitFor(() => wandered.every((a) => !w.runtime.stations.isLocallyOwned(a.sessionId)),
      'the reaped stations to detach');
    // They come back too.
    await Promise.all(wandered.map((a) => a.connect()));
    await w.fleet.waitForAll((a) => a.leg!.ready !== undefined || a.leg!.closed !== null, 'every console to be back');

    // ── Supersede: every overlapped old leg was told 4409 ─────────────────
    for (const a of overlap) {
      expect(oldLegs.get(a.sessionId)!.closed?.code, a.label).toBe(AGENCY_STATION_CLOSE.SUPERSEDED);
    }

    // ── No ghosts: one station per agent, and it is the newest leg ────────
    await w.fleet.waitFor(() => w.runtime.stations.size() === FLOOR,
      () => `registry to hold one station per agent (${w.runtime.stations.size()})`);
    for (const a of agents) {
      expect(a.legs.filter((l) => l.isOpen), `${a.label}: open legs`).toHaveLength(1);
      expect(a.leg!.isOpen, `${a.label}'s newest leg is not the open one`).toBe(true);
    }
    sendTagged(w, agents, 'after-blip');
    await w.fleet.waitForAll((a) => tagged(a.leg!, 'after-blip').length === 1, 'every newest leg to get its frame');
    for (const a of agents) {
      for (const l of a.legs.slice(0, -1)) expect(tagged(l, 'after-blip'), `${a.label}: a ghost leg received a frame`).toEqual([]);
    }
    expect(await w.keys('agency:station:*')).toHaveLength(FLOOR);
    // A second pass right now finds nothing to reap: no ghost entry survives.
    expect(w.runtime.sweepSilentStations()).toBe(0);

    // ── No stomped state, and every console agrees with Redis ─────────────
    // OVERLAP agents never lost their station, so they are still in the pool —
    // the superseded socket's close must not have written them offline. DROPPED
    // and WANDERED agents genuinely had no station for a moment, so they were
    // written offline and their new `ready` says so.
    const live = await agentStates(w, agents);
    for (const a of overlap) {
      expect(live.get(a.sessionId), `${a.label}: the superseded socket stomped the agent`).toBe('available');
      expect(a.leg!.ready?.['state']).toBe('available');
    }
    for (const a of [...dropped, ...wandered]) {
      expect(live.get(a.sessionId), a.label).toBe(a.leg!.ready?.['state']);
      expect(a.leg!.ready?.['state'], `${a.label} came back dialable without choosing to`).not.toBe('available');
    }

    // ── And everyone who lost the pool can rejoin it ──────────────────────
    const back = await Promise.all([...dropped, ...wandered].map((a) => a.goAvailable()));
    expect(back.every((s) => s === 200)).toBe(true);
    const after = await agentStates(w, agents);
    const rows = await sessionRows(agents.map((a) => a.sessionId));
    for (const a of agents) {
      expect(after.get(a.sessionId), a.label).toBe('available');
      expect(rows.get(a.sessionId)?.state, a.label).toBe('available');
    }

    await disconnectAndAssertNoLeaks(w);
  });
});
