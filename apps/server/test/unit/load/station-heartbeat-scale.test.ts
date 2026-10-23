import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The heartbeat grace, enforced across a whole floor.
//
// `station-heartbeat-grace.test.ts` pins the sweep's rules one socket at a time
// by calling `sweepSilentStations` with a hand-picked `now`. What it cannot show is
// the sweep doing its job on a FLOOR, on its own timer: that a seeded subset of
// consoles whose heartbeat timer dies is closed 4408 — exactly those, no more —
// while every console that kept pinging at the protocol's cadence is left alone
// with every ping answered; that the agents it reaped can come straight back; and
// that once the floor empties the sweep's interval disarms itself.
//
// ── The clock ──────────────────────────────────────────────────────────────
//
// `Date`, `setInterval` and `clearInterval` are faked, and nothing else. That is
// exactly the set the heartbeat path reads: the sweep is a `setInterval`, the
// grace is measured with `Date.now()`, and the consoles' heartbeats are
// `setInterval`s too — so advancing the clock IS the floor pinging and the sweep
// running, in the production order, with the production numbers
// (`STATION_INTERVALS.heartbeat_ms`, `STATION_HEARTBEAT_GRACE_MS`,
// `STATION_HEARTBEAT_SWEEP_MS`). `setTimeout` / `setImmediate` stay real, because
// the sockets, the close handshake and this file's polling run on them.
//
// The clock is advanced in steps, and after each step the file waits — by
// polling state — for every ping that step fired to be answered, so each ping is
// stamped at the fake instant it was sent at. No assertion depends on how fast
// the box is.
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
const { sessions } = vi.hoisted(() => ({ sessions: new Map<string, Record<string, unknown>>() }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null), reapNonTerminal: vi.fn() },
  agencyCampaignRepository: { findById: vi.fn() },
  agencyContactRepository: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
  agencyAgentSessionRepository: {
    findById: vi.fn(async (id: string) => sessions.get(id) ?? null),
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
const {
  STATION_HEARTBEAT_GRACE_MS, STATION_HEARTBEAT_SWEEP_MS, STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT,
} = await import('@magick-agency/domain/timers');
const { AGENCY_STATION_CLOSE } = await import('@magick-agency/contracts/agency');
const { scaled, createRng, LOAD_SEED } = await import('../../helpers/load-scale.js');

/** Per-test deadlock bound. Generous on purpose: a healthy run takes a few seconds. */
const DEADLOCK_BOUND_MS = 60_000;

type World = Awaited<ReturnType<typeof createStationWorld>>;
type Agent = World['fleet']['agents'][number];

const FLOOR = scaled(150);
/** Clock step. Divides the ping cadence and the sweep cadence, so no tick is skipped. */
const STEP_MS = 5_000;

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-heartbeat-scale] seed=${LOAD_SEED} floor=${FLOOR}`);
});

afterEach(async () => {
  vi.useRealTimers();
  await world?.teardown();
  world = null;
});

/**
 * Advance the fake clock by `ms` in {@link STEP_MS} steps, and after each step
 * wait until every live leg's pings have all been answered — so the next step's
 * sweep reads a `lastSeen` stamped at the fake instant the ping was sent.
 */
async function advance(w: World, ms: number): Promise<void> {
  for (let done = 0; done < ms; done += STEP_MS) {
    vi.advanceTimersByTime(STEP_MS);
    await w.fleet.waitFor(
      () => w.fleet.agents.every((a) => a.legs.every((l) => !l.isOpen || !l.heartbeating || l.pongs() === l.pingsSent)),
      'every ping fired by this step to be answered',
    );
  }
}

describe('the heartbeat grace on a full floor (load)', () => {
  it('reaps exactly the consoles that went silent, leaves the rest untouched, and goes dormant once the floor empties', { timeout: DEADLOCK_BOUND_MS }, async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'], now: new Date('2026-10-23T09:00:00Z') });
    world = await createStationWorld({
      sessions: sessions as never, agents: FLOOR, tenants: 2, campaignsPerTenant: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    const agents = w.fleet.agents;

    await w.fleet.connectAll();
    expect(w.runtime.stations.size()).toBe(FLOOR);
    expect(w.runtime.isStationSweepArmed()).toBe(true);

    // ── A seeded third of the floor's heartbeat timers die ────────────────
    const silent = new Set<Agent>(w.rng.shuffle(agents).slice(0, Math.max(1, Math.round(FLOOR / 3))));
    const pinging = agents.filter((a) => !silent.has(a));
    for (const a of pinging) a.leg!.startHeartbeat(STATION_INTERVALS.heartbeat_ms);

    // ── Inside the grace: nobody is touched ───────────────────────────────
    await advance(w, STATION_HEARTBEAT_GRACE_MS);
    for (const a of agents) expect(a.leg!.closed, `${a.label} closed inside the grace`).toBeNull();
    expect(w.runtime.stations.size()).toBe(FLOOR);

    // The window the registry's comment describes, on a floor: a silent console's
    // ownership key (30s TTL, renewed only by its ping) has lapsed, while its
    // socket is still attached until the sweep acts. The floor view reads it as
    // disconnected — truthfully — before the socket is closed.
    const floor = await w.runtime.stations.connectedBySession(agents.map((a) => a.sessionId));
    for (const a of agents) expect(floor.get(a.sessionId), a.label).toBe(!silent.has(a));

    // ── Past the grace: the sweep closes exactly the silent ones, with 4408 ─
    await advance(w, STATION_HEARTBEAT_SWEEP_MS + STEP_MS);
    await w.fleet.waitForAll((a) => a.leg!.closed !== null, 'every silent console to be closed', { agents: [...silent] });
    await w.fleet.waitFor(() => w.runtime.stations.size() === pinging.length,
      () => `registry to hold only the pinging consoles (${w.runtime.stations.size()})`);

    for (const a of silent) {
      expect(a.leg!.closed!.code, a.label).toBe(AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT);
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(false);
      expect(w.redis.rawGet(w.ownershipKey(a.sessionId))).toBeUndefined();
      // The close handler's release: an idle agent whose station is gone is
      // written offline, not left to look dialable until the lease lapses.
      await w.fleet.waitFor(() => w.redis.agentState(a.sessionId) === 'offline', `${a.label} offline`);
    }
    for (const a of pinging) {
      const leg = a.leg!;
      expect(leg.closed, `${a.label} was reaped while pinging`).toBeNull();
      expect(leg.pingsSent).toBeGreaterThanOrEqual(4);
      expect(leg.pongs(), `${a.label}: every ping answered`).toBe(leg.pingsSent);
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(true);
      expect(w.redis.rawGet(w.ownershipKey(a.sessionId))).toBeDefined();
      // The heartbeat renews the `break` lease the rehydrate wrote, and only that.
      expect(w.redis.agentState(a.sessionId)).toBe('break');
    }

    // ── The reaped consoles come straight back, and stay ──────────────────
    // 4408 means "re-mint and retry", exactly as 4401 does.
    const back = await w.fleet.connectAll({ agents: [...silent] });
    for (const [i, leg] of back.entries()) {
      const a = [...silent][i]!;
      expect(leg.closed).toBeNull();
      // Whatever the console is told, Redis must agree with it — and it must not
      // be `available`: a reaped agent re-enters the pool by choosing to.
      expect(leg.ready?.['state'], a.label).toBe(w.redis.agentState(a.sessionId));
      expect(leg.ready?.['state']).not.toBe('available');
      leg.startHeartbeat(STATION_INTERVALS.heartbeat_ms);
    }
    await advance(w, STATION_HEARTBEAT_GRACE_MS * 2);
    for (const a of agents) expect(a.leg!.closed, `${a.label} reaped while pinging`).toBeNull();
    expect(w.runtime.stations.size()).toBe(FLOOR);
    expect(w.redis.keys('agency:station:')).toHaveLength(FLOOR);

    // ── The floor empties: no entry, no key, and the sweep timer disarms ──
    // Real timers for the close handshakes; the sweep is advanced explicitly.
    for (const leg of w.fleet.legs()) leg.stopHeartbeat();
    await w.fleet.closeAll();
    await w.fleet.waitFor(() => w.runtime.stations.size() === 0, 'registry to drain');
    expect(w.runtime.isStationSweepArmed(), 'the sweep disarmed while stations were still attached').toBe(true);
    await advance(w, STATION_HEARTBEAT_SWEEP_MS * STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT);
    expect(w.runtime.isStationSweepArmed(), 'the sweep interval outlived the floor').toBe(false);
    expect(await leakReport(w)).toEqual(NO_LEAKS);
  });
});
