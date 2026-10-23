import { WebSocket, type RawData } from 'ws';
import { performance } from 'node:perf_hooks';
import { createRng, type Rng } from '../helpers/load-scale.js';

/**
 * ─── A SIMULATED AGENT FLEET ON REAL STATION SOCKETS ────────────────────────
 *
 * N agent consoles, each a real `ws` client on a real TCP connection to the real
 * station route (`/proxy/agency/station/:sessionId`), authenticated by a real
 * single-use station token. Nothing about the transport is mocked, because the
 * things that break on a full floor are transport things: close codes, the order
 * frames land in, a reconnect racing the close of the socket it replaces, a peer
 * that stops reading. A mocked socket reproduces none of them.
 *
 * ── What one agent is ──────────────────────────────────────────────────────
 *
 * A {@link FleetAgent} is the console for one agent session. It owns a history of
 * {@link StationLeg}s — one per socket it has opened — because a reconnect is a NEW
 * socket and every assertion about supersede and ghosts is an assertion about
 * which leg is which. `agent.leg` is the newest.
 *
 * A leg records every frame it receives with a monotonic arrival time
 * (`performance.now()`, which fake timers leave alone, so recording stays honest
 * under `vi.useFakeTimers({ toFake: ['Date', …] })`), and its close code.
 *
 * ── Behaviours ─────────────────────────────────────────────────────────────
 *
 * Scripted per agent, so a scenario reads as what the floor does:
 *
 *   - heartbeat at the protocol cadence (`startHeartbeat`), or go silent (`stopHeartbeat`);
 *   - ready / not-ready / disposition, through the {@link FleetActions} adapter the
 *     test supplies (the HTTP routes in an integration world, nothing in a
 *     transport-only one) — the fleet does not know how a world is wired;
 *   - reconnect: re-mint (over whatever `mintToken` is), open a fresh leg;
 *   - network blip: `terminate()` — the TCP connection is destroyed with no close
 *     frame, which is what a dropped wifi looks like to the server;
 *   - slow reader: `pauseReading()` stops reading the socket, so the server's send
 *     buffer fills behind it;
 *   - malformed / oversize / binary frames: `sendRaw`, plus the seeded
 *     {@link fuzzFrame} generator;
 *   - rapid connect-disconnect: `churn`.
 *
 * ── Waiting ────────────────────────────────────────────────────────────────
 *
 * Everything waits by POLLING STATE, never by sleeping for an amount of time the
 * box is assumed to need. Timeouts are deadlock bounds, generous on purpose; a
 * timeout message names what was being waited for and how many agents had got
 * there, so a red run says which part of the floor stalled.
 */

/** One frame as a console received it. */
export interface RecordedFrame {
  /** `performance.now()` at arrival. Monotonic and immune to faked `Date`. */
  at: number;
  /** Arrival order on this leg, from 0. */
  seq: number;
  /** The parsed JSON frame, or `null` for a frame that was not a JSON object. */
  frame: Record<string, unknown> | null;
  binary: boolean;
  bytes: number;
}

export interface LegClose {
  code: number;
  reason: string;
  at: number;
}

/** What the fleet asks the world to do for an agent's HTTP-side actions. */
export interface FleetActions {
  /** `POST /sessions/:id/available`. Resolves to the HTTP status. */
  available?(agent: FleetAgent): Promise<number>;
  /** `POST /sessions/:id/break`. Resolves to the HTTP status. */
  break?(agent: FleetAgent, reason: string): Promise<number>;
  /** `POST /attempts/:id/disposition`. Resolves to the HTTP status. */
  disposition?(agent: FleetAgent, attemptId: string, code: string): Promise<number>;
}

export interface FleetOptions {
  /** `ws://host:port` of the listening app. */
  origin: string;
  /** The upgrade path for a session. Default: the console's station path. */
  path?: (sessionId: string) => string;
  /** Mint a fresh single-use station token for a session. */
  mintToken: (agent: FleetAgent) => Promise<string>;
  /**
   * The ping cadence. Required, so a test passes the PROTOCOL's number
   * (`STATION_INTERVALS.heartbeat_ms`) rather than the fleet inventing one.
   */
  heartbeatMs: number;
  actions?: FleetActions;
  rng?: Rng;
}

export interface AgentSpec {
  sessionId: string;
  tenantId: string;
  accountId?: string;
  campaignId: string;
  agentUserId: string;
  label?: string;
}

/** Poll until `predicate` holds or the deadlock bound passes. */
export async function pollUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string | (() => string),
  timeoutMs = 15_000,
  intervalMs = 5,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (performance.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${typeof what === 'function' ? what() : what}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** One socket an agent's console opened. */
export class StationLeg {
  readonly ws: WebSocket;
  readonly frames: RecordedFrame[] = [];
  readonly openedAt: number;
  opened = false;
  closed: LegClose | null = null;
  /** Pings this leg has sent. Pongs are in `frames`. */
  pingsSent = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly closedPromise: Promise<LegClose>;

  constructor(url: string) {
    this.openedAt = performance.now();
    this.ws = new WebSocket(url);
    // Listeners attached synchronously, BEFORE the handshake completes: the
    // server writes `ready` inside its upgrade handler's own microtask chain, so a
    // listener attached after `open` can miss it.
    this.ws.on('open', () => { this.opened = true; });
    this.ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      let frame: Record<string, unknown> | null = null;
      if (!isBinary) {
        try {
          const parsed: unknown = JSON.parse(buf.toString());
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            frame = parsed as Record<string, unknown>;
          }
        } catch { /* not JSON */ }
      }
      this.frames.push({ at: performance.now(), seq: this.frames.length, frame, binary: isBinary, bytes: buf.length });
    });
    this.closedPromise = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => {
        this.stopHeartbeat();
        this.closed = { code, reason: reason?.toString() ?? '', at: performance.now() };
        resolve(this.closed);
      });
    });
    // A refused or destroyed connection surfaces as `error` on some paths; an
    // unhandled `error` event would take the test process down with it.
    this.ws.on('error', () => {});
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  /** Frames of one event type, in arrival order. */
  ofEvent(event: string): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const f of this.frames) if (f.frame?.['event'] === event) out.push(f.frame);
    return out;
  }

  has(event: string): boolean {
    return this.frames.some((f) => f.frame?.['event'] === event);
  }

  /** The `ready` frame, once it has arrived. */
  get ready(): Record<string, unknown> | undefined {
    return this.ofEvent('ready')[0];
  }

  /** Send anything, exactly as given. A no-op on a leg that is not open. */
  sendRaw(data: string | Buffer, opts: { binary?: boolean } = {}): boolean {
    if (!this.isOpen) return false;
    this.ws.send(data, { binary: opts.binary ?? typeof data !== 'string' });
    return true;
  }

  ping(ts: number = Date.now()): boolean {
    const sent = this.sendRaw(JSON.stringify({ event: 'ping', ts }));
    if (sent) this.pingsSent++;
    return sent;
  }

  pongs(): number {
    return this.ofEvent('pong').length;
  }

  /**
   * Ping at `intervalMs`, as the console does. Uses the ambient `setInterval`, so
   * under fake timers advancing the clock IS the heartbeat firing.
   */
  startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => { this.ping(); }, intervalMs);
  }

  /** Go silent: the console's heartbeat timer dies while the socket stays up. */
  stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  get heartbeating(): boolean {
    return this.heartbeat !== null;
  }

  /** Stop reading. The server's writes queue behind a full TCP window. */
  pauseReading(): void {
    this.ws.pause();
  }

  resumeReading(): void {
    this.ws.resume();
  }

  /** A clean close from the console (tab closed, Leave pressed). */
  close(code = 1000, reason = 'client_close'): void {
    this.stopHeartbeat();
    if (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(code, reason);
    }
  }

  /** A network blip: the TCP connection is destroyed, no close frame is sent. */
  terminate(): void {
    this.stopHeartbeat();
    this.ws.terminate();
  }

  whenClosed(): Promise<LegClose> {
    return this.closedPromise;
  }
}

/** One agent's console. */
export class FleetAgent {
  readonly legs: StationLeg[] = [];
  readonly label: string;

  constructor(readonly spec: AgentSpec, private readonly fleet: StationFleet) {
    this.label = spec.label ?? spec.sessionId.slice(0, 8);
  }

  get sessionId(): string { return this.spec.sessionId; }
  get tenantId(): string { return this.spec.tenantId; }
  get campaignId(): string { return this.spec.campaignId; }
  get agentUserId(): string { return this.spec.agentUserId; }

  /** The newest leg. */
  get leg(): StationLeg | undefined {
    return this.legs[this.legs.length - 1];
  }

  /** Every frame across every leg, in leg order. */
  allFrames(): RecordedFrame[] {
    return this.legs.flatMap((l) => l.frames);
  }

  /** Mint a token and open a leg. Does not wait for `ready`; see {@link connectReady}. */
  async connect(): Promise<StationLeg> {
    const token = await this.fleet.options.mintToken(this);
    return this.openWithToken(token);
  }

  /** Open a leg with a token the caller already holds (or a wrong/absent one). */
  openWithToken(token: string | undefined): StationLeg {
    const path = (this.fleet.options.path ?? defaultPath)(this.sessionId);
    const query = token === undefined ? '' : `?token=${encodeURIComponent(token)}`;
    const leg = new StationLeg(`${this.fleet.options.origin}${path}${query}`);
    this.legs.push(leg);
    return leg;
  }

  /** Connect and wait until this leg's `ready` lands (or it is closed). */
  async connectReady(timeoutMs = 15_000): Promise<StationLeg> {
    const leg = await this.connect();
    await pollUntil(() => leg.ready !== undefined || leg.closed !== null,
      `agent ${this.label}: ready`, timeoutMs);
    return leg;
  }

  /** Re-mint and open a fresh leg; the old one is left as it is. */
  reconnect(): Promise<StationLeg> {
    return this.connect();
  }

  /** Open and drop `times` legs in quick succession, then leave the last one open. */
  async churn(times: number): Promise<StationLeg> {
    for (let i = 0; i < times; i++) {
      const leg = await this.connect();
      if (i % 2 === 0) leg.terminate(); else leg.close();
    }
    return this.connect();
  }

  async goAvailable(): Promise<number> {
    const fn = this.fleet.options.actions?.available;
    if (!fn) throw new Error('fleet has no `available` action wired');
    return fn(this);
  }

  async goBreak(reason: string): Promise<number> {
    const fn = this.fleet.options.actions?.break;
    if (!fn) throw new Error('fleet has no `break` action wired');
    return fn(this, reason);
  }

  async submitDisposition(attemptId: string, code: string): Promise<number> {
    const fn = this.fleet.options.actions?.disposition;
    if (!fn) throw new Error('fleet has no `disposition` action wired');
    return fn(this, attemptId, code);
  }
}

function defaultPath(sessionId: string): string {
  return `/proxy/agency/station/${sessionId}`;
}

export class StationFleet {
  readonly agents: FleetAgent[] = [];
  readonly rng: Rng;

  constructor(readonly options: FleetOptions) {
    this.rng = options.rng ?? createRng();
  }

  add(spec: AgentSpec): FleetAgent {
    const agent = new FleetAgent(spec, this);
    this.agents.push(agent);
    return agent;
  }

  /**
   * Every agent connects at once (the storm), or spread by a seeded jitter.
   * Resolves once every leg has its `ready` or has been closed.
   */
  async connectAll(opts: { jitterMs?: number; agents?: readonly FleetAgent[]; timeoutMs?: number } = {}): Promise<StationLeg[]> {
    const who = opts.agents ?? this.agents;
    const jitter = opts.jitterMs ?? 0;
    const delays = who.map(() => (jitter > 0 ? this.rng.int(0, jitter) : 0));
    const legs = await Promise.all(who.map(async (a, i) => {
      if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]));
      return a.connect();
    }));
    await this.waitFor(
      () => legs.every((l) => l.ready !== undefined || l.closed !== null),
      () => `${legs.filter((l) => l.ready !== undefined || l.closed !== null).length}/${legs.length} legs ready or closed`,
      opts.timeoutMs,
    );
    return legs;
  }

  /** Poll until `predicate` holds for every agent (or the given subset). */
  async waitForAll(
    predicate: (agent: FleetAgent) => boolean,
    what: string,
    opts: { agents?: readonly FleetAgent[]; timeoutMs?: number } = {},
  ): Promise<void> {
    const who = opts.agents ?? this.agents;
    await pollUntil(
      () => who.every(predicate),
      () => `${what} (${who.filter(predicate).length}/${who.length} agents there)`,
      opts.timeoutMs,
    );
  }

  waitFor(predicate: () => boolean | Promise<boolean>, what: string | (() => string), timeoutMs?: number): Promise<void> {
    return pollUntil(predicate, what, timeoutMs);
  }

  /** Every leg any agent has opened. */
  legs(): StationLeg[] {
    return this.agents.flatMap((a) => a.legs);
  }

  /** Legs still open (or still connecting) — after teardown this must be empty. */
  liveLegs(): StationLeg[] {
    return this.legs().filter((l) => l.ws.readyState === WebSocket.OPEN || l.ws.readyState === WebSocket.CONNECTING);
  }

  /** Legs with a heartbeat timer still armed. After teardown this must be empty. */
  heartbeatingLegs(): StationLeg[] {
    return this.legs().filter((l) => l.heartbeating);
  }

  /** Close every leg cleanly and wait for every close to land. */
  async closeAll(timeoutMs = 15_000): Promise<void> {
    for (const leg of this.legs()) {
      leg.stopHeartbeat();
      if (leg.ws.readyState === WebSocket.CONNECTING) leg.terminate();
      else leg.close();
    }
    await pollUntil(() => this.liveLegs().length === 0,
      () => `${this.liveLegs().length} legs still open after closeAll`, timeoutMs);
    // A CLOSING socket whose peer never answers waits out ws's own close timeout;
    // terminate anything that has not finished so teardown is bounded.
    for (const leg of this.legs()) if (leg.closed === null) leg.terminate();
    await pollUntil(() => this.legs().every((l) => l.closed !== null),
      'every leg to report its close', timeoutMs);
  }
}

// ─── Seeded inbound-frame fuzzing ───────────────────────────────────────────

export type FuzzKind =
  | 'malformed_json' | 'json_null' | 'json_scalar' | 'json_array' | 'unknown_event'
  | 'event_wrong_type' | 'ping_wrong_ts' | 'hangup_withdrawn' | 'media_bad_payload'
  | 'binary_garbage' | 'binary_json_ping' | 'large_text' | 'deep_nesting' | 'empty';

export interface FuzzFrame {
  kind: FuzzKind;
  data: string | Buffer;
  binary: boolean;
}

export const FUZZ_KINDS: readonly FuzzKind[] = [
  'malformed_json', 'json_null', 'json_scalar', 'json_array', 'unknown_event',
  'event_wrong_type', 'ping_wrong_ts', 'hangup_withdrawn', 'media_bad_payload',
  'binary_garbage', 'binary_json_ping', 'large_text', 'deep_nesting', 'empty',
];

/**
 * One hostile-or-confused inbound frame, chosen and shaped by `rng` alone, so a
 * red run is reproducible from the printed seed. `largeBytes` bounds the large
 * kinds so a default run stays cheap and `LOAD_SCALE` can grow them.
 */
export function fuzzFrame(rng: Rng, opts: { largeBytes?: number; kind?: FuzzKind } = {}): FuzzFrame {
  const kind = opts.kind ?? rng.pick(FUZZ_KINDS);
  const large = opts.largeBytes ?? 256 * 1024;
  switch (kind) {
    case 'malformed_json':
      return { kind, binary: false, data: rng.pick(['{', '{"event":', '{"event":"ping"', 'ping', '}{', '\u0000\u0001', '{"event":"ping",}']) };
    case 'json_null':
      return { kind, binary: false, data: 'null' };
    case 'json_scalar':
      return { kind, binary: false, data: rng.pick(['0', '1', 'true', 'false', '"ping"', '-1e308', '""']) };
    case 'json_array':
      return { kind, binary: false, data: rng.pick(['[]', '[{"event":"ping"}]', '[null]']) };
    case 'unknown_event':
      return { kind, binary: false, data: JSON.stringify({ event: `x_${rng.int(0, 1e6)}`, payload: rng.next() }) };
    case 'event_wrong_type':
      return { kind, binary: false, data: rng.pick(['{"event":1}', '{"event":null}', '{"event":{}}', '{"event":["ping"]}', '{"event":true}', '{}']) };
    case 'ping_wrong_ts':
      return { kind, binary: false, data: rng.pick(['{"event":"ping","ts":"soon"}', '{"event":"ping","ts":{}}', '{"event":"ping","ts":-1}', '{"event":"ping","ts":1e400}', '{"event":"ping","ts":null}']) };
    case 'hangup_withdrawn':
      return { kind, binary: false, data: JSON.stringify({ event: 'hangup', attempt_id: rng.pick(['not-a-uuid', '00000000-0000-0000-0000-000000000000', '']) }) };
    case 'media_bad_payload':
      return { kind, binary: false, data: rng.pick(['{"event":"media"}', '{"event":"media","media":null}', '{"event":"media","media":{"payload":42}}', '{"event":"media","media":{"payload":"!!!not base64!!!"}}']) };
    case 'binary_garbage': {
      const buf = Buffer.alloc(rng.int(1, 2048));
      for (let i = 0; i < buf.length; i++) buf[i] = rng.int(0, 255);
      return { kind, binary: true, data: buf };
    }
    case 'binary_json_ping':
      return { kind, binary: true, data: Buffer.from(JSON.stringify({ event: 'ping', ts: 1 })) };
    case 'large_text':
      return { kind, binary: false, data: JSON.stringify({ event: 'media', media: { payload: 'A'.repeat(large) } }) };
    case 'deep_nesting': {
      const depth = rng.int(500, 5_000);
      return { kind, binary: false, data: `${'['.repeat(depth)}${']'.repeat(depth)}` };
    }
    case 'empty':
      return { kind, binary: false, data: '' };
  }
}
