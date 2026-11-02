import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChildSupervisor } from '../../../src/cluster/child-supervisor.js';
import { forkServerChild } from '../../../src/cluster/fork.js';
import { slotFor } from '../../../src/cluster/roles.js';
import { registerWsHandoff, type WsHandoffTarget } from '../../../src/cluster/ws-handoff.plugin.js';
import { WS_MAX_PAYLOAD_DEFAULT_BYTES } from '../../../src/utils/ws-limits.js';
import { MOBILE_STATION_PROBE_MS } from '@magick-agency/domain/timers';

/*
 * The upgrade handoff with real processes (docs/scaling.md §2): a primary Fastify app with
 * `registerWsHandoff` (the production plugin) accepts every upgrade, runs its hooks, and
 * hands each socket to a forked worker (`test/helpers/ws-handoff-child-entry.ts`, the
 * production adoption path) chosen by the route's `wsOwner`. Pins what the spike measured:
 * routing by key, the query and client IP surviving, frames both ways, `maxPayload`
 * enforced by the worker, the primary's own 429 / 404 / 503 answers before any handoff,
 * and a first frame the client sends before the 101 is never lost. And the mobile liveness
 * probe on an adopted socket (the real `StationRegistry` in the worker): pinged, renewed by
 * its pongs, and its timer and listeners gone with the socket.
 */

const ENTRY = resolve(__dirname, '../../helpers/ws-handoff-child-entry.ts');
const WORKERS = 2;

let app: FastifyInstance;
let supervisor: ChildSupervisor;
let port = 0;

beforeAll(async () => {
  supervisor = new ChildSupervisor({
    role: 'media',
    count: WORKERS,
    fork: (slot) => forkServerChild({ role: 'media', slot, entry: ENTRY, execArgv: ['--import', 'tsx'], env: { ...process.env, LOG_LEVEL: 'warn' } }),
    restartBackoffMs: [60_000],
  });
  await supervisor.start();

  const target: WsHandoffTarget = {
    slotFor: (owner, params, query) => {
      const slot = owner.by === 'session'
        ? slotFor(params[owner.param] ?? '', WORKERS)
        : (typeof query['w'] === 'string' && /^\d+$/.test(query['w']) ? Number(query['w']) : null);
      return slot !== null && slot < WORKERS && supervisor.isReady(slot) ? slot : null;
    },
    handoff: (slot, msg, socket) => supervisor.sendHandoff(slot, msg, socket),
  };
  app = Fastify({ logger: false });
  // Stands in for the Redis rate limiter: async, before routing, can answer the upgrade.
  app.addHook('onRequest', async (request, reply) => {
    await new Promise((r) => setTimeout(r, 3));
    if (request.headers['x-test-limit'] === '1') return reply.code(429).send({ error: 'rate_limited' });
  });
  registerWsHandoff(app, { target: () => target });
  app.get('/proxy/agency/station/:sessionId', { websocket: true, config: { wsOwner: { by: 'session', param: 'sessionId' } } }, () => {});
  app.get('/api/v1/webrtc-call/:id/pstn-stream', { websocket: true, config: { wsOwner: { by: 'carrier_hint', param: 'id' } } }, () => {});
  app.get('/probe/station/:sessionId', { websocket: true, config: { wsOwner: { by: 'session', param: 'sessionId' } } }, () => {});
  app.get('/probe/inspect/:sessionId', { websocket: true, config: { wsOwner: { by: 'session', param: 'sessionId' } } }, () => {});
  app.get('/ping', async () => ({ ok: true }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as net.AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  await supervisor?.stop(5_000);
});

interface Hello { slot: number; pid: number; ip: string; url: string; requestId?: string }
function open(path: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; hello: Hello }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.once('error', reject);
    ws.once('message', (d) => resolve({ ws, hello: JSON.parse(d.toString()) as Hello }));
  });
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!))]);
}

/** A raw upgrade whose first frame goes out before the 101 is read: in the request's own write, or 1 ms later (during the primary's hook). */
async function earlyFrameArrives(sameWrite: boolean): Promise<boolean> {
  const id = randomUUID();
  const pstn = await open(`/api/v1/webrtc-call/${id}/pstn-stream?token=p&w=${slotFor(id, WORKERS)}`);
  const relayed = new Promise<boolean>((r) => {
    pstn.ws.on('message', (d) => {
      const f = JSON.parse(d.toString()) as { event?: string; media?: { payload: string } };
      if (f.event === 'media' && Buffer.from(f.media!.payload, 'base64').length === 100) r(true);
    });
    setTimeout(() => r(false), 2_000);
  });
  const sock = net.connect(port, '127.0.0.1');
  const key = randomBytes(16).toString('base64');
  const request = Buffer.from(`GET /proxy/agency/station/${id}?token=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const frame = maskedFrame(0x2, Buffer.alloc(100, 0x55));
  if (sameWrite) sock.write(Buffer.concat([request, frame]));
  else { sock.write(request); setTimeout(() => sock.write(frame), 1); }
  // And the 101 the worker wrote is a real one.
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  const handshake = await new Promise<string>((r) => sock.once('data', (d) => r(d.toString())));
  const ok = await relayed;
  sock.destroy();
  pstn.ws.close();
  return ok && handshake.startsWith('HTTP/1.1 101') && handshake.includes(accept);
}

describe('WebSocket upgrade handoff to forked workers', () => {
  it("both legs of a call land on the worker the keys name, with the request's query, client IP and request id", async () => {
    const id = randomUUID();
    const slot = slotFor(id, WORKERS);
    const st = await open(`/proxy/agency/station/${id}?token=abc&client=web&media=alaw8`, { 'x-request-id': 'req-123' });
    const ps = await open(`/api/v1/webrtc-call/${id}/pstn-stream?token=def&w=${slot}`);
    expect(st.hello.slot).toBe(slot);
    expect(ps.hello.slot).toBe(slot);
    expect(st.hello.pid).toBe(supervisor.pidOf(slot));
    expect(st.hello.url).toBe(`/proxy/agency/station/${id}?token=abc&client=web&media=alaw8`);
    expect(st.hello.ip).toBe('127.0.0.1');
    expect(st.hello.requestId).toBe('req-123');

    const toAgent = new Promise<boolean>((r) => st.ws.once('message', (d, bin) => r(bin && (d as Buffer).length === 160)));
    const toCarrier = new Promise<boolean>((r) => ps.ws.once('message', (d) => r(Buffer.from(JSON.parse(d.toString()).media.payload, 'base64').length === 160)));
    st.ws.send(Buffer.alloc(160, 0x55), { binary: true });
    ps.ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, 0xd5).toString('base64') } }));
    expect(await toCarrier).toBe(true);
    expect(await toAgent).toBe(true);

    // maxPayload is the worker's: one byte past it closes 1009.
    const closed = new Promise<number>((r) => st.ws.once('close', (code) => r(code)));
    st.ws.send(Buffer.alloc(WS_MAX_PAYLOAD_DEFAULT_BYTES + 1), { binary: true });
    expect(await closed).toBe(1009);
    ps.ws.close();
  });

  it("the primary's hooks answer before any handoff: 429 from the limiter, 404 for an unknown path", async () => {
    await expect(open(`/proxy/agency/station/${randomUUID()}`, { 'x-test-limit': '1' })).rejects.toThrow('http 429');
    await expect(open('/nope')).rejects.toThrow('http 404');
  });

  it('a carrier stream with no usable slot hint is refused 503 with retry-after, not dropped', async () => {
    await expect(open(`/api/v1/webrtc-call/${randomUUID()}/pstn-stream?token=x`)).rejects.toThrow('http 503');
    await expect(open(`/api/v1/webrtc-call/${randomUUID()}/pstn-stream?token=x&w=99`)).rejects.toThrow('http 503');
  });

  it('plain HTTP stays in the primary, keep-alive and all; a plain GET on a WebSocket route is 404', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = (path: string) => new Promise<number>((r) => http.get({ port, host: '127.0.0.1', path, agent }, (res) => { res.resume(); res.on('end', () => r(res.statusCode ?? 0)); }));
    expect(await get('/ping')).toBe(200);
    expect(await get(`/proxy/agency/station/${randomUUID()}`)).toBe(404);
    expect(await get('/ping')).toBe(200);
    agent.destroy();
  });

  it('a first frame sent before the 101 is not lost: in the same write as the request, or during the primary\'s hook', async () => {
    expect(await earlyFrameArrives(true)).toBe(true);
    expect(await earlyFrameArrives(false)).toBe(true);
  });

  it("a mobile station on an adopted socket: the worker's probe pings it, its pongs renew it, and the probe goes with the socket", async () => {
    interface Inspect { slot: number; probes: number; stations: number; lastSeen: number | null; pongListeners: number | null }
    const id = randomUUID();
    const inspect = async (): Promise<Inspect> => {
      const { ws, hello } = await open(`/probe/inspect/${id}`);
      ws.close();
      return hello as unknown as Inspect;
    };
    const connect = (): Promise<{ ws: WebSocket; pings: number[] }> => new Promise((resolve, reject) => {
      // `autoPong: false`: each pong is sent by hand below.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/probe/station/${id}?client=mobile`, { autoPong: false });
      const pings: number[] = [];
      ws.on('ping', () => pings.push(Date.now()));
      ws.once('error', reject);
      ws.once('message', () => resolve({ ws, pings }));
    });

    const first = await connect();
    expect(await inspect()).toMatchObject({ slot: slotFor(id, WORKERS), probes: 1, stations: 1, pongListeners: 1 });
    const t0 = Date.now();
    while (first.pings.length === 0 && Date.now() - t0 < MOBILE_STATION_PROBE_MS + 2_000) await new Promise((r) => setTimeout(r, 20));
    expect(first.pings.length).toBe(1);
    const before = (await inspect()).lastSeen!;
    first.ws.pong();
    await new Promise((r) => setTimeout(r, 100));
    expect((await inspect()).lastSeen!).toBeGreaterThan(before);

    // A reconnect supersedes it: one probe, on the new socket only.
    const firstClosed = new Promise<number>((r) => first.ws.once('close', (code) => r(code)));
    const second = await connect();
    expect(await firstClosed).toBe(4409);
    expect(await inspect()).toMatchObject({ probes: 1, stations: 1, pongListeners: 1 });

    // The phone's transport dies: the entry, the timer and the listeners go with it.
    second.ws.terminate();
    const t1 = Date.now();
    let after = await inspect();
    while ((after.probes !== 0 || after.stations !== 0) && Date.now() - t1 < 5_000) after = await inspect();
    expect(after).toMatchObject({ probes: 0, stations: 0, lastSeen: null });
  });

  it('a WebSocket route without wsOwner is refused at registration', async () => {
    const other = Fastify();
    registerWsHandoff(other, { target: () => null });
    expect(() => other.get('/ws', { websocket: true }, () => {})).toThrow(/wsOwner/);
    await other.close();
  });

  // Last: it closes the primary. A socket a worker holds must not hold the primary's
  // HTTP close (shutdown's first step) open: `child_process` would otherwise track it
  // against the server and `close()` would wait for the worker (socket-pause.ts).
  it("the primary's close is not held open by a socket a worker still holds", async () => {
    const live = await open(`/proxy/agency/station/${randomUUID()}?token=t`);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
    const closed = await Promise.race([
      app.close().then(() => 'closed'),
      new Promise((r) => setTimeout(() => r('held open'), 5_000)),
    ]);
    expect(closed).toBe('closed');
    live.ws.terminate();
  });
});

