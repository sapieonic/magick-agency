// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/station-heartbeat-grace.test.ts@4850d1d9 (19 → 19).
// The handler under test moved: core's `agencyRoutes` (`src/api/routes/agency.routes.ts`) →
// `registerStationSocket` in `src/agency/station-socket.ts` (verbatim body, Phase 6). Mounted at the
// same prefix. The `auth.middleware` mock (only the authenticated HTTP routes used it; Phase 8) and
// the `settlement-dispatcher` mock (module deleted) are removed. Import paths otherwise only. No case
// deleted or modified.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// Two halves of the same contract: the heartbeat is received, and the heartbeat
// is enforced (ClickUp `86d44papk`, fix E).
//
// ── Received ───────────────────────────────────────────────────────────────
//
// `socket.on('message')` was registered AFTER the station setup's awaits, and
// `ws` buffers nothing for a socket with no listener — so a frame that arrived
// while core was reading the session row, attaching and rehydrating was emitted
// to nobody and gone. Nothing in the suite could see that, because nothing sent
// a frame that early. Here the session read is held open deliberately, which is
// the only way to put a frame inside that window on purpose.
//
// Two things that follow from a frame being received early are asserted alongside
// it: that a `close` in the same window is not lost either — it used to leave a
// registry entry nothing could ever remove, which is the blocker in `86d44papk` —
// and that a deferred pong's `server_ts` is the instant the ping ARRIVED rather
// than the instant the held answer finally went out.
//
// ── Enforced ───────────────────────────────────────────────────────────────
//
// `heartbeat_grace_ms: 30_000` has been advertised in the bootstrap contract
// since the contract landed and was enforced by nothing: `lastSeen` was written
// at attach and on every ping and read nowhere. So a socket whose CLIENT-side
// heartbeat timer had been orphaned stayed attached forever — `isLocallyOwned`
// answering true, so `POST /sessions/:id/available` kept succeeding on it — while
// the Redis ownership key that same heartbeat renews had expired thirty seconds
// in. An orphaned socket had no recovery path at all, because nothing closed it
// and so nothing made the console notice.
//
// The two rules that keep the cure from being worse than the disease are asserted
// as their own cases: never a socket that is mid-attempt (this socket IS the media
// leg, and media does not renew `lastSeen`), and never one that is already
// CLOSING. A socket already CLOSED is the third case and the only one the sweep
// resolves by detaching — folding it in with CLOSING is what made a lost `close`
// event unrecoverable.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    masterService: { url: 'https://master.test', s2sToken: 'tok' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

// PORT NOTE: core mocked `src/api/middleware/auth.middleware.js` because it mounted the
// whole `agencyRoutes` plugin, whose HTTP routes sit behind it. Only the station socket
// is mounted here (`registerStationSocket`), and it is registered OUTSIDE the
// authenticated scope in core too — so there is no auth middleware to double.

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

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
    session: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(undefined), leave: vi.fn() },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
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
// PORT NOTE: core mocked `src/webhooks/settlement-dispatcher.js`; the bridge's
// settlement dispatch is deleted (plan §5, lane C), so there is nothing to double.
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

// PORT NOTE: core's station handler lived in `src/api/routes/agency.routes.ts`
// (`agencyRoutes`, `GET /station/:sessionId` + `handleStationSocket`). Its body is
// ported verbatim into the runtime-owned `agency/station-socket.ts`; the other agency
// routes are Phase 8 and none of them is exercised here.
import { registerStationSocket } from '../../../src/agency/station-socket.js';
import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import {
  STATION_HEARTBEAT_GRACE_MS,
  STATION_HEARTBEAT_SWEEP_MS,
  STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT,
} from '@magick-agency/domain/timers';

/** Shape-interpreted Redis — enough for the agent state machine to be real. */
class ShapeRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();
  async eval(script: string, _n: number, key: string, ...argv: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) return h && h.state === argv[0] ? 1 : 0;
    if (script.includes('HGET')) {
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '', since: argv[4] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '', since: argv[3] ?? '' });
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> { return this.hashes.get(key) ?? {}; }
  async set(key: string, value: string): Promise<'OK'> { this.strings.set(key, value); return 'OK'; }
  async get(key: string): Promise<string | null> { return this.strings.get(key) ?? null; }
  async del(key: string): Promise<number> {
    this.hashes.delete(key);
    return this.strings.delete(key) ? 1 : 0;
  }
  async mget(...keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.strings.get(k) ?? null);
  }
}

const SESSION = {
  id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1',
  tenant_id: 't1', account_id: 'a1', state: 'available', left_at: null,
};

const ENTRY = { campaignId: 'camp-1', tenantId: 't1', accountId: 'a1', agentUserId: 'u-agent' };

// ═══════════════════════════════════════════════════════════════════════════
// Received — a frame that lands while core is still setting the station up
// ═══════════════════════════════════════════════════════════════════════════

describe('a frame sent immediately on open is answered, not dropped', () => {
  let app: FastifyInstance;
  let runtime: AgencyRuntime;
  /** Releases the held session read, so the setup awaits can finish. */
  let releaseSessionRead: () => void;

  beforeEach(async () => {
    vi.clearAllMocks();
    // The FIRST session read is held open, which is what puts a client frame inside
    // the setup window deterministically. In production that window is however long
    // one primary-key read plus an `attach` takes — small, and the console's first
    // ping is timed to land in it.
    //
    // Only the first: the ping handler does its own `findById` (the left-session
    // recheck), and holding that one too would hang the very pong under test.
    let held = false;
    repos.session.findById.mockImplementation(() => {
      if (held) return Promise.resolve(SESSION);
      held = true;
      return new Promise((resolve) => { releaseSessionRead = () => resolve(SESSION); });
    });

    runtime = new AgencyRuntime({} as never, new ShapeRedis() as never, '');
    vi.spyOn(runtime.tokens, 'verifyAndConsume').mockResolvedValue(true);
    await runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    app = Fastify();
    await app.register(websocket);
    // PORT NOTE: `agencyRoutes(a, runtime)` → `registerStationSocket(a, runtime)`, same prefix.
    await app.register(async (a) => registerStationSocket(a as never, runtime), { prefix: '/api/v1/agency' });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    runtime.stopStationSweep();
    await app.close();
  });

  it('pongs a ping that arrived before the station was attached', async () => {
    // FALSIFIED by dropping a pre-attach ping instead of holding it (which is what
    // registering `socket.on('message')` below the setup awaits amounts to): no
    // pong ever arrives and this times out.
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    const frames: any[] = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await new Promise((r) => ws.on('open', r));

    // The SERVER's own view of the socket, borrowed purely to observe. Waiting on a
    // client-side timeout would prove nothing: a ping that had not yet crossed the
    // loopback would be handled on the ordinary live path and produce a pong either
    // way, so the broken build would pass. This is the only signal that says the
    // frame really did arrive inside the window. The extra listener is additive —
    // `ws` delivers to both, and the route's was registered first.
    const serverSocket = [...app.websocketServer.clients][0]!;
    const receivedByServer: string[] = [];
    serverSocket.on('message', (raw: Buffer | string) => receivedByServer.push(raw.toString()));

    ws.send(JSON.stringify({ event: 'ping', ts: 7 }));
    await vi.waitFor(() => expect(receivedByServer).toHaveLength(1));

    // Received, and deliberately not yet answered: the station is not attached, so
    // `heartbeat` would refuse and the pre-fix code dropped the frame right here.
    expect(frames).toEqual([]);

    releaseSessionRead();

    await vi.waitFor(() => expect(frames.some((f) => f.event === 'pong')).toBe(true));
    // `ready` first, then the held ping's answer — and the client's own clock is
    // echoed back, so the round trip it was measuring is still measurable.
    expect(frames.map((f) => f.event)).toEqual(['ready', 'pong']);
    expect(frames.find((f) => f.event === 'pong')?.ts).toBe(7);
    ws.terminate();
  });

  it('stamps a deferred pong’s server_ts at ARRIVAL, not at replay', async () => {
    // The console derives its clock offset as `server_ts - (ts + rtt/2)`, with `rtt`
    // measured entirely client-side — so `server_ts` has to be our clock at the
    // moment we saw the ping. It was `Date.now()` at send time, and on this path
    // that is the whole station setup later: the console sends a ping the instant the
    // socket opens and the answer is held until `attach`, `claimOwnership`,
    // `rehydrateAgent` and `ready` are done. The offset came back over-estimated by
    // about half that, and because the console's estimator is a median over five
    // samples this is its only sample for the first ~50s — the window in which a
    // wrap-up deadline is rendered as a countdown against a one second tolerance.
    //
    // FALSIFICATION: put `server_ts: Date.now()` back in `handlePing` and this reds
    // by roughly the delay below.
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    const frames: any[] = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await new Promise((r) => ws.on('open', r));

    // The server's own view, purely to observe. This listener is additive and was
    // registered second, so it fires in the same emit as the route's — which means
    // the instant recorded here is at or after the route's own `receivedAt`, and the
    // assertion below is exact rather than approximate.
    const serverSocket = [...app.websocketServer.clients][0]!;
    let arrivedNoLaterThan = 0;
    serverSocket.on('message', () => { arrivedNoLaterThan = Date.now(); });

    ws.send(JSON.stringify({ event: 'ping', ts: 7 }));
    await vi.waitFor(() => expect(arrivedNoLaterThan).toBeGreaterThan(0));

    // A real delay, and the only reason for one: the two candidate stamps are
    // milliseconds apart otherwise, and a broken build would pass on rounding.
    const HELD_FOR_MS = 150;
    await new Promise((r) => setTimeout(r, HELD_FOR_MS));
    releaseSessionRead();
    await vi.waitFor(() => expect(frames.some((f) => f.event === 'pong')).toBe(true));

    const pong = frames.find((f) => f.event === 'pong')!;
    expect(pong.ts).toBe(7);
    // Stamped when the frame landed — so no later than when the test saw it land.
    expect(pong.server_ts).toBeLessThanOrEqual(arrivedNoLaterThan);
    // Said the other way round, because the first assertion alone would also hold
    // for a stamp taken absurdly early: the answer really was sent much later.
    expect(Date.now() - pong.server_ts).toBeGreaterThanOrEqual(HELD_FOR_MS);
    ws.terminate();
  });

  it('stamps a LIVE pong’s server_ts at arrival too', async () => {
    // Same rule on the ordinary path, where the gap is the left-session recheck plus
    // a Redis read rather than the whole setup. Smaller, and wrong in the same
    // direction — and it is the path every ping after the first one takes.
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    const frames: any[] = [];
    ws.on('message', (raw) => { try { frames.push(JSON.parse(raw.toString())); } catch { /* media */ } });
    await new Promise((r) => ws.on('open', r));
    releaseSessionRead();
    await vi.waitFor(() => expect(frames.some((f) => f.event === 'ready')).toBe(true));

    // Now make the recheck slow, which is what a loaded database looks like from
    // here, and is the only lever that makes the two stamps distinguishable.
    const SLOW_MS = 150;
    repos.session.findById.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(SESSION), SLOW_MS)),
    );

    const serverSocket = [...app.websocketServer.clients][0]!;
    let arrivedNoLaterThan = 0;
    serverSocket.on('message', () => { arrivedNoLaterThan = Date.now(); });

    ws.send(JSON.stringify({ event: 'ping', ts: 11 }));
    await vi.waitFor(() => expect(frames.some((f) => f.event === 'pong')).toBe(true), { timeout: 3000 });

    const pong = frames.find((f) => f.event === 'pong')!;
    expect(pong.ts).toBe(11);
    expect(pong.server_ts).toBeLessThanOrEqual(arrivedNoLaterThan);
    expect(Date.now() - pong.server_ts).toBeGreaterThanOrEqual(SLOW_MS);
    ws.terminate();
  });

  it('does not leak a registry entry when the socket closes inside the setup window', async () => {
    // ── THE BLOCKER ───────────────────────────────────────────────────────────
    //
    // `socket.on('close')` used to be registered BELOW every setup await, and `ws`
    // buffers nothing for an event with no listener — so a close landing in this
    // window was emitted to nobody. `detach` is the only caller of the registry's
    // `delete`, so the entry became PERMANENT: `isLocallyOwned` answered true
    // forever, `POST /sessions/:id/available` kept succeeding, the pacing engine
    // kept the session as a dial candidate, `releaseStationOnClose` never ran, and
    // `stations.size()` never returned to zero so the sweep could not even go
    // dormant. The sweep could not recover it either — its guard was
    // `readyState !== 1`, and a CLOSED socket is 3.
    //
    // FALSIFICATION: move the close handler back below the setup awaits (or drop
    // the `closeSeen`/`readyState` guard at `attach`) and this reds — the entry is
    // still there and the agent is still `available` with no station.
    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    await new Promise((r) => ws.on('open', r));

    // Killed while the session read is held, i.e. inside the setup window on
    // purpose. `terminate` rather than `close`, so there is no closing handshake to
    // wait on and the server sees the close at once.
    ws.terminate();
    await vi.waitFor(() => expect([...app.websocketServer.clients]).toHaveLength(0));

    releaseSessionRead();
    // Drain the setup's remaining awaits and the close handler's own chain.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    // The whole point: nothing is attached, so nothing lies about this agent.
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(false);
    expect(runtime.stations.size()).toBe(0);
    // And presence was resolved rather than left advertising a station that is gone.
    expect((await runtime.agents.get('sess-1'))?.state).toBe('offline');
  });

  it('does not leak when the socket closes BEFORE any listener exists', async () => {
    /**
     * The other half of the setup window: a close landing during
     * `verifyAndConsume`, i.e. before the route has registered any listener at
     * all. The test above holds the SESSION READ, which is after that point, so
     * `closeSeen` is set there and this path is genuinely different — no listener
     * exists to set the flag, so `closeSeen` stays false for the whole handler.
     *
     * **This test does NOT falsify either half of `attach`'s refusal, and the
     * comment here used to claim it did.** Narrowing the pre-check to
     * `if (closeSeen)` alone leaves it green, so on this path the no-leak
     * property is over-determined — something downstream of `attach` (the `ready`
     * send failing on a dead socket, and the sweep's CLOSED-detach arm) already
     * resolves it. The guard may still be worth keeping as the cheap, explicit
     * answer rather than relying on a throw, but nothing here proves it is
     * load-bearing, and it should not be presented as if it were.
     *
     * What this DOES pin is the invariant that matters to the dial path: a socket
     * that never survived its own setup leaves nothing claiming to be a station.
     */
    let releaseTokenCheck!: () => void;
    vi.spyOn(runtime.tokens, 'verifyAndConsume').mockImplementation(
      () => new Promise((resolve) => { releaseTokenCheck = () => resolve(true); }),
    );

    const { port } = app.server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    await new Promise((r) => ws.on('open', r));
    await vi.waitFor(() => expect(releaseTokenCheck).toBeTypeOf('function'));

    // Gone before the route has registered anything at all.
    ws.terminate();
    await vi.waitFor(() => expect([...app.websocketServer.clients]).toHaveLength(0));

    releaseTokenCheck();
    releaseSessionRead();
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(false);
    expect(runtime.stations.size()).toBe(0);
  });

  // NOT ASSERTED HERE: that a flood of pre-attach pings yields exactly one pong.
  // The held slot keeps only the newest frame, but which of several client sends
  // land inside the window is decided by TCP, not by this test — so an assertion
  // on the count would pass or fail on scheduling rather than on the behaviour.
  // The bound exists to stop an unbounded pre-attach queue buying a database read
  // per frame; it is argued at the source and is not separately observable from
  // out here.
});

// ═══════════════════════════════════════════════════════════════════════════
// Enforced — the silent-station sweep
// ═══════════════════════════════════════════════════════════════════════════

/** A station socket that records what the sweep asked to be sent on the wire. */
function fakeWs(readyState = 1) {
  return {
    readyState,
    OPEN: 1,
    closeArgs: [] as [number | undefined, string | undefined][],
    send() { /* frames are not the subject here */ },
    close(code?: number, reason?: string) { this.closeArgs.push([code, reason]); this.readyState = 2; },
  };
}

describe('the advertised heartbeat grace is enforced', () => {
  let runtime: AgencyRuntime;

  beforeEach(async () => {
    vi.clearAllMocks();
    // A controlled clock, because `lastSeen` is written from `Date.now()` inside
    // the registry: "silent for 31 seconds" has to be expressible as the clock
    // moving, not just as a later `now` handed to the sweep, or a test cannot tell
    // a re-armed grace from a stale one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T09:00:00.000Z'));
    runtime = new AgencyRuntime({} as never, new ShapeRedis() as never, '');
  });

  afterEach(() => {
    runtime.stopStationSweep();
    vi.useRealTimers();
  });

  /** Move the clock forward. `lastSeen` stays put; only `now` advances. */
  const past = (ms: number) => Date.now() + ms;

  it('closes a socket that has gone silent past the grace, with 4408', async () => {
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1))).toBe(1);
    // 4408 rather than a bare close: the console must be able to tell "your
    // heartbeat lapsed, come back" from a transport failure, and an orphaned
    // socket's whole recovery path is that reconnect.
    expect(ws.closeArgs).toEqual([[4408, 'station_heartbeat_timeout']]);
  });

  it('leaves a socket that pinged inside the grace alone', async () => {
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS - 1))).toBe(0);
    expect(ws.closeArgs).toEqual([]);
  });

  it('a heartbeat re-arms the grace', async () => {
    // The whole mechanism, end to end: `lastSeen` is what the sweep reads and the
    // heartbeat is the only thing that writes it. Before this sweep existed,
    // nothing read it at all.
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });

    // At this instant the station is over its grace and would be closed.
    vi.setSystemTime(past(STATION_HEARTBEAT_GRACE_MS + 1));
    expect(runtime.stations.silentSince(STATION_HEARTBEAT_GRACE_MS)).toHaveLength(1);

    // One ping, and the same instant is no longer silent.
    expect(await runtime.stations.heartbeat('sess-1')).toBe(true);

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS)).toBe(0);
    expect(ws.closeArgs).toEqual([]);

    // And it lapses again on its own if the pings stop.
    vi.setSystemTime(past(STATION_HEARTBEAT_GRACE_MS + 1));
    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS)).toBe(1);
  });

  it('NEVER closes a socket that is mid-attempt', async () => {
    // This socket is also the media leg (§7), and media frames do not renew
    // `lastSeen` — only `ping` does. So a console whose heartbeat timer was
    // orphaned while its audio kept flowing is exactly the shape that lands here,
    // and closing it would put a live customer on silence and arm the deferred
    // hangup on the strength of a timer the CLIENT stopped.
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });
    vi.spyOn(runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS * 10))).toBe(0);
    expect(ws.closeArgs).toEqual([]);
    // And it is still attached, so the deferred hangup keeps owning the outcome.
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(true);
  });

  it('does not re-close a socket that is already closing', async () => {
    // `close()` starts a handshake and the entry stays in the registry until the
    // `close` event fires, so without this the same socket would be closed and
    // logged on every tick — and the sweep could never report an idle pass, so it
    // could never go dormant.
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });
    const silent = past(STATION_HEARTBEAT_GRACE_MS + 1);

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, silent)).toBe(1);
    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, silent)).toBe(0);
    expect(ws.closeArgs).toHaveLength(1);
  });

  it('DETACHES an entry whose socket is already CLOSED', async () => {
    // The other half of the blocker. The guard here was `readyState !== 1`, which
    // folded CLOSED (3) in with CLOSING (2) — and CLOSING is the case the rule is
    // actually about, because `close()` starts a handshake and the entry stays until
    // `close` fires. Extending it to CLOSED is what made a lost `close` event
    // unrecoverable: the sweep skipped the entry forever, so `isLocallyOwned` kept
    // answering true and `stations.size()` never returned to zero.
    //
    // Re-closing it would be useless — a CLOSED socket cannot produce the `close`
    // event the entry is waiting for — so the sweep detaches instead.
    //
    // FALSIFICATION: restore `if (entry.ws.readyState !== 1) continue;` as the only
    // readyState guard and this reds on every assertion below.
    const ws = fakeWs(3 /* CLOSED */);
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });
    await runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1))).toBe(1);

    // `detach` deletes the map entry before its first await, so the lie stops on
    // this tick rather than one microtask later.
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(false);
    expect(runtime.stations.size()).toBe(0);
    // Not closed again: there is nothing there to close.
    expect(ws.closeArgs).toEqual([]);
    // And presence is deliberately NOT released from here. Detach already dropped
    // the ownership key the dial path consults, and an `available` lease is renewed
    // only by the station heartbeat, so with no station it lapses on its own.
    expect((await runtime.agents.get('sess-1'))?.state).toBe('available');
  });

  it('leaves a CLOSING socket attached, and does not detach it either', async () => {
    // The distinction the CLOSED arm turns on, asserted from the other side: a
    // handshake is in progress, `close` is still coming, and the socket’s own
    // handler owns detach and the release. Detaching here would race it and would
    // pull the registry out from under the supersede guard that reads it.
    const ws = fakeWs(2 /* CLOSING */);
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1))).toBe(0);
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(true);
    expect(ws.closeArgs).toEqual([]);
  });

  it('never detaches a CLOSED socket that is mid-attempt', async () => {
    // Rule 1 guards the detach arm as well as the close arm. The ownership key
    // `detach` drops is the reaper’s exclusion for an attempt still in its
    // deferred-hangup window, so dropping it here would let the reaper hang up on a
    // customer the agent is about to get back. The leak is bounded instead: when the
    // attempt settles, `hasLiveAttempt` goes false and the next tick detaches it.
    const ws = fakeWs(3 /* CLOSED */);
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });
    const live = vi.spyOn(runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);

    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1))).toBe(0);
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(true);

    live.mockReturnValue(false);
    expect(runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1))).toBe(1);
    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(false);
  });

  it('leaves detach and the agent release to the socket’s own close handler', async () => {
    // Duplicating either from the sweep would race the close handler, and the
    // supersede guard there depends on the registry still reporting who is
    // attached. `ws` fires `close` off its own closing timeout even when the peer
    // never answers, so a wedged socket still gets there.
    //
    // The one exception is a socket already CLOSED, where that handler provably ran
    // and will not run again — the sweep detaches those, and only those. See
    // `DETACHES an entry whose socket is already CLOSED` above.
    const ws = fakeWs();
    await runtime.stations.attach({ sessionId: 'sess-1', ws: ws as never, ...ENTRY });
    await runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    runtime.sweepSilentStations(STATION_HEARTBEAT_GRACE_MS, past(STATION_HEARTBEAT_GRACE_MS + 1));

    expect(runtime.stations.isLocallyOwned('sess-1')).toBe(true);
    expect((await runtime.agents.get('sess-1'))?.state).toBe('available');
  });
});

describe('the sweep is demand-driven and self-dormant', () => {
  let runtime: AgencyRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    runtime = new AgencyRuntime({} as never, new ShapeRedis() as never, '');
  });

  afterEach(() => {
    runtime.stopStationSweep();
    vi.useRealTimers();
  });

  it('is dormant until a station attaches', () => {
    expect(runtime.isStationSweepArmed()).toBe(false);
    runtime.wakeStationSweep();
    expect(runtime.isStationSweepArmed()).toBe(true);
  });

  it('stays armed while any station is attached, however healthy', async () => {
    // The dormancy condition is deliberately "closed nothing AND holds nothing",
    // not merely an idle pass: a healthy station can fall silent at any moment,
    // and its attach has already happened, so nothing would re-arm the timer.
    await runtime.stations.attach({ sessionId: 'sess-1', ws: fakeWs() as never, ...ENTRY });
    runtime.wakeStationSweep();

    await vi.advanceTimersByTimeAsync(
      STATION_HEARTBEAT_SWEEP_MS * (STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT + 3),
    );

    expect(runtime.isStationSweepArmed()).toBe(true);
  });

  it('disarms itself once the registry is empty', async () => {
    runtime.wakeStationSweep();

    await vi.advanceTimersByTimeAsync(
      STATION_HEARTBEAT_SWEEP_MS * STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT,
    );

    // No station, nothing closed — so the replica stops ticking entirely.
    expect(runtime.isStationSweepArmed()).toBe(false);
  });

  it('can go dormant again after a CLOSED entry is swept', async () => {
    // The half of the harm that made the leak self-sustaining: dormancy requires
    // `stations.size() === 0`, and nothing could ever remove a CLOSED entry, so the
    // replica ticked this timer for the rest of its life.
    vi.setSystemTime(new Date('2026-08-25T09:00:00.000Z'));
    await runtime.stations.attach({ sessionId: 'sess-1', ws: fakeWs(3) as never, ...ENTRY });
    vi.setSystemTime(Date.now() + STATION_HEARTBEAT_GRACE_MS + 1);
    runtime.wakeStationSweep();

    // One pass detaches (which counts as work, so the timer stays armed), then the
    // idle passes run out.
    await vi.advanceTimersByTimeAsync(
      STATION_HEARTBEAT_SWEEP_MS * (STATION_SWEEP_IDLE_PASSES_BEFORE_DORMANT + 1),
    );

    expect(runtime.stations.size()).toBe(0);
    expect(runtime.isStationSweepArmed()).toBe(false);
  });

  it('is stopped by the runtime’s own shutdown', async () => {
    runtime.wakeStationSweep();
    expect(runtime.isStationSweepArmed()).toBe(true);
    runtime.stopStationSweep();
    expect(runtime.isStationSweepArmed()).toBe(false);
  });
});
