import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

// ---------------------------------------------------------------------------
// The offline stomp — two sockets on one session, and which of them may decide
// the agent is gone (ClickUp `86d44papk`).
//
// ── The shape the suite was missing ────────────────────────────────────────
//
// Every existing station test drives ONE socket. `StationRegistry` already had a
// unit test proving a superseded socket's `detach` does not evict its
// replacement — and that test passed the whole time the bug was in production,
// because the damage is not done by `detach`. It is done by the line after it:
// `releaseStationOnClose`, which guarded only on `hasLiveAttempt` and wrote the
// agent `offline` in Redis while the replacement socket was attached and had
// already reported `available` on its own `ready` frame. Nothing corrected it —
// the station heartbeat renews an existing `available`/`break` lease, it never
// restores one — so the agent sat out of the dialable pool for the rest of their
// shift on a console that looked healthy.
//
// So the assertion has to be about POOL MEMBERSHIP after a second socket
// attaches, not about attach churn: every ordinary attach-churn criterion can
// pass while this ships unfixed.
//
// ── Why this file drives the REAL route and the REAL runtime ───────────────
//
// `handleStationSocket` is not exported (it is transport, and rightly so), and
// the guard lives inside its close handler. A test that called a lifted-out
// helper would prove the helper. So the socket is opened through `injectWS`, and
// the registry, the agent state machine, the dialer and `releaseStationOnClose`
// are all the production objects — the only double is Redis, which interprets
// the three Lua scripts by shape so `agents.get()` is a real read of a real
// write.
//
// FALSIFICATION: reverting the guard in `agency.routes.ts`'s close handler reds
// `leaves the agent in their pre-close state when a second socket has attached`
// and `the surviving socket keeps a working heartbeat`, and leaves every other
// agency test green. Not "the first two": the 4409-on-the-wire case sits between
// them and is guarded by a different change (`attach`'s close code), so it is
// green either way.
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

// No auth middleware mock: only the station socket is mounted here
// (`registerStationSocket`), and it is registered OUTSIDE the authenticated scope.

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
    attempt: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null), reapNonTerminal: vi.fn() },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
    session: {
      findById: vi.fn(),
      setState: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn(),
    },
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
// The bridge does no settlement dispatch, so there is no dispatcher to double.
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

// The station handler (`GET /station/:sessionId` + `handleStationSocket`) lives in the
// runtime-owned `agency/station-socket.ts`; the other agency routes are not exercised here.
import { registerStationSocket } from '../../../src/agency/station-socket.js';
import { AgencyRuntime } from '../../../src/agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';

// ─── The one double: Redis, interpreted by shape ───────────────────────────

/**
 * The three agent-state Lua scripts are matched on rather than executed, which is
 * exactly enough for `set`/`transition`/`renew`/`get` to behave, and keeps the
 * fake honest about the thing under test: `agents.get()` here reads back what the
 * route's close handler actually wrote.
 */
class ShapeRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();

  async eval(script: string, _numKeys: number, key: string, ...argv: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) {                                  // RENEW
      if (!h) return 0;
      return h.state === argv[0] ? 1 : 0;
    }
    if (script.includes('HGET')) {                                    // CAS
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '', since: argv[4] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '', since: argv[3] ?? '' }); // SET
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

interface Leg {
  ws: WebSocket;
  frames: any[];
  /** `[code, reason]` once this leg has closed. */
  closed: Promise<[number, string]>;
}

interface Harness {
  app: FastifyInstance;
  runtime: AgencyRuntime;
  open(): Promise<Leg>;
  /**
   * Open a leg WITHOUT waiting for `ready`. Required by any test whose subject is
   * a setup run that is abandoned, because such a run never sends one and
   * `open()` would wait for it until the timeout.
   */
  openRaw(): Leg;
}

/**
 * A stand-in replacement socket, for staging a supersede at an exact instant.
 *
 * Attaching one of these is how a test reaches a window that a second real leg
 * cannot: a real connection does its own setup on its own microtask chain, so
 * "the replacement is attached at the moment the old socket's ping resolves" is
 * not something the test can time. `attach` only needs a `ws` it can compare by
 * identity and close, and `send` only needs `readyState`/`send`.
 */
function replacementSocket(): { ws: WebSocket; sent: any[] } {
  const sent: any[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => { try { sent.push(JSON.parse(raw)); } catch { sent.push(raw); } },
    close: () => {},
    on: () => {},
    removeListener: () => {},
  } as unknown as WebSocket;
  return { ws, sent };
}

const REPLACEMENT_ENTRY = {
  sessionId: 'sess-1', campaignId: 'camp-1', tenantId: 't1',
  accountId: 'a1', agentUserId: 'u-agent',
};

/**
 * A real listening server and real `ws` clients, deliberately **not**
 * `app.injectWS`.
 *
 * `injectWS` resolves after the socket is open, and the `ready` frame is written
 * inside the upgrade handler's own microtask chain — so by the time a caller can
 * attach a `message` listener the frame has already been emitted to nobody and is
 * gone. That is precisely the class of bug fix E is about, and a harness that
 * cannot observe an early frame is the wrong instrument for a file whose subject
 * is two overlapping sockets. Binding a port lets each leg's listeners be
 * attached before its handshake completes, so every frame and every close code is
 * attributable to the leg that received it.
 */
async function harness(): Promise<Harness> {
  const runtime = new AgencyRuntime({} as never, new ShapeRedis() as never, '');
  // A real token store would need one mint per connect and this file is about
  // what happens AFTER two sockets exist, not about the token.
  vi.spyOn(runtime.tokens, 'verifyAndConsume').mockResolvedValue(true);

  const app = Fastify();
  await app.register(websocket);
  await app.register(async (a) => registerStationSocket(a as never, runtime), { prefix: '/api/v1/agency' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;

  // A local binding, not a method: inside an object literal returned from an
  // `async` function, `this` widens to `Harness | PromiseLike<Harness>`, so
  // `this.openRaw()` does not type-check and every value derived from it decays to
  // `any`. Naming the function keeps both callers on the real `Leg` type.
  const openRaw = (): Leg => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/agency/station/sess-1?token=tok`);
    const frames: any[] = [];
    ws.on('message', (raw) => {
      try { frames.push(JSON.parse(raw.toString())); } catch { /* media/binary */ }
    });
    const closed = new Promise<[number, string]>((resolve) => {
      ws.on('close', (code, reason) => resolve([code, reason?.toString() ?? '']));
    });
    return { ws, frames, closed };
  };

  return {
    app,
    runtime,
    openRaw,
    async open(): Promise<Leg> {
      const leg = openRaw();
      await vi.waitFor(() => expect(leg.frames.some((f) => f.event === 'ready')).toBe(true));
      return leg;
    },
  };
}

/** Drain the close handler's own await chain (detach → guard → release). */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

let h: Harness;

beforeEach(async () => {
  vi.clearAllMocks();
  repos.session.findById.mockResolvedValue(SESSION);
  h = await harness();
});

afterEach(async () => {
  // The sweep is a real interval now that a test arms it deliberately.
  h.runtime.stopStationSweep();
  await h.app.close();
});

describe('a superseded station socket must not release the socket that replaced it', () => {
  it('leaves the agent in their pre-close state when a second socket has attached', async () => {
    // The agent is in the pool, which is the state the whole bug destroys. Seeded
    // rather than transitioned into: `rehydrateAgent` reads Redis and returns the
    // live lease untouched, so this is what a mid-shift reconnect really looks
    // like — and it is why the second socket's `ready` reports `available`.
    await h.runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    const first = await h.open();
    const second = await h.open();

    // Not staged by the test: `attach` supersedes the prior socket, so opening the
    // second one is what closes the first. That IS the production sequence.
    await first.closed;
    await settle();

    const live = await h.runtime.agents.get('sess-1');
    expect(live?.state, 'the superseded socket wrote the live agent offline').toBe('available');
    // And the replacement is still the one holding the session.
    expect(h.runtime.stations.isLocallyOwned('sess-1')).toBe(true);
    expect(second.frames.find((f) => f.event === 'ready')?.state).toBe('available');
  });

  it('arms the silent-station sweep', async () => {
    // `runtime.wakeStationSweep()` is called from exactly one place — this route,
    // right after `attach` — and nothing asserted it. Every other test that drives
    // the route mocks the whole runtime (`wakeStationSweep: vi.fn()`) and never
    // checks the call, and the sweep's own suite calls it by hand. So deleting that
    // line left the sweep permanently dormant in production while the entire suite
    // stayed green: an orphaned station would never be closed and, since the
    // route's own close handler is what detaches, a station whose console stopped
    // pinging would hold the agent's ownership key for the rest of the shift.
    //
    // This file is the one that can assert it, because its runtime is real.
    //
    // FALSIFICATION: delete the `runtime.wakeStationSweep()` call in
    // `agency.routes.ts` and this reds, alone.
    expect(h.runtime.isStationSweepArmed()).toBe(false);

    await h.open();

    expect(h.runtime.isStationSweepArmed()).toBe(true);
  });

  it('tells the superseded leg WHY it was closed — 4409, on the wire', async () => {
    // The registry unit test pins the argument; this pins that it survives the
    // real close handshake and reaches the peer, because that is the only thing
    // the console can read. Without a code the peer reports 1005/1006 and a
    // supersede is indistinguishable from a wifi drop.
    const first = await h.open();
    await h.open();

    expect(await first.closed).toEqual([4409, 'superseded']);
  });

  it('the surviving socket keeps a working heartbeat', async () => {
    // The other half of "still in the pool": the lease has to be renewable. A
    // stomped agent's key is `offline`, so the heartbeat's state-matched renewal
    // silently stops applying to `available` and the console has no way to tell.
    await h.runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    const first = await h.open();
    const second = await h.open();
    await first.closed;
    await settle();

    second.ws.send(JSON.stringify({ event: 'ping', ts: 1 }));
    await vi.waitFor(() => expect(second.frames.some((f) => f.event === 'pong')).toBe(true));
    expect((await h.runtime.agents.get('sess-1'))?.state).toBe('available');
  });

  it('attributes a heartbeat to the socket that sent it', async () => {
    // The registry refuses a heartbeat from a socket that no longer holds the
    // session (`station-registry.test.ts`), but that guard is only reachable if the
    // route passes the socket — and nothing asserted the wiring, which is the same
    // way `wakeStationSweep` went unasserted above.
    //
    // FALSIFICATION: drop the second argument at the `heartbeat` call in
    // `agency.routes.ts` and this reds.
    await h.runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    const leg = await h.open();
    // The registry's own view of this leg is the server-side socket the route holds.
    const serverSocket = h.runtime.stations.socketFor('sess-1');
    expect(serverSocket).toBeDefined();

    const heartbeat = vi.spyOn(h.runtime.stations, 'heartbeat');
    leg.ws.send(JSON.stringify({ event: 'ping', ts: 3 }));
    await vi.waitFor(() => expect(leg.frames.some((f) => f.event === 'pong')).toBe(true));

    expect(heartbeat).toHaveBeenCalledWith('sess-1', serverSocket);
  });

  it('a SOLE socket closing still takes the agent offline', async () => {
    // The falsification guard, and the reason the check compares sockets instead
    // of skipping the release whenever one is attached: presence is the heartbeat,
    // so an agent whose only console went away must leave the pool immediately.
    await h.runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });

    const only = await h.open();
    only.ws.close();
    await only.closed;
    await settle();

    expect((await h.runtime.agents.get('sess-1'))?.state).toBe('offline');
    expect(h.runtime.stations.isLocallyOwned('sess-1')).toBe(false);
  });

  it('does not release a session whose drop is mid-attempt', async () => {
    // The pre-existing guard, re-asserted through the route because the new branch
    // sits in front of it: a drop mid-call belongs to the deferred hangup, and
    // writing `offline` there clears the `on_call` lease's attempt binding.
    await h.runtime.agents.set('sess-1', 'on_call', { attemptId: 'att-1', leaseMs: AGENT_LEASE_MS.on_call });
    vi.spyOn(h.runtime.dialer, 'hasLiveAttempt').mockReturnValue(true);

    const only = await h.open();
    only.ws.close();
    await only.closed;
    await settle();

    const live = await h.runtime.agents.get('sess-1');
    expect(live?.state).toBe('on_call');
    expect(live?.attemptId).toBe('att-1');
  });
});

/**
 * The same disease as the stomp above, in the three other places on this route
 * where a decision is separated from its effect by an `await`.
 *
 * Worth stating as one idea rather than three tests: `runtime.stations.send` and
 * every `runtime.stations.*` lookup resolve **by session id**, so any handler
 * that establishes "I am the socket for this session" and then awaits anything
 * has established nothing by the time it acts. The route now says whose socket it
 * means — `send(..., socket)`, `stillOurs()` — and these pin the two windows that
 * are reachable through it.
 */
describe('a decision made before an await must be re-asked after it', () => {
  it('does not deliver a superseded socket\'s pong to its replacement', async () => {
    // The window: `handlePing` scopes `heartbeat` to this socket, and THEN awaits
    // a row read and up to two Redis calls before answering. A supersede inside
    // that window used to send this pong — echoing a `ts` the replacement never
    // sent, with a `server_ts` to match — to the replacement, which reads any
    // pong as proof its own round trip landed: it clears the miss counter, resets
    // the backoff ladder and takes a clock-offset sample. One stray frame telling
    // a brand-new socket it is healthy is the opposite of what the ladder is for.
    const a = await h.open();
    const replacement = replacementSocket();

    // Stage the supersede INSIDE the ping's own await, which is the only way to
    // land in the window: the ping's liveness re-read is the first thing it does.
    let staged = false;
    repos.session.findById.mockImplementation(async () => {
      if (!staged) {
        staged = true;
        await h.runtime.stations.attach({ ...REPLACEMENT_ENTRY, ws: replacement.ws });
      }
      return SESSION;
    });

    a.ws.send(JSON.stringify({ event: 'ping', ts: 12_345 }));
    await settle(12);

    expect(staged).toBe(true);
    expect(replacement.sent.filter((f) => f.event === 'pong')).toEqual([]);
    // And nothing was fabricated for the leg that did ask, either — it is the
    // socket that just got closed with 4409.
    expect(a.frames.filter((f) => f.event === 'pong')).toEqual([]);
  });

  it('abandons a setup run that is superseded before its side effects', async () => {
    // The window: `attach` → `await rehydrateAgent` → `reattachStation` /
    // `takeMissedRelease` / `send(ready)`. A stale run reaching those did three
    // separate kinds of damage — re-bound a live attempt's MEDIA leg to the socket
    // that is closing, consumed a one-shot missed release the replacement then
    // never saw, and delivered its own stale snapshot as the replacement's
    // `ready`. `stillOurs()` makes such a run do nothing at all rather than half
    // of it.
    const replacement = replacementSocket();
    const reattach = vi.spyOn(h.runtime.dialer, 'reattachStation');
    const takeMissed = vi.spyOn(h.runtime.dialer, 'takeMissedRelease');
    vi.spyOn(h.runtime, 'rehydrateAgent').mockImplementation(async () => {
      await h.runtime.stations.attach({ ...REPLACEMENT_ENTRY, ws: replacement.ws });
      return 'available';
    });

    // Not `open()`: an abandoned run never sends `ready`, so waiting for one is
    // waiting for the timeout.
    const leg = h.openRaw();
    await settle(14);

    expect(replacement.sent.filter((f) => f.event === 'ready')).toEqual([]);
    expect(leg.frames.filter((f) => f.event === 'ready')).toEqual([]);
    expect(reattach).not.toHaveBeenCalled();
    expect(takeMissed).not.toHaveBeenCalled();
    leg.ws.close();
  });

  it('refuses to write a session offline while another socket holds it', async () => {
    // ── THIS ONE PINS A GUARD THAT IS UNREACHABLE THROUGH THE ROUTE, AND SAYS SO
    //
    // A review reported the close handler's `socketFor` check as racing
    // `releaseStationOnClose`'s awaits. It does not: that read, the `superseded`
    // test, the call, `hasLiveAttempt` and `agents.set`'s `redis.eval` are one
    // synchronous run, so nothing can interleave between the decision and the
    // write being issued. The gate inside the method is therefore belt-and-braces
    // against a future `await` being added above it — see the comment there — and
    // a direct call is the only way to exercise it. It is asserted rather than
    // left implicit precisely BECAUSE it cannot fire today: a guard with no test
    // and no reachable path is one an editor deletes as dead.
    await h.runtime.agents.set('sess-1', 'available', { leaseMs: AGENT_LEASE_MS.available });
    const a = await h.open();
    const stale = h.runtime.stations.socketFor('sess-1');
    expect(stale).toBeDefined();

    const replacement = replacementSocket();
    await h.runtime.stations.attach({ ...REPLACEMENT_ENTRY, ws: replacement.ws });

    expect(await h.runtime.releaseStationOnClose('sess-1', stale)).toBe(false);
    expect((await h.runtime.agents.get('sess-1'))?.state).toBe('available');

    // Same call with no identity keeps the old behaviour, which is what makes the
    // parameter safe to add to a method the sweep and the reaper also reach.
    expect(await h.runtime.releaseStationOnClose('sess-1')).toBe(true);
    expect((await h.runtime.agents.get('sess-1'))?.state).toBe('offline');
    a.ws.close();
  });
});
