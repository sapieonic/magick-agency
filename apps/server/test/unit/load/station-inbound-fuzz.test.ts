import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hostile and confused inbound frames, at floor scale.
//
// The contract (`AgencyStationClientFrame`) says the station reads `ping` and
// nothing else, that every frame is JSON with an `event` discriminant, and that
// non-JSON frames are ignored. So the right answer to every frame below is the
// same: ignore it, keep the socket, keep answering pings, and keep every OTHER
// console on the floor exactly as it was. The wrong answers worth catching are a
// thrown listener (no global `uncaughtException` handler exists in this server, so
// one bad frame from one authenticated console is the whole process and every
// call on it), a socket dropped for a frame that should have been ignored, a
// wedged receiver that stops answering pings, and damage to a bystander.
//
// The frames are drawn from `fuzzFrame` with a seeded PRNG; the seed is printed,
// and `LOAD_SEED=<n>` replays a red run exactly.
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

const { createStationWorld, leakReport, NO_LEAKS } = await import('./station-load-harness.js');
const { fuzzFrame, FUZZ_KINDS } = await import('../../mocks/station-fleet.js');
const { STATION_INTERVALS } = await import('../../../src/api/routes/agency/helpers.js');
const { scaled, createRng, LOAD_SEED, LOAD_SCALE } = await import('../../helpers/load-scale.js');
const { WS_MAX_PAYLOAD_DEFAULT_BYTES } = await import('../../../src/utils/ws-limits.js');

/**
 * The `large_text` payload, in characters, that keeps the whole frame just under the
 * transport bound (`maxPayload`, `src/utils/ws-limits.ts`): the frame is
 * `{"event":"media","media":{"payload":"…"}}`, 40 characters of envelope. Past the bound
 * `ws` closes the socket with 1009 (pinned below); under it the frame reaches the
 * station listener, which must ignore it.
 */
const LARGEST_UNDER_BOUND = WS_MAX_PAYLOAD_DEFAULT_BYTES - 40;

/** Per-test deadlock bound. Generous on purpose: a healthy run takes a few seconds. */
const DEADLOCK_BOUND_MS = 60_000 * Math.max(1, LOAD_SCALE);

type World = Awaited<ReturnType<typeof createStationWorld>>;
type Leg = NonNullable<World['fleet']['agents'][number]['leg']>;

const FUZZERS = scaled(40);
const BYSTANDERS = scaled(40);
const FRAMES_PER_FUZZER = scaled(60);

/** Every error that escaped to the process while a scenario ran. */
const escaped: unknown[] = [];
const onEscape = (err: unknown) => { escaped.push(err); };

let world: World | null = null;

beforeAll(() => {
  console.log(`[station-inbound-fuzz] seed=${LOAD_SEED} fuzzers=${FUZZERS} bystanders=${BYSTANDERS} frames=${FRAMES_PER_FUZZER}`);
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
});
afterAll(() => {
  process.off('uncaughtException', onEscape);
  process.off('unhandledRejection', onEscape);
});
afterEach(async () => {
  await world?.teardown();
  world = null;
  escaped.length = 0;
});

/** A ping whose `ts` is unique to this leg and this send, so its pong is attributable. */
// Far above any `ts` the fuzz kinds use, so a fuzzed ping can never answer for a marked one.
let pingSeq = 1_000_000_000_000;
function markedPing(leg: Leg): number {
  const ts = pingSeq++;
  leg.sendRaw(JSON.stringify({ event: 'ping', ts }));
  return ts;
}
function pongTs(leg: Leg): number[] {
  return leg.ofEvent('pong').map((f) => f['ts'] as number);
}

describe('fuzzed inbound frames on a full floor (load)', () => {
  it('ignores every malformed, unknown, mistyped, binary and oversized frame without harming anyone', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: FUZZERS + BYSTANDERS, tenants: 2,
      heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const fuzzers = w.fleet.agents.slice(0, FUZZERS);
    const bystanders = w.fleet.agents.slice(FUZZERS);
    const sent = new Map<string, number>();

    // Every fuzzer sends its seeded stream, a marked ping every few frames, and
    // one of each kind up front so a small floor still covers the whole set.
    const marked = new Map<string, number[]>();
    for (const a of fuzzers) {
      const leg = a.leg!;
      const mine: number[] = [];
      const frames = [
        ...FUZZ_KINDS.map((kind) => fuzzFrame(w.rng, { kind, largeBytes: LARGEST_UNDER_BOUND })),
        ...Array.from({ length: FRAMES_PER_FUZZER }, () => fuzzFrame(w.rng, { largeBytes: LARGEST_UNDER_BOUND })),
      ];
      for (const [i, f] of frames.entries()) {
        leg.sendRaw(f.data, { binary: f.binary });
        sent.set(f.kind, (sent.get(f.kind) ?? 0) + 1);
        if (i % 7 === 0) mine.push(markedPing(leg));
      }
      mine.push(markedPing(leg));
      marked.set(a.sessionId, mine);
    }
    // Bystanders ping too, and the floor gets a broadcast, while that is in flight.
    const bystanderPings = new Map(bystanders.map((a) => [a.sessionId, [markedPing(a.leg!)]]));
    for (const c of w.campaigns) {
      w.runtime.stations.broadcast(c.id, {
        event: 'campaign_state', campaign_id: c.id, status: 'running', reason: 'resumed', dialing: true, message: 'fuzz',
      });
    }
    console.log(`[station-inbound-fuzz] kinds sent: ${JSON.stringify(Object.fromEntries([...sent].sort()))}`);

    // Every marked ping is answered exactly once — the receiver is not wedged.
    await w.fleet.waitForAll((a) => {
      const want = marked.get(a.sessionId) ?? bystanderPings.get(a.sessionId)!;
      const got = pongTs(a.leg!);
      return want.every((ts) => got.includes(ts));
    }, 'every marked ping to be answered', { timeoutMs: 30_000 });

    expect(escaped, 'a frame escaped the station listener as an uncaught error').toEqual([]);
    for (const a of w.fleet.agents) {
      const leg = a.leg!;
      expect(leg.closed, `${a.label} was closed for an inbound frame`).toBeNull();
      const want = marked.get(a.sessionId) ?? bystanderPings.get(a.sessionId)!;
      for (const ts of want) expect(pongTs(leg).filter((t) => t === ts), `${a.label} ping ${ts}`).toHaveLength(1);
      // Nothing but pongs, its ready and the broadcast came back: a fuzzed frame
      // is never answered with something else, nor routed to anyone else.
      const events = new Set(leg.frames.map((f) => f.frame?.['event']));
      for (const e of events) expect(['ready', 'pong', 'campaign_state'], `${a.label} got ${String(e)}`).toContain(e);
      expect(leg.ofEvent('campaign_state')).toHaveLength(1);
      expect(w.runtime.stations.isLocallyOwned(a.sessionId)).toBe(true);
      expect(w.redis.agentState(a.sessionId)).toBe('break');
    }
    expect(w.runtime.stations.size()).toBe(FUZZERS + BYSTANDERS);

    await w.fleet.closeAll();
    await w.fleet.waitFor(() => w.runtime.stations.size() === 0, 'registry to drain');
    expect(await leakReport(w)).toEqual(NO_LEAKS);
  });

  it('survives the JSON literal `null` — the one frame whose parse yields no object to read `event` from', { timeout: DEADLOCK_BOUND_MS }, async () => {
    // Singled out from the fuzz stream because it was the one kind that took the
    // process down: `JSON.parse('null')` succeeds, and the listener then read
    // `.event` off `null` inside a `ws` 'message' handler. With no global
    // `uncaughtException` handler that is a crash of the whole server — every
    // station and every live call on it — triggered by one text frame from any
    // authenticated console. It also wedged that socket's receiver: the next ping
    // was never answered.
    world = await createStationWorld({
      sessions: sessions as never, agents: 3, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const [sender, ...others] = w.fleet.agents;
    sender!.leg!.sendRaw('null');
    const after = markedPing(sender!.leg!);
    const otherPings = others.map((o) => markedPing(o.leg!));

    await w.fleet.waitFor(() => pongTs(sender!.leg!).includes(after) && others.every((o, i) => pongTs(o.leg!).includes(otherPings[i]!)),
      'the pings after the `null` frame to be answered', 5_000);
    expect(escaped).toEqual([]);
    expect(sender!.leg!.closed).toBeNull();
  });

  it('accepts and ignores the largest frame under the transport bound', { timeout: DEADLOCK_BOUND_MS }, async () => {
    // The bound (`maxPayload`, 64 KiB by default) is checked by `ws` as the frame arrives;
    // a frame exactly at it is still delivered to the station listener, which ignores a
    // media frame on a socket with no live call. The frame is 1.5x a second of PCM16
    // audio, so this is also the margin a legitimate client has.
    world = await createStationWorld({
      sessions: sessions as never, agents: 2, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const [big, other] = w.fleet.agents;
    const frame = fuzzFrame(w.rng, { kind: 'large_text', largeBytes: LARGEST_UNDER_BOUND }).data as string;
    expect(Buffer.byteLength(frame)).toBe(WS_MAX_PAYLOAD_DEFAULT_BYTES);
    big!.leg!.sendRaw(frame);
    const ts = markedPing(big!.leg!);
    const otherTs = markedPing(other!.leg!);
    await w.fleet.waitFor(() => pongTs(big!.leg!).includes(ts) && pongTs(other!.leg!).includes(otherTs), 'pings after the large frame');
    expect(big!.leg!.closed).toBeNull();
    expect(escaped).toEqual([]);
  });

  // Was `it.fails` (load suites 2026-10-23): `@fastify/websocket` was registered with `ws`'s
  // 100 MiB default, so any signed-in console could make the server buffer and
  // `JSON.parse` a frame ~100x the biggest legitimate one on the shared event loop. Fixed
  // by `maxPayload` in `src/app.ts` (`src/utils/ws-limits.ts`): the frame is refused as it
  // arrives, with 1009 (message too big), and nothing escapes to the process.
  it('refuses a frame far larger than any legitimate station frame with 1009', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: 2, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const leg = w.fleet.agents[0]!.leg!;
    const bystander = w.fleet.agents[1]!.leg!;
    leg.sendRaw(fuzzFrame(w.rng, { kind: 'large_text', largeBytes: 4 * 1024 * 1024 }).data);
    const ts = markedPing(leg);
    await w.fleet.waitFor(() => leg.closed !== null || pongTs(leg).includes(ts), 'the large frame to be refused or ignored');
    expect(leg.closed?.code).toBe(1009);
    expect(escaped).toEqual([]);
    // One byte over the bound is refused too, and a bystander is untouched.
    const bystanderTs = markedPing(bystander);
    await w.fleet.waitFor(() => pongTs(bystander).includes(bystanderTs), 'the bystander\'s ping');
    expect(bystander.closed).toBeNull();
  });

  it('refuses a frame one byte over the bound with 1009, and a binary one too', { timeout: DEADLOCK_BOUND_MS }, async () => {
    world = await createStationWorld({
      sessions: sessions as never, agents: 2, heartbeatMs: STATION_INTERVALS.heartbeat_ms, rng: createRng(),
    });
    const w = world;
    await w.fleet.connectAll();
    const [text, binary] = w.fleet.agents.map((a) => a.leg!);
    text!.sendRaw(fuzzFrame(w.rng, { kind: 'large_text', largeBytes: LARGEST_UNDER_BOUND + 1 }).data);
    binary!.sendRaw(Buffer.alloc(WS_MAX_PAYLOAD_DEFAULT_BYTES + 1), { binary: true });
    await w.fleet.waitFor(() => text!.closed !== null && binary!.closed !== null, 'both sockets to be refused');
    expect(text!.closed?.code).toBe(1009);
    expect(binary!.closed?.code).toBe(1009);
    expect(escaped).toEqual([]);
  });
});
