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
// What the registry does with that (`utils/ws-backpressure.ts`): `StationRegistry.send`
// reads `bufferedAmount` before each write.
//
//   * a stalled console cannot stall anyone else: a broadcast is a loop of
//     non-blocking writes, and every healthy console receives every frame in order;
//   * MEDIA past the soft limit (about 3 s of audio) is dropped: audio that late is
//     worthless, and it is what grew the buffer without bound before (6.5 MB held
//     for one console, never reaped mid-call: the heartbeat sweep does not close a
//     web console mid-call);
//   * CONTROL frames are never dropped: a stalled console that resumes receives
//     every one, in order;
//   * past the hard cap (1 MiB, only reachable with unread control frames) the
//     console is closed 4408 `station_send_backlog`, and it re-mints and reconnects.
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
    // The station attach's session read (it also records `client_kind`).
    readForStationAttach: vi.fn(async (id: string) => sessions.get(id) ?? null),
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
const {
  STATION_PCM16_LIMITS, STATION_SEND_HARD_CAP_BYTES, STATION_SEND_BACKLOG_REASON,
} = await import('../../../src/utils/ws-backpressure.js');
const { AGENCY_STATION_CLOSE } = await import('@magick-agency/contracts/agency');

/** Per-test deadlock bound. Generous on purpose: a healthy run takes a few seconds. */
const DEADLOCK_BOUND_MS = 60_000 * Math.max(1, LOAD_SCALE);

type World = Awaited<ReturnType<typeof createStationWorld>>;
type Agent = World['fleet']['agents'][number];

const HEALTHY = scaled(100);
const SLOW = scaled(4);
const BROADCASTS = scaled(50);
/** A 20ms audio frame is ~856 base64 chars; this is a few seconds of audio per frame, to fill buffers quickly. */
const MEDIA_PAYLOAD = 'A'.repeat(64 * 1024);
/** One JSON media frame of {@link MEDIA_PAYLOAD}, as the registry writes it. */
const MEDIA_FRAME_BYTES = JSON.stringify({ event: 'media', media: { payload: MEDIA_PAYLOAD } }).length;
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
 * Write media to every stalled console until the registry starts DROPPING it (the
 * kernel's buffers are full and the server-side backlog is past the soft limit),
 * yielding to the event loop between batches so the kernel takes what it will.
 * Returns how many media frames each stalled console was actually sent. Bounded:
 * a stalled reader that never reaches the limit would mean the pause is not
 * working, and that fails loudly.
 */
async function buildBacklog(w: World, stalled: readonly Agent[]): Promise<Map<Agent, number>> {
  const sent = new Map<Agent, number>(stalled.map((a) => [a, 0]));
  const dropping = new Set<Agent>();
  for (let round = 0; round < 4_000; round++) {
    if (dropping.size === stalled.length) return sent;
    for (const a of stalled) {
      if (dropping.has(a)) continue;
      if (w.runtime.stations.send(a.sessionId, { event: 'media', media: { payload: MEDIA_PAYLOAD } })) {
        sent.set(a, sent.get(a)! + 1);
      } else {
        dropping.add(a);
      }
    }
    if (round % 8 === 0) await new Promise((r) => setImmediate(r));
  }
  throw new Error(`stalled consoles never reached the media soft limit: `
    + stalled.map((a) => bufferedOnServer(w, a)).join(','));
}

describe('back-pressure from consoles that stop reading (load)', () => {
  it('does not stall the healthy floor; drops a stalled console\'s stale media, never its control frames', { timeout: DEADLOCK_BOUND_MS }, async () => {
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

    const mediaSent = await buildBacklog(w, stalled);

    // Past the soft limit every further media frame is dropped, and the backlog stays
    // within one frame of it.
    for (const a of stalled) {
      for (let i = 0; i < 20; i++) {
        expect(w.runtime.stations.send(a.sessionId, { event: 'media', media: { payload: MEDIA_PAYLOAD } })).toBe(false);
      }
      expect(bufferedOnServer(w, a)).toBeGreaterThan(STATION_PCM16_LIMITS.mediaSoftLimitBytes);
      expect(bufferedOnServer(w, a)).toBeLessThanOrEqual(STATION_PCM16_LIMITS.mediaSoftLimitBytes + MEDIA_FRAME_BYTES);
    }

    // ── The floor keeps moving, and control frames still reach the stalled ones ─
    // Every campaign gets BROADCASTS numbered frames. Each send is a synchronous
    // write, so a stalled peer could only hold the loop up by blocking — which it
    // must not. Control frames are never dropped for back-pressure.
    let delivered = 0;
    for (let n = 0; n < BROADCASTS; n++) {
      for (const c of w.campaigns) {
        delivered += w.runtime.stations.broadcast(c.id, {
          event: 'campaign_state', campaign_id: c.id, status: 'running', reason: 'resumed', dialing: true, message: String(n),
        });
      }
    }
    expect(delivered).toBe(BROADCASTS * (HEALTHY + SLOW));

    await w.fleet.waitForAll((a) => a.leg!.ofEvent('campaign_state').length === BROADCASTS,
      'every healthy console to receive every broadcast', { agents: healthy, timeoutMs: 30_000 });
    for (const a of healthy) {
      const got = a.leg!.ofEvent('campaign_state').map((f) => Number(f['message']));
      expect(got, `${a.label}: broadcasts out of order or missing`).toEqual(Array.from({ length: BROADCASTS }, (_, i) => i));
      expect(a.leg!.closed).toBeNull();
    }

    // ── The stalled consoles: still open, still attached, and bounded ─────
    for (const a of stalled) {
      expect(a.leg!.closed, `${a.label} was dropped`).toBeNull();
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(true);
      expect(bufferedOnServer(w, a)).toBeLessThanOrEqual(REASONABLE_BUFFER_CAP_BYTES);
    }
    console.log(`[station-backpressure] media frames sent to stalled consoles before the soft limit: `
      + `${[...mediaSent.values()].join(', ')}; server-side backlog (bytes): ${stalled.map((a) => bufferedOnServer(w, a)).join(', ')}`);

    // ── They resume: every control frame arrives in order; only media was dropped ─
    for (const a of stalled) a.leg!.resumeReading();
    await w.fleet.waitForAll((a) => a.leg!.ofEvent('campaign_state').length === BROADCASTS,
      'every stalled console to drain its backlog', { agents: stalled, timeoutMs: 30_000 });
    for (const a of stalled) {
      expect(a.leg!.ofEvent('campaign_state').map((f) => Number(f['message'])))
        .toEqual(Array.from({ length: BROADCASTS }, (_, i) => i));
      // Exactly the media frames the registry accepted, all before the broadcasts.
      expect(a.leg!.ofEvent('media')).toHaveLength(mediaSent.get(a)!);
      const lastMedia = a.leg!.frames.reduce((last, f, i) => (f.frame?.['event'] === 'media' ? i : last), -1);
      const firstBroadcast = a.leg!.frames.findIndex((f) => f.frame?.['event'] === 'campaign_state');
      expect(lastMedia).toBeLessThan(firstBroadcast);
      expect(a.leg!.closed).toBeNull();
    }
    await w.fleet.waitFor(() => stalled.every((a) => bufferedOnServer(w, a) === 0), 'server buffers to drain');

    await w.fleet.closeAll();
    await w.fleet.waitFor(() => w.runtime.stations.size() === 0, 'registry to drain');
    expect(await leakReport(w)).toEqual(NO_LEAKS);
  });

  // Was `it.fails` (load suites 2026-10-23): `StationRegistry.send` wrote without consulting
  // `bufferedAmount`, so a console that never drained was buffered in server memory without
  // limit (6.5 MB here), and the heartbeat sweep will not close a web console mid-call,
  // which is when the bridge writes audio to it. Fixed by the back-pressure policy in
  // `utils/ws-backpressure.ts`: media past the soft limit is dropped.
  it('bounds a never-reading console\'s send buffer, or drops the console', { timeout: DEADLOCK_BOUND_MS }, async () => {
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

  it('closes a console whose unread control frames pass the hard cap with 4408 station_send_backlog', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: 2, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const [a, bystander] = w.fleet.agents as [Agent, Agent];
    a.leg!.pauseReading();
    const server = serverSocket(w, a.sessionId)!;
    // Control frames are never dropped, so they are what can reach the cap: write them,
    // ~4 KiB each, until the registry refuses one.
    const filler = 'x'.repeat(4096);
    let refusedAt = -1;
    for (let i = 0; i < 4_000 && refusedAt < 0; i++) {
      if (!w.runtime.stations.send(a.sessionId, {
        event: 'campaign_state', campaign_id: 'c', status: 'running', reason: 'resumed', dialing: true, message: filler,
      })) refusedAt = i;
      if (i % 16 === 0) await new Promise((r) => setImmediate(r));
    }
    expect(refusedAt, 'the registry never refused a frame').toBeGreaterThan(0);
    // Refused because the backlog passed the cap, not before.
    expect(server.bufferedAmount).toBeGreaterThan(STATION_SEND_HARD_CAP_BYTES);
    // The socket is closing: every later send is refused, the bystander is untouched.
    expect(server.readyState).not.toBe(1);
    expect(w.runtime.stations.send(a.sessionId, { event: 'pong', ts: 1, server_ts: 1 })).toBe(false);
    expect(w.runtime.stations.send(bystander.sessionId, { event: 'pong', ts: 1, server_ts: 1 })).toBe(true);
    // The console resumes, reads through its backlog and sees the code that tells it to
    // re-mint and reconnect.
    a.leg!.resumeReading();
    await w.fleet.waitFor(() => a.leg!.closed !== null, 'the stalled console to see its close', 10_000);
    expect(a.leg!.closed).toMatchObject({ code: AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT, reason: STATION_SEND_BACKLOG_REASON });
    await w.fleet.waitFor(() => !w.runtime.stations.isLocallyOwned(a.sessionId), 'the registry to detach it');
    expect(bystander.leg!.closed).toBeNull();
  });
});
