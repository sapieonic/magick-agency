import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Live call listening's load check (docs/listening.md §10 "Load check"): what supervisors
 * listening costs the calls they listen to, measured on one build three ways:
 *
 *  (a) the floor alone: N bridged calls (100, `scaled`), 50 frames a second each way, nobody
 *      listening (the baseline);
 *  (b) the expected peak: 6 listeners (5–6 supervisors, LS5), one of them stalled;
 *  (c) the process cap: 20 listeners (`AGENCY_LISTEN_MAX_PER_PROCESS`), one stalled, and a 21st
 *      grant refused `listen_limit_server`.
 *
 * The calls are the media load suite's (`voicelink-media-ws-load.test.ts`): each placed through the
 * real bridge and `VoicelinkAdapter` to the mock VoiceLink carrier, which opens its media socket,
 * sends `start` and streams paced A-law. The agent's leg is a REAL WebSocket on loopback (half
 * `alaw8`, the mobile app's byte passthrough; half `pcm16`, the console's transcoded leg), served by
 * a socket server of this file's own and lent to the bridge as the station's socket is
 * (`createBridgedCall({ browserSocket })`): the relay writes to real sockets in both directions. The
 * station ROUTE is not on the media path (the bridge borrows its socket), so it is left out: its
 * heartbeat and lease machinery would only add the agency runtime's pacing to the measurement.
 *
 * The listeners take the REAL path end to end: `POST /proxy/agency/live-calls/:callId/listen`
 * through the session (Firebase stood in for), the tenant context, RBAC and the flag, the live
 * list's SQL over the call's spine (an attempt `bridged` on the call, written by this file: the
 * calls are dialled straight into the bridge, not by pacing), `callCore` to the grant handler, the
 * token in Redis, then a real WebSocket upgrade on `/proxy/agency/listen/:sessionId/:listenId`
 * (token spent, caps reserved, the session row written, the tap opened). Each listener pings every
 * 10 s as the console does; the stalled one pauses its socket once `ready` arrives and never reads
 * or writes again, so the server's send buffer fills behind it (dropped at the soft limit, LS8) until
 * the 30 s idle bound ends it `listener_disconnected` (LS15 g). Its server end is corked as it
 * stalls ({@link corkServerEnd} says why: loopback's kernel buffers would hide the stall for minutes).
 *
 * Asserted in every run: the call path drops nothing (every frame each side sent reached the other,
 * in order, by its loudness pattern; the bridge's drop counters zero). Each floor is measured over a
 * 15 s window with nobody listening; runs (b) and (c) then attach their listeners and measure a
 * second 15 s window on the same calls, which must stay within the bounds below of the first: the
 * event loop's utilisation and delay p99 (`createLoopSampler`) and each direction's end-to-end frame
 * latency (carrier send → agent receive, agent send → carrier receive) are primary, because the
 * tap runs after the relay's write and so can only cost the NEXT frame; the relay's dwell
 * (`webrtc_relay_dwell_seconds`, sampled) is secondary, since it excludes the tap by construction.
 * Every listener but the stalled one receives both legs, tagged, at 50 messages a second each; the
 * stalled one is dropped (its frames counted in its row and in
 * `websocket_send_backpressure_total{socket="listener"}`) and then ended without touching its call,
 * whose other listener carries on; the session metrics move. Then the leak check. Run (a) is the
 * floor that nobody ever listens to: its numbers are the reference the docs record.
 *
 * Wall-clock: the stream is paced in real time and the stalled listener's end is the real 30 s
 * idle bound (no override), so the file is in the wall-clock lane (`vitest.config.integration.ts`).
 * The listeners' sockets live in a child process (`listen-load-clients.ts`): in production they are
 * browsers elsewhere, and their reading on this loop would be charged to the server. The carrier
 * mock and the agents' sockets stay in this process: they are the same in both windows.
 */

const { reader } = await vi.hoisted(async () => {
  Object.assign(process.env, {
    VOICELINK_WEBHOOK_BASE_URL: 'https://agency.test/api/v1/webhooks/voicelink',
    VOICELINK_USERNAME: 'mock-vl-user',
    VOICELINK_PASSWORD: 'mock-vl-password',
    MAX_CONCURRENT_CALLS: '100000',
    RATE_LIMIT_WEBHOOK_MAX: '1000000',
    RATE_LIMIT_CARRIER_MEDIA_MAX: '1000000',
    RATE_LIMIT_STATION_MAX: '1000000',
    RATE_LIMIT_MAX: '1000000',
    RATE_LIMIT_USER_MAX: '1000000',
    LOG_LEVEL: 'error',
  });
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});
const fb = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: fb.verifyIdToken }));

import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { getPool } from '@magick-agency/db';
import { AGENCY_LISTEN_IDLE_TIMEOUT_MS, AGENCY_LISTEN_PING_INTERVAL_MS } from '@magick-agency/contracts/agency';
import { getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests, startAgency } from '../../../src/bootstrap/agency.js';
import { startVoice } from '../../../src/bootstrap/voice.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { setBrowserLegMediaFormat } from '../../../src/core/bridge/browser-leg-media.js';
import { createLoopSampler, type LoopSample } from '../../../src/cluster/loop-sampler.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { metricValue } from '../../helpers/otel-metric-reader.js';
import { createRng, LOAD_SEED, scaled } from '../../helpers/load-scale.js';
import {
  alawFrame, bits, carrierScripts, isLoudAlaw, isLoudPcm16, pcm16kFrame, type CarrierCall, type LeadRequest,
} from '../../mocks/voicelink/index.js';
import { insertAgencyContact } from '../agency/agency-factories.js';
import {
  LOAD_ACCOUNT as ACCOUNT, LOAD_CAMPAIGN as CAMPAIGN, LOAD_TENANT as TENANT, assertNoLeaks, closeLoadDb, dialBridged,
  initLoadDb, startLoadRig, stopLoadRig, waitAllTerminal, waitFor, type LoadRig,
} from './voicelink-load-harness.js';

const CALLS = scaled(100);
/** The listener counts of runs (b) and (c): the expected peak (LS5) and the per-process cap. */
const PEAK_LISTENERS = 6;
const CAP_LISTENERS = 20;
const FRAME_MS = 20;
/** Each measured window: the floor quiet, then (runs b, c) the same floor with its listeners. */
const WINDOW_MS = 15_000;
/** Between the last call going live (or the last listener's `ready`) and a window. */
const SETTLE_MS = 2_000;
/** Room for the listeners' grants and upgrades between the two windows. */
const ATTACH_ALLOWANCE_MS = 4_000;
/**
 * How long each call streams. The baseline needs its window and the lead-in; a run with listeners
 * the quiet window, the listeners' window and the stalled listener's idle bound (30 s from its
 * `ready`, which comes just before the second window), with room to spare.
 */
const BASELINE_STREAM_MS = SETTLE_MS + WINDOW_MS + 5_000;
const LISTEN_STREAM_MS = SETTLE_MS + WINDOW_MS + ATTACH_ALLOWANCE_MS + AGENCY_LISTEN_IDLE_TIMEOUT_MS + 10_000;

/**
 * The bounds: the listeners' window against the quiet window of the SAME floor, just before it.
 * Measured across runs minutes apart, a busy neighbour on the machine (another lane's files, a
 * build) moved these numbers more than 20 listeners do (docs/listening.md §10 "Load check" has the
 * runs they were chosen from); measured on one floor 20 s apart, the difference is the listeners.
 * A bound is `quiet × ratio` with a floor of `quiet + slack`, the slack for readings near their
 * instrument's resolution (the loop's delay histogram resolves 1 ms; the dwell's buckets are 50,
 * 100, 250, 500 µs, 1 ms, …).
 *
 * Primary, where the tap's cost shows (it runs after the relay's write, so it can only delay the
 * NEXT frame, on the loop): the loop's utilisation and delay p99, and each direction's end-to-end
 * frame latency at the median and p95 (the tail past p95 is garbage-collection pauses, which move
 * by tens of ms from one window to the next with or without listeners: reported, not bounded).
 */
const ELU_SLACK = 0.2;
const LOOP_P99_RATIO = 2;
const LOOP_P99_SLACK_MS = 10;
const LATENCY_P50_RATIO = 1.5;
const LATENCY_P50_SLACK_MS = 1;
const LATENCY_P95_RATIO = 3;
const LATENCY_P95_SLACK_MS = 20;
/**
 * Secondary: the relay's own dwell (`webrtc_relay_dwell_seconds`, sampled), which by construction
 * excludes the tap (LS8): it holds that the relay itself is not slowed, not that the tap is cheap.
 */
const DWELL_MEAN_RATIO = 2;
const DWELL_MEAN_SLACK_MICROS = 50;
/** The dwell's p99 bucket may sit at most this many buckets above the quiet window's. */
const DWELL_P99_BUCKET_STEPS = 2;
/** Each leg reaches a reading listener at 50 messages a second; over the window, within this. */
const LEG_RATE_TOLERANCE = 0.1;

const rng = createRng(LOAD_SEED);
const pool = () => getTestPool();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Every loud frame is the same bytes (the tone's period divides the frame), and every quiet one:
// computed once, so the clients spend nothing building audio.
const ALAW = { loud: alawFrame(0, true), quiet: alawFrame(0, false) };
const PCM_B64 = { loud: pcm16kFrame(0, true).toString('base64'), quiet: pcm16kFrame(0, false).toString('base64') };

// ─── The agent's side: a real socket the bridge borrows ─────────────────────

let stationServer: WebSocketServer;
const pendingServerEnds = new Map<string, (ws: WebSocket) => void>();

/**
 * The agent's console on one call: a real `ws` client on loopback. Its server end is lent to the
 * bridge. Once the bridge says the call is live (`in_progress`) it talks `pattern` on a monotonic
 * 20 ms schedule (as the carrier mock does), and records the loudness of every frame it hears.
 */
class AgentStation {
  readonly id = randomUUID();
  readonly client: WebSocket;
  server!: WebSocket;
  /** The listener counts on the server end before the bridge borrowed it. */
  serverListeners = 0;
  readonly heard: boolean[] = [];
  /** `performance.now()` as each frame arrived here, and as each frame was sent: the frame's latency. */
  readonly heardAt: number[] = [];
  readonly sentAt: number[] = [];
  sent = 0;
  live = false;
  ended = false;
  odd = 0;

  constructor(readonly format: 'alaw8' | 'pcm16', readonly pattern: boolean[], port: number) {
    this.client = new WebSocket(`ws://127.0.0.1:${port}/station/${this.id}`);
    this.client.on('error', () => { /* the close follows */ });
    this.client.on('message', (raw: Buffer, isBinary) => {
      if (isBinary) {
        if (raw.length === 160) { this.heardAt.push(performance.now()); this.heard.push(isLoudAlaw(raw)); } else this.odd++;
        return;
      }
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame['event'] === 'media') {
        this.heardAt.push(performance.now());
        this.heard.push(isLoudPcm16(Buffer.from((frame['media'] as { payload: string }).payload, 'base64')));
      } else if (frame['event'] === 'status' && frame['status'] === 'in_progress' && !this.live) {
        this.live = true;
        void this.talk();
      } else if (frame['event'] === 'ended') {
        this.ended = true;
      }
    });
  }

  async connect(): Promise<void> {
    const server = new Promise<WebSocket>((resolve) => pendingServerEnds.set(this.id, resolve));
    await new Promise<void>((resolve, reject) => { this.client.once('open', resolve); this.client.once('error', reject); });
    this.server = await server;
    // As the station route tags its socket from `media=` and sets TCP_NODELAY.
    if (this.format === 'alaw8') setBrowserLegMediaFormat(this.server as never, 'alaw8');
    (this.server as unknown as { _socket?: { setNoDelay(v: boolean): void } })._socket?.setNoDelay(true);
    this.serverListeners = this.borrowedListeners();
  }

  /** Listeners on the server end: the bridge's come and go with the call. */
  borrowedListeners(): number {
    return this.server.listenerCount('message') + this.server.listenerCount('close') + this.server.listenerCount('error');
  }

  private async talk(): Promise<void> {
    const t0 = performance.now();
    for (let k = 0; k < this.pattern.length; k++) {
      if (this.ended || this.client.readyState !== WebSocket.OPEN) return;
      const loud = this.pattern[k]!;
      this.sentAt.push(performance.now());
      if (this.format === 'alaw8') this.client.send(loud ? ALAW.loud : ALAW.quiet, { binary: true });
      else this.client.send(JSON.stringify({ event: 'media', media: { payload: loud ? PCM_B64.loud : PCM_B64.quiet } }));
      this.sent++;
      const wait = t0 + (k + 1) * FRAME_MS - performance.now();
      if (wait > 0) await sleep(wait);
    }
  }

  close(): void {
    if (this.client.readyState === WebSocket.OPEN) this.client.close();
  }
}

// ─── The world ──────────────────────────────────────────────────────────────

interface User { id: string; uid: string }

async function user(role: string): Promise<User> {
  const id = randomUUID();
  const uid = `fb-${role}-${id.slice(0, 8)}`;
  await pool().query('INSERT INTO users (id, firebase_uid, email, display_name) VALUES ($1, $2, $3, $4)',
    [id, uid, `${uid}@example.test`, `${role} ${id.slice(0, 4)}`]);
  await pool().query('INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, $4)', [id, TENANT, ACCOUNT, role]);
  return { id, uid };
}

function http(who: User, method: 'GET' | 'POST', url: string) {
  return rig!.app.inject({
    method, url, headers: { authorization: `Bearer tok:${who.uid}`, 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT },
  });
}

interface Plan {
  index: number;
  number: string;
  station: AgentStation;
  callId?: string;
  attemptId?: string;
  /** `performance.now()` as the carrier sent each media frame, and as each of the agent's reached it. */
  carrierSentAt: number[];
  carrierHeardAt: number[];
}

/**
 * Time the carrier's media socket (a script step, once the stream has started): every media frame
 * it sends and every one it receives, for the end-to-end latency. Frames are never dropped or
 * reordered here (asserted), so frame k sent is frame k received.
 */
function timeCarrier(c: CarrierCall, p: Plan): true {
  const ws = c.ws!;
  const send = ws.send.bind(ws) as (...args: unknown[]) => void;
  (ws as unknown as { send: (...args: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
    if (typeof data === 'string' && data.startsWith('{"event":"media"')) p.carrierSentAt.push(performance.now());
    send(data, ...rest);
  };
  // The bridge's media frames to VoiceLink carry 216 base64 characters; its other frames are short.
  ws.on('message', (data: Buffer, isBinary: boolean) => { if (!isBinary && data.length >= 200) p.carrierHeardAt.push(performance.now()); });
  return true;
}

function numberFor(i: number): string {
  return `98${String(71_000_000 + i).padStart(8, '0')}`;
}

/**
 * The call's spine, as pacing would have left it on a bridged dialler call: the agent, their
 * session, the contact and the attempt `bridged` on this call (`webrtc_call_id`), so the live list
 * and the grant find it. The calls here are dialled straight into the bridge.
 */
async function makeListenable(p: Plan): Promise<void> {
  const agent = await user('agent');
  const sessionId = randomUUID();
  await pool().query(
    `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state)
     VALUES ($1, $2, $3, $4, $5, 'on_call')`, [sessionId, TENANT, ACCOUNT, CAMPAIGN, agent.id]);
  const contact = await insertAgencyContact(CAMPAIGN, {
    tenant_id: TENANT, account_id: ACCOUNT, phone_e164: `+91${p.number}`, source_row_number: p.index + 1,
    context: JSON.stringify({ name: `Customer ${p.index}` }),
  });
  await pool().query(
    `INSERT INTO agency_call_attempts (id, campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id,
       reserved_agent_id, webrtc_call_id, state, dialed_at, answered_at, bridged_at)
     VALUES ($1, $2, $3, $4, $5, 1, '+919800000001', $6, $7, 'bridged', now(), now(), now())`,
    [p.attemptId, CAMPAIGN, contact.id, TENANT, ACCOUNT, sessionId, p.callId]);
}

// ─── The listeners: in a child process ──────────────────────────────────────

interface ListenerCounts { customer: number; agent: number; odd: number; windowCustomer: number; windowAgent: number; events: string[] }

/**
 * The supervisors' browsers, in a child process (`listen-load-clients.ts`): their reading is not
 * on this process's loop, which is the server's, so the windows measure what listening costs the
 * server. A stalled listener's server end is corked here when it reports `ready`.
 */
class ListenerClients {
  private readonly child: ChildProcess;
  private readonly reports = new Map<number, (listeners: Record<string, ListenerCounts>) => void>();
  private seq = 0;
  readonly ready = new Set<string>();
  readonly closed = new Map<string, { code: number; reason: string }>();
  private up!: Promise<void>;

  constructor() {
    this.child = fork(fileURLToPath(new URL('./listen-load-clients.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    this.up = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.on('message', (m: { op: string; [k: string]: unknown }) => {
        if (m.op === 'up') resolve();
        else if (m.op === 'ready') this.onReady(m['listenId'] as string, m['localPort'] as number);
        else if (m.op === 'closed') this.closed.set(m['listenId'] as string, { code: m['code'] as number, reason: m['reason'] as string });
        else if (m.op === 'report') this.reports.get(m['id'] as number)?.(m['listeners'] as Record<string, ListenerCounts>);
      });
    });
  }

  private readonly stalled = new Set<string>();

  started(): Promise<void> {
    return this.up;
  }

  open(listenId: string, url: string, stalled: boolean): void {
    if (stalled) this.stalled.add(listenId);
    this.child.send({ op: 'open', listenId, url, stalled, pingMs: AGENCY_LISTEN_PING_INTERVAL_MS });
  }

  count(on: boolean): void {
    this.child.send({ op: 'count', on });
  }

  report(): Promise<Record<string, ListenerCounts>> {
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.reports.set(id, (listeners) => { this.reports.delete(id); resolve(listeners); });
      this.child.send({ op: 'report', id });
    });
  }

  terminate(listenId: string): void {
    this.child.send({ op: 'terminate', listenId });
  }

  stop(): void {
    if (this.child.connected) this.child.disconnect();
    this.child.kill();
  }

  private onReady(listenId: string, localPort: number): void {
    this.ready.add(listenId);
    if (this.stalled.has(listenId)) corkServerEnd(localPort);
  }
}

let clients: ListenerClients;

interface Listener { listenId: string; callId: string; stalled: boolean }

async function listen(who: User, callId: string, stalled: boolean): Promise<Listener> {
  const res = await http(who, 'POST', `/proxy/agency/live-calls/${callId}/listen`);
  expect(res.statusCode, res.body).toBe(201);
  const grant = res.json() as { listen_id: string; ws_url: string };
  clients.open(grant.listen_id, `${rig!.origin.replace('http', 'ws')}${grant.ws_url}`, stalled);
  return { listenId: grant.listen_id, callId, stalled };
}

type RawSocket = { remotePort?: number; cork(): void };

/**
 * A stalled reader as a real network path shows it to the server: its kernel stops taking bytes.
 * On loopback (64 KiB segments) the kernel autotunes a socket's send buffer to `tcp_wmem`'s
 * maximum, 4 MiB here: about four minutes of one listener's 100 messages a second (measured:
 * 4.0 MB absorbed by a paused loopback reader before `ws` buffered anything), against tens of KiB
 * across a real path. So, besides the client pausing its socket, the listener's server end is
 * corked once (`net.Socket.cork`: every write from here on stays in the process's own send buffer,
 * which is what `bufferedAmount` reads, exactly as when the kernel refuses more). Nothing else
 * about the server side is touched.
 */
function corkServerEnd(clientPort: number): void {
  const serverEnd = [...rig!.app.websocketServer.clients]
    .map((ws) => (ws as unknown as { _socket?: RawSocket })._socket)
    .find((sock) => sock?.remotePort === clientPort);
  if (!serverEnd) throw new Error(`no server end for the stalled listener on port ${clientPort}`);
  serverEnd.cork();
}

interface ListenRow { id: string; ended_at: Date | null; end_reason: string | null; frames_sent: number; frames_dropped: number }

async function listenRows(): Promise<Map<string, ListenRow>> {
  const { rows } = await pool().query<ListenRow>('SELECT id, ended_at, end_reason, frames_sent, frames_dropped FROM agency_listen_sessions');
  return new Map(rows.map((r) => [r.id, { ...r, frames_sent: Number(r.frames_sent), frames_dropped: Number(r.frames_dropped) }]));
}

// ─── What is measured ───────────────────────────────────────────────────────

interface DwellHistogram { boundaries: number[]; counts: number[]; count: number; sum: number }

/** `webrtc_relay_dwell_seconds` for one direction, cumulative since the process started. */
async function dwellHistogram(direction: 'b2p' | 'p2b'): Promise<DwellHistogram> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === 'webrtc_relay_dwell_seconds');
  const point = metric?.dataPoints.find((p) => p.attributes['direction'] === direction);
  if (!point) return { boundaries: [], counts: [], count: 0, sum: 0 };
  const v = point.value as { buckets: { boundaries: number[]; counts: number[] }; count: number; sum?: number };
  return { boundaries: [...v.buckets.boundaries], counts: [...v.buckets.counts], count: v.count, sum: v.sum ?? 0 };
}

interface Dwell {
  samples: number;
  meanMicros: number;
  /** The upper bound of the bucket holding the p99, in µs (Infinity past the last bucket). */
  p99Micros: number;
  /** That bucket's index. */
  p99Bucket: number;
}

function dwellBetween(before: DwellHistogram, after: DwellHistogram): Dwell {
  const counts = after.counts.map((c, i) => c - (before.counts[i] ?? 0));
  const samples = after.count - before.count;
  const want = Math.ceil(samples * 0.99);
  let cumulative = 0;
  let p99Bucket = counts.length - 1;
  for (let i = 0; i < counts.length; i++) {
    cumulative += counts[i]!;
    if (cumulative >= want) { p99Bucket = i; break; }
  }
  const bound = after.boundaries[p99Bucket];
  return {
    samples,
    meanMicros: samples > 0 ? Math.round(((after.sum - before.sum) / samples) * 1e6 * 10) / 10 : 0,
    p99Micros: bound === undefined ? Infinity : Math.round(bound * 1e6),
    p99Bucket,
  };
}

interface Latency { frames: number; meanMs: number; p50Ms: number; p90Ms: number; p95Ms: number; p99Ms: number; maxMs: number }

/** The end-to-end latency of every frame SENT inside the window [t0, t1), over all calls. */
function latencyIn(legs: Array<[sentAt: number[], heardAt: number[]]>, t0: number, t1: number): Latency {
  const all: number[] = [];
  for (const [sentAt, heardAt] of legs) {
    for (let k = 0; k < sentAt.length && k < heardAt.length; k++) {
      if (sentAt[k]! >= t0 && sentAt[k]! < t1) all.push(heardAt[k]! - sentAt[k]!);
    }
  }
  all.sort((a, b) => a - b);
  const at = (q: number) => Math.round((all[Math.min(all.length - 1, Math.floor(all.length * q))] ?? 0) * 100) / 100;
  const mean = all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  return {
    frames: all.length, meanMs: Math.round(mean * 100) / 100, p50Ms: at(0.5), p90Ms: at(0.9), p95Ms: at(0.95), p99Ms: at(0.99),
    maxMs: Math.round((all.at(-1) ?? 0) * 100) / 100,
  };
}

/** One measured window of a floor. */
interface WindowResult {
  loop: LoopSample;
  /** A frame's trip, carrier → agent and agent → carrier, for frames sent in the window. */
  latency: { toAgent: Latency; toCarrier: Latency };
  dwell: { b2p: Dwell; p2b: Dwell };
}

interface Measured { t0: number; t1: number; loop: LoopSample; dwell: WindowResult['dwell'] }

/** Sample the loop and the relay's dwell over one window; the latency is read once the floor has ended. */
async function measure(): Promise<Measured> {
  const before = { b2p: await dwellHistogram('b2p'), p2b: await dwellHistogram('p2b') };
  const sampler = createLoopSampler({ windowMs: 60 * 60_000 });
  const t0 = performance.now();
  await sleep(WINDOW_MS);
  const t1 = performance.now();
  sampler.stop();
  return {
    t0, t1, loop: sampler.latest(),
    dwell: { b2p: dwellBetween(before.b2p, await dwellHistogram('b2p')), p2b: dwellBetween(before.p2b, await dwellHistogram('p2b')) },
  };
}

interface RunResult {
  name: string;
  listeners: number;
  /** The floor with nobody listening. */
  quiet: WindowResult;
  /** The same floor with its listeners (runs b and c). */
  listening: WindowResult | null;
  /** The calls' `maxRelayDwellMicros`: their median and their worst, over the whole call (reported). */
  maxDwellMicros: { median: number; worst: number };
  /** Each reading listener's messages a second over the listeners' window, per leg. */
  legRates: Array<{ customer: number; agent: number }>;
}

/** Counter deltas over a run. */
async function counters(): Promise<Record<string, number>> {
  const read = async (name: string, attrs: Record<string, unknown>) => (await metricValue(reader, name, attrs)) ?? 0;
  return {
    mediaDropped: await read('websocket_send_backpressure_total', { socket: 'listener', action: 'media_dropped' }),
    listenerClosed: await read('websocket_send_backpressure_total', { socket: 'listener', action: 'closed' }),
    granted: await read('agency_listen_grants_total', { result: 'granted' }),
    refusedServer: await read('agency_listen_grants_total', { result: 'listen_limit_server' }),
    endedCall: await read('agency_listen_sessions_ended_total', { reason: 'call_ended' }),
    endedDisconnected: await read('agency_listen_sessions_ended_total', { reason: 'listener_disconnected' }),
  };
}

// ─── One run ────────────────────────────────────────────────────────────────

async function runFloor(name: string, listenerCount: number): Promise<RunResult> {
  const r = rig!;
  const streamMs = listenerCount === 0 ? BASELINE_STREAM_MS : LISTEN_STREAM_MS;
  const frames = Math.round(streamMs / FRAME_MS);
  const port = (stationServer.address() as { port: number }).port;
  const before = await counters();

  // The floor: every call dialled at once, each with its own carrier script and agent station.
  const plans: Plan[] = Array.from({ length: CALLS }, (_, i) => ({
    index: i,
    number: numberFor(i),
    station: new AgentStation(i % 2 === 0 ? 'alaw8' : 'pcm16', carrierScripts.framePattern(rng, frames), port),
    carrierSentAt: [],
    carrierHeardAt: [],
  }));
  const scripts = new Map(plans.map((p) => [p.number, carrierScripts.answered({
    pattern: carrierScripts.framePattern(rng, frames),
    ending: 'webhook_then_close',
    afterStart: [{ do: 'waitFor', what: 'the carrier socket timed', until: (c) => timeCarrier(c, p) }],
    // Hang up once the agent's whole utterance has reached the carrier.
    beforeEnding: [{
      do: 'waitFor', what: 'the agent\'s audio at the carrier', timeoutMs: 60_000,
      until: (c) => c.mediaReceived.length >= p.station.pattern.length,
    }],
  }).script]));
  r.carrier.setScript((lead: LeadRequest) => scripts.get(lead.customer_number) ?? null);
  await Promise.all(plans.map((p) => p.station.connect()));
  await Promise.all(plans.map(async (p) => {
    const { callId, attemptId } = await dialBridged(r, p.station.server as never, `+91${p.number}`);
    p.callId = callId;
    p.attemptId = attemptId;
  }));
  await waitFor('every call live', () => plans.every((p) => p.station.live), 30_000,
    () => `${plans.filter((p) => p.station.live).length}/${plans.length} live`);

  // ── The quiet window: the floor, nobody listening ──
  await sleep(SETTLE_MS);
  const quiet = await measure();

  // The listeners: two to a call (the per-call cap), each a supervisor of their own (one listen
  // each). The last one stalls: it shares its call with a listener that reads.
  const listeners: Listener[] = [];
  const listened = plans.slice(0, Math.ceil(listenerCount / 2));
  const spare = plans[listened.length]!;
  for (const p of [...listened, spare]) if (listenerCount > 0) await makeListenable(p);
  for (let i = 0; i < listenerCount; i++) {
    const supervisor = await user('account_admin');
    listeners.push(await listen(supervisor, plans[Math.floor(i / 2)]!.callId!, i === listenerCount - 1));
  }
  await waitFor('every listener ready', () => listeners.every((l) => clients.ready.has(l.listenId) || clients.closed.has(l.listenId)), 15_000);
  for (const l of listeners) expect(clients.closed.get(l.listenId), `listener ${l.listenId}`).toBeUndefined();
  if (listenerCount > 0) await sleep(SETTLE_MS);

  // ── The listeners' window: the same floor, listened to ──
  let listening: Measured | null = null;
  if (listenerCount > 0) {
    clients.count(true);
    listening = await measure();
    clients.count(false);
    expect(await metricValue(reader, 'agency_listen_sessions_active'), 'listen sessions open in the window').toBe(listenerCount);
  }
  const elapsedS = listening ? (listening.t1 - listening.t0) / 1000 : 0;

  // At the process cap, one more grant is refused (and counted) while the floor carries on.
  if (listenerCount >= config.agency.listen.maxPerProcess) {
    const late = await user('account_admin');
    const refused = await http(late, 'POST', `/proxy/agency/live-calls/${spare.callId}/listen`);
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'listen_limit_server' });
  }

  // The stalled listener: dropped at its soft limit, then ended by the idle bound; the call goes on.
  const stalled = listeners.find((l) => l.stalled);
  if (stalled) {
    await waitFor('the stalled listener ended', async () => {
      const row = (await listenRows()).get(stalled.listenId);
      return row?.ended_at ? row : null;
    }, AGENCY_LISTEN_IDLE_TIMEOUT_MS + 5_000);
    const stalledCall = r.bridge.getSession(stalled.callId);
    expect(stalledCall, 'the stalled listener\'s call is still up').toBeDefined();
    // Its other listener still hears both legs.
    const partner = listeners.find((l) => l !== stalled && l.callId === stalled.callId)!;
    const heardBy = async () => { const c = (await clients.report())[partner.listenId]!; return c.customer + c.agent; };
    const heard = await heardBy();
    await waitFor('the partner still hears the call', async () => (await heardBy()) > heard + 50, 5_000);
    // The client is let go: its server end is closing (4408) and waits on a close handshake that
    // a paused reader never answers.
    clients.terminate(stalled.listenId);
  }

  // The calls end (the carrier hangs up once both directions are through).
  await r.carrier.settled();
  const rows = await waitAllTerminal(r, plans.map((p) => p.callId!), 60_000);
  await waitFor('every listener closed', () => listeners.every((l) => clients.closed.has(l.listenId)), 15_000);
  await platformAuditLogger.shutdown();

  // ── The call path dropped nothing, in any run ──
  for (const p of plans) {
    const call: CarrierCall = r.carrier.calls.get(p.callId!)!;
    const session = r.captured.get(p.callId!)!;
    const ctx = `${name}: call ${p.index} (${p.station.format}) ${p.callId} seed ${LOAD_SEED}`;
    expect(call.errors, ctx).toEqual([]);
    expect(rows.get(p.callId!)!.status, ctx).toBe('completed');
    expect(p.station.odd, ctx).toBe(0);
    expect(p.station.sent, `${ctx}: the agent talked to the end`).toBe(p.station.pattern.length);
    expect(p.station.heard.length, `${ctx}: frames the agent heard`).toBe(call.mediaSentPattern.length);
    expect(bits(p.station.heard), `${ctx}: carrier → agent`).toBe(bits(call.mediaSentPattern));
    expect(call.mediaReceived.length, `${ctx}: frames the carrier heard`).toBe(p.station.pattern.length);
    expect(bits(call.mediaReceived.map(isLoudAlaw)), `${ctx}: agent → carrier`).toBe(bits(p.station.pattern));
    expect({ toAgent: session.droppedBrowserMediaFrames, toCarrier: session.droppedPstnMediaFrames }, ctx)
      .toEqual({ toAgent: 0, toCarrier: 0 });
    // The timing hooks saw every frame (so frame k sent is frame k heard).
    expect({ sent: p.carrierSentAt.length, heard: p.carrierHeardAt.length, agentHeard: p.station.heardAt.length }, ctx)
      .toEqual({ sent: call.mediaSentPattern.length, heard: call.mediaReceived.length, agentHeard: p.station.heard.length });
  }
  const windowOf = (m: Measured): WindowResult => ({
    loop: m.loop,
    latency: {
      toAgent: latencyIn(plans.map((p) => [p.carrierSentAt, p.station.heardAt]), m.t0, m.t1),
      toCarrier: latencyIn(plans.map((p) => [p.station.sentAt, p.carrierHeardAt]), m.t0, m.t1),
    },
    dwell: m.dwell,
  });

  // ── The listeners ──
  const after = await counters();
  const delta = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k]!])) as Record<string, number>;
  const listenRowsNow = await listenRows();
  const counts = await clients.report();
  const legRates: RunResult['legRates'] = [];
  for (const l of listeners) {
    const row = listenRowsNow.get(l.listenId)!;
    const heard = counts[l.listenId]!;
    const ctx = `${name}: listener ${l.listenId} on ${l.callId}${l.stalled ? ' (stalled)' : ''}`;
    expect(heard.odd, ctx).toBe(0);
    expect(heard.events[0], ctx).toBe('ready');
    if (l.stalled) {
      expect({ reason: row.end_reason, dropped: row.frames_dropped > 0 }, ctx).toEqual({ reason: 'listener_disconnected', dropped: true });
      continue;
    }
    const rate = { customer: heard.windowCustomer / elapsedS, agent: heard.windowAgent / elapsedS };
    legRates.push({ customer: Math.round(rate.customer * 10) / 10, agent: Math.round(rate.agent * 10) / 10 });
    const perLeg = 1000 / FRAME_MS;
    for (const leg of ['customer', 'agent'] as const) {
      expect(rate[leg], `${ctx}: ${leg} messages a second`).toBeGreaterThanOrEqual(perLeg * (1 - LEG_RATE_TOLERANCE));
      expect(rate[leg], `${ctx}: ${leg} messages a second`).toBeLessThanOrEqual(perLeg * (1 + LEG_RATE_TOLERANCE));
    }
    expect(clients.closed.get(l.listenId), ctx).toEqual({ code: 1000, reason: 'call_ended' });
    expect(heard.events.at(-1), ctx).toBe('ended');
    expect({ reason: row.end_reason, dropped: row.frames_dropped }, ctx).toEqual({ reason: 'call_ended', dropped: 0 });
    expect(row.frames_sent, ctx).toBe(heard.customer + heard.agent);
  }
  if (listenerCount > 0) {
    const stalledRow = listenRowsNow.get(stalled!.listenId)!;
    expect(delta, `${name}: listen metrics`).toMatchObject({
      // Every frame the stalled listener missed was dropped at its soft limit, and counted there.
      mediaDropped: stalledRow.frames_dropped,
      listenerClosed: 0,
      granted: listenerCount,
      refusedServer: listenerCount >= config.agency.listen.maxPerProcess ? 1 : 0,
      endedCall: listenerCount - 1,
      endedDisconnected: 1,
    });
    expect(await metricValue(reader, 'agency_listen_sessions_active'), 'listen sessions open after the floor').toBe(0);
  } else {
    expect(delta, `${name}: no listen activity`).toMatchObject({ mediaDropped: 0, granted: 0, endedCall: 0 });
  }

  const maxDwells = plans.map((p) => r.captured.get(p.callId!)!.maxRelayDwellMicros).sort((a, b) => a - b);
  const result: RunResult = {
    name, listeners: listenerCount, quiet: windowOf(quiet), listening: listening ? windowOf(listening) : null,
    maxDwellMicros: { median: Math.round(maxDwells[Math.floor(maxDwells.length / 2)]!), worst: Math.round(maxDwells.at(-1)!) },
    legRates,
  };
  // One line per run, on a green run too (`console` output is shown for failed tests only): the
  // numbers docs/listening.md §10 records, and what a red run is read from.
  process.stdout.write(`[listen-load] ${JSON.stringify({ calls: CALLS, seed: LOAD_SEED, ...result, legRates: summariseRates(legRates) })}\n`);

  for (const p of plans) p.station.close();
  await assertNoLeaks(r, [], 0);
  for (const p of plans) expect(p.station.borrowedListeners(), `${name}: call ${p.index}'s borrowed socket`).toBe(p.station.serverListeners);
  return result;
}

function summariseRates(rates: RunResult['legRates']): { min: number; max: number } | null {
  if (rates.length === 0) return null;
  const all = rates.flatMap((r) => [r.customer, r.agent]);
  return { min: Math.min(...all), max: Math.max(...all) };
}

/** The listeners' window against the same floor's quiet one, within the bounds above. */
function expectWithinQuiet(run: RunResult): void {
  const b = run.quiet;
  const l = run.listening!;
  const within = (was: number, ratio: number, slack: number) => Math.max(was * ratio, was + slack);
  const ctx = (what: string, was: number) => `${run.name}: ${what} with listeners, against ${was} without`;
  expect(l.loop.elu, ctx('event-loop utilisation', b.loop.elu)).toBeLessThanOrEqual(b.loop.elu + ELU_SLACK);
  expect(l.loop.loopDelayP99Ms, ctx('event-loop delay p99 (ms)', b.loop.loopDelayP99Ms))
    .toBeLessThanOrEqual(within(b.loop.loopDelayP99Ms, LOOP_P99_RATIO, LOOP_P99_SLACK_MS));
  for (const leg of ['toAgent', 'toCarrier'] as const) {
    const was = b.latency[leg];
    const now = l.latency[leg];
    expect(now.frames, `${run.name}: ${leg} frames timed`).toBeGreaterThan(0);
    expect(now.p50Ms, ctx(`${leg} frame latency p50 (ms)`, was.p50Ms))
      .toBeLessThanOrEqual(within(was.p50Ms, LATENCY_P50_RATIO, LATENCY_P50_SLACK_MS));
    expect(now.p95Ms, ctx(`${leg} frame latency p95 (ms)`, was.p95Ms))
      .toBeLessThanOrEqual(within(was.p95Ms, LATENCY_P95_RATIO, LATENCY_P95_SLACK_MS));
  }
  for (const dir of ['b2p', 'p2b'] as const) {
    const was = b.dwell[dir];
    const now = l.dwell[dir];
    expect(now.samples, `${run.name}: ${dir} dwell samples`).toBeGreaterThan(0);
    expect(now.meanMicros, ctx(`${dir} relay dwell mean (µs)`, was.meanMicros))
      .toBeLessThanOrEqual(within(was.meanMicros, DWELL_MEAN_RATIO, DWELL_MEAN_SLACK_MICROS));
    expect(now.p99Bucket, ctx(`${dir} relay dwell p99 bucket (≤ ${now.p99Micros} µs)`, was.p99Micros))
      .toBeLessThanOrEqual(was.p99Bucket + DWELL_P99_BUCKET_STEPS);
  }
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let rig: LoadRig | null = null;
let stopVoice: (() => Promise<void>) | null = null;
let stopAgency: (() => Promise<void>) | null = null;

beforeAll(async () => {
  initLoadDb(16);
  fb.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    const uid = token.slice(4);
    return { uid, email: `${uid}@example.test`, email_verified: true };
  });
  stationServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  stationServer.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    ws.on('error', () => { /* the bridge's own handler logs; the close follows */ });
    const id = (req.url ?? '').split('/').at(-1) ?? '';
    pendingServerEnds.get(id)?.(ws);
    pendingServerEnds.delete(id);
  });
  await new Promise<void>((resolve) => stationServer.once('listening', resolve));
  clients = new ListenerClients();
  await clients.started();
});

beforeEach(async () => {
  await resetAgencyRuntimeForTests();
  rig = await startLoadRig();
  await pool().query(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'Listen load tenant', 'listen-load')`, [TENANT]);
  await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Main', 'main')`, [ACCOUNT, TENANT]);
  await pool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
     VALUES ('agency_live_listen_enabled', 'account', $1, $2, 'true'::jsonb)`, [TENANT, ACCOUNT]);
  await getFeatureFlagService().invalidate({ tenantId: TENANT });
  // The campaign the calls are correlated to (`dialBridged`): a draft, so pacing dials nothing.
  await pool().query(
    `INSERT INTO agency_campaigns (id, tenant_id, account_id, name, caller_ids, telephony_provider, status)
     VALUES ($1, $2, $3, 'Listen load', ARRAY['+919800000001'], 'voicelink', 'draft')`, [CAMPAIGN, TENANT, ACCOUNT]);
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  stopVoice = await startVoice(ctx);
  stopAgency = await startAgency(ctx);
});

afterEach(async () => {
  await rig?.carrier.settled().catch(() => undefined);
  if (stopAgency) await stopAgency();
  if (stopVoice) await stopVoice();
  stopAgency = null;
  stopVoice = null;
  await stopLoadRig(rig);
  rig = null;
  await resetAgencyRuntimeForTests();
}, 60_000);

afterAll(async () => {
  clients?.stop();
  for (const ws of stationServer.clients) ws.terminate();
  await new Promise<void>((resolve) => stationServer.close(() => resolve()));
  await closeLoadDb();
});

// ─── The suite ──────────────────────────────────────────────────────────────

describe(`live call listening under load (calls ${CALLS}, seed ${LOAD_SEED})`, () => {
  it('(a) baseline: the floor with nobody listening relays every frame both ways', async () => {
    await runFloor('baseline', 0);
  }, 120_000);

  it(`(b) the expected peak, ${PEAK_LISTENERS} listeners, one stalled: the call path drops nothing, the loop and the frames' latency stay within bounds of the quiet floor, the stalled one is dropped then ended`, async () => {
    expectWithinQuiet(await runFloor('peak', PEAK_LISTENERS));
  }, 180_000);

  it(`(c) the process cap, ${CAP_LISTENERS} listeners, one stalled, a 21st refused: the same, at the cap`, async () => {
    expect(config.agency.listen.maxPerProcess).toBe(CAP_LISTENERS);
    expectWithinQuiet(await runFloor('cap', CAP_LISTENERS));
  }, 180_000);
});
