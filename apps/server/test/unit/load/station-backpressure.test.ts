import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Back-pressure: consoles that stop reading, on a floor of consoles that do not.
//
// A console that stops draining its socket — a frozen tab, a laptop lid half
// shut, a wedged network path that still ACKs nothing — is a normal event on a
// floor of a hundred agents. The station socket carries control frames AND, for
// the length of a call, the customer's audio (the bridge borrows it), so a stalled
// console mid-call keeps being written to at the media rate.
//
// What the registry does with that, found by this file rather than assumed:
// `StationRegistry.send` is a synchronous `ws.send` that never looks at
// `bufferedAmount`. Nothing in the path applies a limit or a drop policy, so:
//
//   * GOOD — a stalled console cannot stall anyone else: a broadcast is a loop of
//     non-blocking writes, every healthy console receives every frame in order,
//     and the stalled one loses nothing once it resumes;
//   * FINDING — the stalled console's send buffer grows without bound in server
//     memory, for as long as the socket stays open (pings stop, so the heartbeat
//     sweep closes it after `heartbeat_grace_ms` — unless the agent is mid-call,
//     which is exactly when audio is being written to it and exactly when the
//     sweep refuses to close it). Pinned below as an `it.fails`.
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

const { createStationWorld, leakReport, NO_LEAKS, serverSocket } = await import('./station-load-harness.js');
const { STATION_INTERVALS } = await import('../../../src/api/routes/agency/helpers.js');
const { scaled, createRng, LOAD_SEED, LOAD_SCALE } = await import('../../helpers/load-scale.js');

/** Per-test deadlock bound. Generous on purpose: a healthy run takes a few seconds. */
const DEADLOCK_BOUND_MS = 60_000 * Math.max(1, LOAD_SCALE);

type World = Awaited<ReturnType<typeof createStationWorld>>;
type Agent = World['fleet']['agents'][number];

const HEALTHY = scaled(100);
const SLOW = scaled(4);
const BROADCASTS = scaled(50);
/** A 20ms audio frame is ~856 base64 chars; this is a few seconds of audio per frame, to fill buffers quickly. */
const MEDIA_PAYLOAD = 'A'.repeat(64 * 1024);
/**
 * How far past the kernel's socket buffers a stalled console's backlog is driven
 * before the floor is exercised. Far beyond a legitimate backlog (a second of
 * audio is ~43 KB of frames) and well under anything that strains the test box.
 */
const BACKLOG_TARGET_BYTES = 4 * 1024 * 1024;
/**
 * The bound a slow reader's server-side buffer should never exceed. Generous: a
 * few seconds of audio and every control frame a console could be owed.
 */
const REASONABLE_BUFFER_CAP_BYTES = 1024 * 1024;

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-backpressure] seed=${LOAD_SEED} healthy=${HEALTHY} slow=${SLOW} broadcasts=${BROADCASTS}`);
});

afterEach(async () => {
  for (const leg of world?.fleet.legs() ?? []) leg.resumeReading();
  await world?.teardown();
  world = null;
});

function bufferedOnServer(w: World, a: Agent): number {
  return serverSocket(w, a.sessionId)?.bufferedAmount ?? 0;
}

/**
 * Write media to every stalled console until the server holds at least
 * {@link BACKLOG_TARGET_BYTES} for each, yielding to the event loop between
 * batches so the kernel takes what it will. Bounded: a stalled reader that never
 * builds a backlog would mean the pause is not working, and that fails loudly.
 */
async function buildBacklog(w: World, stalled: readonly Agent[]): Promise<number> {
  let frames = 0;
  for (let round = 0; round < 4_000; round++) {
    if (stalled.every((a) => bufferedOnServer(w, a) >= BACKLOG_TARGET_BYTES)) return frames;
    for (const a of stalled) {
      if (bufferedOnServer(w, a) >= BACKLOG_TARGET_BYTES) continue;
      expect(w.runtime.stations.send(a.sessionId, { event: 'media', media: { payload: MEDIA_PAYLOAD } })).toBe(true);
      frames++;
    }
    if (round % 8 === 0) await new Promise((r) => setImmediate(r));
  }
  throw new Error(`stalled consoles never built a ${BACKLOG_TARGET_BYTES}-byte backlog: `
    + stalled.map((a) => bufferedOnServer(w, a)).join(','));
}

describe('back-pressure from consoles that stop reading (load)', () => {
  it('does not stall delivery to the healthy floor, and loses nothing for the stalled consoles', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: HEALTHY + SLOW, campaignsPerTenant: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    // Stalled consoles spread across both campaigns, picked by the seed.
    const stalled = w.rng.shuffle(w.fleet.agents).slice(0, SLOW);
    const healthy = w.fleet.agents.filter((a) => !stalled.includes(a));
    for (const a of stalled) a.leg!.pauseReading();

    const mediaFrames = await buildBacklog(w, stalled);

    // ── The floor keeps moving ────────────────────────────────────────────
    // Every campaign gets BROADCASTS numbered frames, and every console a
    // numbered direct frame between them. Each send is a synchronous write, so a
    // stalled peer could only hold the loop up by blocking — which it must not.
    let delivered = 0;
    for (let n = 0; n < BROADCASTS; n++) {
      for (const c of w.campaigns) {
        delivered += w.runtime.stations.broadcast(c.id, {
          event: 'campaign_state', campaign_id: c.id, status: 'running', reason: 'resumed', dialing: true, message: String(n),
        });
      }
    }
    // The registry cannot tell a stalled console from a healthy one: every write
    // "succeeds", because it was accepted into a buffer.
    expect(delivered).toBe(BROADCASTS * (HEALTHY + SLOW));

    await w.fleet.waitForAll((a) => a.leg!.ofEvent('campaign_state').length === BROADCASTS,
      'every healthy console to receive every broadcast', { agents: healthy, timeoutMs: 30_000 });
    for (const a of healthy) {
      const got = a.leg!.ofEvent('campaign_state').map((f) => Number(f['message']));
      expect(got, `${a.label}: broadcasts out of order or missing`).toEqual(Array.from({ length: BROADCASTS }, (_, i) => i));
      expect(a.leg!.closed).toBeNull();
    }

    // ── The stalled consoles: still open, still attached, and holding the lot ─
    for (const a of stalled) {
      expect(a.leg!.closed, `${a.label} was dropped`).toBeNull();
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(true);
      expect(bufferedOnServer(w, a)).toBeGreaterThanOrEqual(BACKLOG_TARGET_BYTES);
    }
    console.log(`[station-backpressure] media frames written to stalled consoles: ${mediaFrames}; `
      + `server-side backlog (bytes): ${stalled.map((a) => bufferedOnServer(w, a)).join(', ')}`);

    // ── They resume: nothing was dropped, everything arrives in order ─────
    for (const a of stalled) a.leg!.resumeReading();
    await w.fleet.waitForAll((a) => a.leg!.ofEvent('campaign_state').length === BROADCASTS,
      'every stalled console to drain its backlog', { agents: stalled, timeoutMs: 30_000 });
    for (const a of stalled) {
      expect(a.leg!.ofEvent('campaign_state').map((f) => Number(f['message'])))
        .toEqual(Array.from({ length: BROADCASTS }, (_, i) => i));
      // Every media frame was delivered before the broadcasts that followed it.
      const lastMedia = a.leg!.frames.reduce((last, f, i) => (f.frame?.['event'] === 'media' ? i : last), -1);
      const firstBroadcast = a.leg!.frames.findIndex((f) => f.frame?.['event'] === 'campaign_state');
      expect(lastMedia).toBeLessThan(firstBroadcast);
    }
    await w.fleet.waitFor(() => stalled.every((a) => bufferedOnServer(w, a) === 0), 'server buffers to drain');

    await w.fleet.closeAll();
    await w.fleet.waitFor(() => w.runtime.stations.size() === 0, 'registry to drain');
    expect(await leakReport(w)).toEqual(NO_LEAKS);
  });

  // FINDING (not fixed here): `StationRegistry.send` writes without consulting
  // `bufferedAmount`, so a console that never drains is buffered in server memory
  // without limit while its socket stays open — and the heartbeat sweep will not
  // close it while the agent is mid-call, which is when the bridge is writing audio
  // to it. Choosing the policy (cap and drop media, or close the console with a
  // retryable code so it reconnects) is a product decision that touches the
  // contract's close codes, so it is left open. The expected behaviour: the backlog
  // stays under a bound, or the stalled console is closed. Flip to `it` once
  // either exists.
  it.fails('bounds a never-reading console\'s send buffer, or drops the console', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: 1, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const a = w.fleet.agents[0]!;
    a.leg!.pauseReading();
    // Ten times past the cap, written the way the bridge writes audio.
    for (let i = 0; i < 160; i++) {
      w.runtime.stations.send(a.sessionId, { event: 'media', media: { payload: MEDIA_PAYLOAD } });
      if (i % 8 === 0) await new Promise((r) => setImmediate(r));
    }
    await new Promise((r) => setImmediate(r));
    const closedOrBounded = a.leg!.closed !== null
      || serverSocket(w, a.sessionId) === undefined
      || bufferedOnServer(w, a) <= REASONABLE_BUFFER_CAP_BYTES;
    expect(closedOrBounded, `server holds ${bufferedOnServer(w, a)} bytes for one stalled console`).toBe(true);
  });
});
