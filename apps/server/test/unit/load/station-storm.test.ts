import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// A full floor connecting at once — storms, supersede races and churn on the
// station socket, over real sockets.
//
// Every existing station test drives one socket, or two (`station-supersede-
// stomp.test.ts`). The guards those tests pin — supersede with 4409, the
// socket-scoped `detach` / `heartbeat` / `send`, the close handler's "a superseded
// socket must not release its replacement", the `stillOurs` fence — are each
// argued in the code as properties of the ORDER of a handful of awaits. Order is
// exactly what a hundred simultaneous upgrades scramble, so this file asks the same
// questions of a whole floor at once and checks the answers against the registry,
// the Redis keys and what every console actually received:
//
//   * a storm registers every agent exactly once, with its ownership key, and no
//     console receives a frame meant for another agent, campaign or tenant;
//   * an agent opening several tabs at once ends with exactly one live station —
//     every other tab closed 4401 (its token was replaced by a later mint) or 4409
//     (superseded) — and the agent's state is never stomped by a loser;
//   * rapid connect/disconnect churn leaves the final socket attached, no ghost
//     entry, and the console's `ready` agreeing with Redis.
//
// Tier: the real route, runtime, registry and token store over real `ws`; the
// repository and Redis are doubles (see `station-load-harness.ts`). The same storm
// against real Postgres and Redis is `test/integration/load/station-floor.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    masterService: { url: 'https://directory.test', s2sToken: 'tok' },
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
  },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    isEnabled: vi.fn().mockResolvedValue(true),
    getValue: vi.fn().mockResolvedValue(1800),
  }),
  FLAGS: {
    agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false },
    webrtc_max_duration_seconds: { default: 1800 },
  },
}));

const { sessions, hooks } = vi.hoisted(() => ({
  sessions: new Map<string, Record<string, unknown>>(),
  /** Delay injected into the session read, to scramble setup order on purpose. */
  hooks: { sessionReadDelay: null as null | (() => number) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null), reapNonTerminal: vi.fn() },
  agencyCampaignRepository: { findById: vi.fn() },
  agencyContactRepository: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
  agencyAgentSessionRepository: {
    findById: vi.fn(async (id: string) => {
      const d = hooks.sessionReadDelay?.() ?? 0;
      if (d > 0) await new Promise((r) => setTimeout(r, d));
      return sessions.get(id) ?? null;
    }),
    setState: vi.fn(async (id: string, state: string) => {
      const row = sessions.get(id);
      if (row) row['state'] = state;
    }),
    leave: vi.fn(),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getAllowRecording: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: { create: vi.fn(), findById: vi.fn(), update: vi.fn() },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class { get() { return {}; } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

const { createStationWorld, leakReport, NO_LEAKS } = await import('./station-load-harness.js');
const { STATION_INTERVALS } = await import('../../../src/api/routes/agency/helpers.js');
const { AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { AGENCY_STATION_CLOSE } = await import('@magick-agency/contracts/agency');
const { scaled, createRng, LOAD_SEED, LOAD_SCALE } = await import('../../helpers/load-scale.js');

/** Per-test deadlock bound. Generous on purpose: a healthy run takes a few seconds. */
const DEADLOCK_BOUND_MS = 60_000 * Math.max(1, LOAD_SCALE);

type World = Awaited<ReturnType<typeof createStationWorld>>;
type Agent = World['fleet']['agents'][number];

const FLOOR = scaled(150);
const RACE_FLOOR = scaled(60);

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-storm] seed=${LOAD_SEED} floor=${FLOOR} raceFloor=${RACE_FLOOR}`);
});

afterEach(async () => {
  hooks.sessionReadDelay = null;
  await world?.teardown();
  world = null;
});

/** Push one frame naming its addressee to every session, in a seeded order. */
function sendTagged(w: World, agents: readonly Agent[], tag: string): number {
  let delivered = 0;
  for (const a of w.rng.shuffle(agents)) {
    if (w.runtime.stations.send(a.sessionId, { event: 'error', code: 'invalid_frame', message: `${tag}:${a.sessionId}` })) delivered++;
  }
  return delivered;
}

function taggedFrames(a: Agent, tag: string): string[] {
  return a.allFrames()
    .map((f) => f.frame)
    .filter((f): f is Record<string, unknown> => f?.['event'] === 'error' && String(f['message']).startsWith(`${tag}:`))
    .map((f) => String(f['message']).slice(tag.length + 1));
}

/** Every console disconnects; then nothing may be left behind. */
async function disconnectAndAssertNoLeaks(w: World): Promise<void> {
  await w.fleet.closeAll();
  // The close handlers run after the client has seen its close; poll the registry.
  await w.fleet.waitFor(() => w.runtime.stations.size() === 0,
    () => `registry to drain (${w.runtime.stations.size()} entries left)`);
  expect(await leakReport(w)).toEqual(NO_LEAKS);
}

describe('a connection storm (load)', () => {
  it('registers every agent exactly once across tenants, with no cross-talk', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: FLOOR, tenants: 3, campaignsPerTenant: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    const agents = w.fleet.agents;

    // ── Everyone at once ─────────────────────────────────────────────────
    const legs = await w.fleet.connectAll();

    // Every console got ITS OWN ready, and it is still open.
    for (const [i, leg] of legs.entries()) {
      const a = agents[i]!;
      expect(leg.closed, `${a.label} was closed during the storm`).toBeNull();
      expect(leg.ofEvent('ready'), `${a.label}: exactly one ready`).toHaveLength(1);
      expect(leg.ready?.['session_id']).toBe(a.sessionId);
      // No lease existed, so the rehydrate rule lands everyone in `break`.
      expect(leg.ready?.['state']).toBe('break');
    }

    // ── The registry: once each, under the right campaign and tenant ──────
    expect(w.runtime.stations.size()).toBe(FLOOR);
    for (const a of agents) {
      const entry = w.runtime.stations.get(a.sessionId);
      expect(entry, `${a.label} not registered`).toBeDefined();
      expect(entry!.campaignId).toBe(a.campaignId);
      expect(entry!.tenantId).toBe(a.tenantId);
      expect(entry!.agentUserId).toBe(a.agentUserId);
    }
    for (const c of w.campaigns) {
      expect(new Set(w.runtime.stations.sessionIdsForCampaign(c.id)))
        .toEqual(new Set(agents.filter((a) => a.campaignId === c.id).map((a) => a.sessionId)));
    }

    // ── Redis: one ownership key per agent, naming this replica ───────────
    const keys = w.redis.keys('agency:station:');
    expect(keys).toEqual(agents.map((a) => w.ownershipKey(a.sessionId)).sort());
    for (const a of agents) {
      expect(JSON.parse(w.redis.rawGet(w.ownershipKey(a.sessionId))!)).toEqual({ replicaId: w.runtime.replicaId });
      expect(w.redis.agentState(a.sessionId)).toBe('break');
    }
    // Every token was consumed by its own upgrade.
    expect(w.redis.keys('agency:station-token:')).toEqual([]);

    // ── No cross-talk, per session ────────────────────────────────────────
    expect(sendTagged(w, agents, 'direct')).toBe(FLOOR);
    await w.fleet.waitForAll((a) => taggedFrames(a, 'direct').length >= 1, 'every direct frame to land');
    for (const a of agents) expect(taggedFrames(a, 'direct'), a.label).toEqual([a.sessionId]);

    // ── …and per campaign, which is the tenant boundary too ───────────────
    for (const c of w.campaigns) {
      const sent = w.runtime.stations.broadcast(c.id, {
        event: 'campaign_state', campaign_id: c.id, status: 'paused',
        reason: 'paused_by_supervisor', dialing: false, message: c.tenantId,
      });
      expect(sent).toBe(agents.filter((a) => a.campaignId === c.id).length);
    }
    await w.fleet.waitForAll((a) => a.leg!.has('campaign_state'), 'every campaign broadcast to land');
    for (const a of agents) {
      const states = a.leg!.ofEvent('campaign_state');
      expect(states, `${a.label}: one broadcast, its own campaign`).toHaveLength(1);
      expect(states[0]!['campaign_id']).toBe(a.campaignId);
      expect(states[0]!['message']).toBe(a.tenantId);
    }

    // ── A token is bound to its session, across tenants ───────────────────
    // A console holding a fresh token for ITS session presents it on another
    // tenant's session: refused 4401, and the victim's station is untouched.
    const victims = agents.filter((a) => a.tenantId === w.tenants[1]).slice(0, 10);
    const thieves = agents.filter((a) => a.tenantId === w.tenants[0]).slice(0, victims.length);
    const stolen = await Promise.all(thieves.map(async (t, i) => {
      const token = (await w.runtime.tokens.mint(t.sessionId)).token;
      return victims[i]!.openWithToken(token);
    }));
    await w.fleet.waitFor(() => stolen.every((l) => l.closed !== null), 'every cross-session upgrade to be refused');
    for (const l of stolen) expect(l.closed?.code).toBe(AGENCY_STATION_CLOSE.TOKEN_REJECTED);
    for (const v of victims) {
      expect(v.legs[0]!.isOpen, `${v.label}'s station was disturbed by a refused upgrade`).toBe(true);
      expect(w.runtime.stations.isLocallyOwned(v.sessionId)).toBe(true);
    }

    await disconnectAndAssertNoLeaks(w);
    // A sole socket closing is a genuine absence: every agent is written offline.
    await w.fleet.waitForAll((a) => w.redis.agentState(a.sessionId) === 'offline', 'every agent written offline');
  });
});

describe('supersede races (load)', () => {
  it('several tabs per agent minting and connecting at once leave exactly one live station', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: RACE_FLOOR, tenants: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    const agents = w.fleet.agents;
    // Mid-shift: every agent is in the pool. A loser that wrote them offline
    // would be the stomp `station-supersede-stomp.test.ts` pins for one pair.
    for (const a of agents) await w.runtime.agents.set(a.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });

    // Each tab opens after a seeded 0–30ms, so some tabs authenticate before a
    // sibling mints (and are then superseded) while others lose their token to a
    // later mint. Which mix a run gets is printed, never asserted: it is timing.
    const tabs = new Map(agents.map((a) => [a.sessionId, w.rng.int(2, 5)]));
    const opens = agents.flatMap((a) => Array.from({ length: tabs.get(a.sessionId)! }, () => ({ a, delay: w.rng.int(0, 30) })));
    await Promise.all(opens.map(async ({ a, delay }) => {
      await new Promise((r) => setTimeout(r, delay));
      return a.connect();
    }));

    // Settled: every agent has exactly one open leg and every other leg closed.
    await w.fleet.waitForAll(
      (a) => a.legs.length === tabs.get(a.sessionId)
        && a.legs.filter((l) => l.closed === null).length === 1
        && a.legs.filter((l) => l.closed !== null).length === a.legs.length - 1
        && a.legs.some((l) => l.closed === null && l.ready !== undefined),
      'one surviving tab per agent, with its ready',
    );

    const codes = new Map<number, number>();
    for (const a of agents) {
      const survivor = a.legs.find((l) => l.closed === null)!;
      expect(survivor.isOpen).toBe(true);
      expect(survivor.ready?.['state'], `${a.label}: a losing tab stomped the agent`).toBe('available');
      for (const l of a.legs) {
        if (l === survivor) continue;
        codes.set(l.closed!.code, (codes.get(l.closed!.code) ?? 0) + 1);
        // The only two right answers: the token was replaced by a later mint, or
        // the tab authenticated and was superseded. Never 1005/1006, never 4404.
        expect([AGENCY_STATION_CLOSE.TOKEN_REJECTED, AGENCY_STATION_CLOSE.SUPERSEDED], `${a.label}`)
          .toContain(l.closed!.code);
      }
      expect(w.redis.agentState(a.sessionId), `${a.label}: state after the race`).toBe('available');
    }
    console.log(`[station-storm] tab race close codes: ${JSON.stringify(Object.fromEntries(codes))}`);

    // The registry holds ONE socket per agent and it is the survivor's: a frame
    // sent by session id reaches that tab and no other.
    expect(w.runtime.stations.size()).toBe(RACE_FLOOR);
    expect(w.redis.keys('agency:station:')).toHaveLength(RACE_FLOOR);
    sendTagged(w, agents, 'who');
    await w.fleet.waitForAll((a) => taggedFrames(a, 'who').length >= 1, 'every survivor to receive its frame');
    for (const a of agents) {
      for (const l of a.legs) {
        const got = l.ofEvent('error').filter((f) => String(f['message']).startsWith('who:'));
        expect(got, `${a.label}`).toHaveLength(l.closed === null ? 1 : 0);
      }
    }

    await disconnectAndAssertNoLeaks(w);
  });

  it('when every tab authenticated, all but one are superseded with 4409', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: RACE_FLOOR,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(LOAD_SEED + 1),
    });
    const w = world;
    const agents = w.fleet.agents;
    for (const a of agents) await w.runtime.agents.set(a.sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    // Scramble SETUP order across the tabs: the session read is the first await
    // after the token, so a seeded delay there decides which tab attaches last.
    const delays = createRng(LOAD_SEED + 2);
    hooks.sessionReadDelay = () => delays.int(0, 15);

    const tabs = new Map(agents.map((a) => [a.sessionId, w.rng.int(2, 5)]));
    await Promise.all(agents.map(async (a) => {
      for (let i = 0; i < tabs.get(a.sessionId)!; i++) {
        await a.connect();
        // Hold the next mint until this tab's token is consumed, so every tab
        // authenticates — the race left is the one between their setups.
        const key = `agency:station-token:${a.sessionId}`;
        await w.fleet.waitFor(() => w.redis.rawGet(key) === undefined, `${a.label} tab ${i} to consume its token`);
      }
    }));

    await w.fleet.waitForAll(
      (a) => a.legs.filter((l) => l.closed === null).length === 1
        && a.legs.filter((l) => l.closed !== null).length === a.legs.length - 1
        && a.legs.some((l) => l.closed === null && l.ready !== undefined),
      'one surviving tab per agent',
    );
    for (const a of agents) {
      for (const l of a.legs) {
        if (l.closed === null) {
          expect(l.ready?.['state']).toBe('available');
        } else {
          expect(l.closed.code, `${a.label}: an authenticated loser must hear 4409`).toBe(AGENCY_STATION_CLOSE.SUPERSEDED);
        }
      }
      expect(w.redis.agentState(a.sessionId)).toBe('available');
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(true);
    }
    expect(w.runtime.stations.size()).toBe(RACE_FLOOR);

    await disconnectAndAssertNoLeaks(w);
  });
});

describe('rapid connect/disconnect churn (load)', () => {
  it('leaves only the final socket attached, and the console agreeing with Redis', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: RACE_FLOOR, tenants: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(LOAD_SEED + 3),
    });
    const w = world;
    const agents = w.fleet.agents;
    const delays = createRng(LOAD_SEED + 4);
    hooks.sessionReadDelay = () => delays.int(0, 5);

    const finals = await Promise.all(agents.map((a) => a.churn(w.rng.int(2, 6))));
    await w.fleet.waitFor(
      () => finals.every((l) => l.ready !== undefined || l.closed !== null),
      'every final leg to be ready',
    );
    // Every earlier leg must be gone, on both ends.
    await w.fleet.waitForAll((a) => a.legs.slice(0, -1).every((l) => l.closed !== null), 'every churned leg to close');
    // And the server must have finished its close handlers: the registry holds
    // exactly the final sockets.
    await w.fleet.waitFor(() => w.runtime.stations.size() === RACE_FLOOR,
      () => `registry to hold one entry per agent (has ${w.runtime.stations.size()})`);

    for (const [i, a] of agents.entries()) {
      const final = finals[i]!;
      expect(final.closed, `${a.label}'s final leg was closed`).toBeNull();
      expect(final.ready, `${a.label}'s final leg got no ready`).toBeDefined();
      // Churn can legitimately land the agent in `offline` (an earlier leg's close
      // handler ran while nothing was attached) or `break` (none did). What it may
      // NOT do is tell the console one thing and Redis another.
      expect(['offline', 'break']).toContain(final.ready!['state']);
      expect(w.redis.agentState(a.sessionId), `${a.label}: console says ${final.ready!['state']}`)
        .toBe(final.ready!['state']);
    }
    expect(w.redis.keys('agency:station:')).toHaveLength(RACE_FLOOR);
    sendTagged(w, agents, 'final');
    await w.fleet.waitForAll((a) => taggedFrames(a, 'final').length >= 1, 'every final leg to receive its frame');
    for (const [i, a] of agents.entries()) {
      expect(finals[i]!.ofEvent('error').filter((f) => String(f['message']).startsWith('final:'))).toHaveLength(1);
    }

    await disconnectAndAssertNoLeaks(w);
  });
});
