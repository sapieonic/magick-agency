/**
 * Spike for `docs/scaling.md` §2: can a primary process accept every WebSocket upgrade on
 * one port, route it by a key in the path, and hand the raw socket to a forked worker that
 * completes the handshake through `@fastify/websocket`, with no per-frame work left in the
 * primary? Not a test and not product code: it prints what it measured and exits non-zero
 * if a check failed.
 *
 *   pnpm tsx scripts/spikes/ws-handoff-spike.ts                  # from apps/server
 *   SPIKE_CALLS=200 SPIKE_SECONDS=10 pnpm tsx scripts/spikes/ws-handoff-spike.ts
 *   SPIKE_NO_READSTOP=1 …   # mutation check: without stopping the primary's reads, the
 *                           # frame sent during the primary's async hook is lost
 *
 * Three roles in one file, chosen by argv[2]:
 *  - `primary` (default): a Fastify app that listens. Its own `upgrade` listener routes the
 *    request through Fastify (so an async `onRequest` hook standing in for the Redis rate
 *    limiter runs, and can answer 429 on the raw socket), then the WebSocket route's handler
 *    hijacks the reply, stops the socket's reads and sends `{ request line, headers, head }`
 *    plus the socket handle to the worker that owns the key (FNV-1a of the id, mod N).
 *  - `worker <slot>`: a Fastify app that never listens, with `@fastify/websocket` (64 KiB
 *    `maxPayload`). It rebuilds an `http.IncomingMessage` from the message and emits
 *    `upgrade` on its own `app.server`, so the handshake, hooks and route are the ordinary
 *    ones. Per call it relays like the bridge's A-law passthrough: a binary 160-byte frame on
 *    the station leg goes out as `{event:'media', media:{payload: base64}}` on the carrier
 *    leg, and the reverse.
 *  - `client`: the checks and the load, in its own process so its CPU is not the primary's.
 */
import { fork, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';

const role = process.argv[2] ?? 'primary';
const WORKERS = Number(process.env['SPIKE_WORKERS'] ?? 2);
const CALLS = Number(process.env['SPIKE_CALLS'] ?? 100);
const SECONDS = Number(process.env['SPIKE_SECONDS'] ?? 8);
const MAX_PAYLOAD = 65_536;

function slotFor(key: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % n;
}

/** The process's event-loop utilisation and CPU since the last call. */
function sampler(): () => { elu: number; cpuPct: number } {
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastAt = Date.now();
  return () => {
    const elu = performance.eventLoopUtilization(lastElu);
    lastElu = performance.eventLoopUtilization();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const ms = Date.now() - lastAt;
    lastAt = Date.now();
    return { elu: +elu.utilization.toFixed(3), cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / ms) * 100) };
  };
}

interface HandoffMessage {
  kind: 'handoff';
  route: 'station' | 'pstn';
  method: string;
  url: string;
  httpVersion: string;
  rawHeaders: string[];
  head: string; // base64
}

// ─── primary ────────────────────────────────────────────────────────────────

async function runPrimary(): Promise<void> {
  const workers: ChildProcess[] = [];
  const workerStats = new Map<number, Array<{ at: number; elu: number; cpuPct: number; relayedPerS: number }>>();
  const ready: Array<Promise<void>> = [];
  for (let slot = 0; slot < WORKERS; slot++) {
    const child = fork(__filename, ['worker', String(slot)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    workers.push(child);
    workerStats.set(slot, []);
    ready.push(new Promise((resolve) => child.on('message', (m: { kind?: string }) => { if (m.kind === 'ready') resolve(); })));
    child.on('message', (m: { kind?: string; id?: number; elu?: number; cpuPct?: number; relayedPerS?: number }) => {
      if (m.kind === 'stats') workerStats.get(slot)!.push({ at: Date.now(), elu: m.elu!, cpuPct: m.cpuPct!, relayedPerS: m.relayedPerS! });
      // A worker → primary request, answered at once: the IPC round-trip measurement.
      if (m.kind === 'req') child.send({ kind: 'res', id: m.id, ok: true });
    });
  }
  await Promise.all(ready);

  const kSocket = Symbol('handoff-socket');
  const kHead = Symbol('handoff-head');
  type Raw = http.IncomingMessage & { [kSocket]?: net.Socket; [kHead]?: Buffer };
  const app: FastifyInstance = Fastify({ logger: false });
  const handoffs = { station: 0, pstn: 0, bufferedAtHandoff: 0 };

  // Stands in for the app-scope Redis rate limiter: async, before routing, and able to
  // answer the upgrade with an HTTP status on the raw socket.
  app.addHook('onRequest', async (request, reply) => {
    await new Promise((r) => setTimeout(r, 3));
    if (request.headers['x-spike-limit'] === '1') return reply.code(429).send({ error: 'rate_limited' });
  });

  const handoff = (route: 'station' | 'pstn', key: string) => (request: { raw: Raw }, reply: { hijack(): void; code(n: number): { send(b?: unknown): void } }) => {
    const raw = request.raw;
    const socket = raw[kSocket];
    if (!socket) return reply.code(404).send();
    reply.hijack();
    const head = raw[kHead] ?? Buffer.alloc(0);
    // Anything already read into the JS stream would stay behind in this process.
    if (socket.readableLength > 0) handoffs.bufferedAtHandoff++;
    const msg: HandoffMessage = {
      kind: 'handoff', route, method: raw.method ?? 'GET', url: raw.url ?? '/',
      httpVersion: raw.httpVersion, rawHeaders: raw.rawHeaders, head: head.toString('base64'),
    };
    handoffs[route]++;
    workers[slotFor(key, WORKERS)]!.send(msg, socket);
  };
  app.get<{ Params: { sessionId: string } }>('/proxy/agency/station/:sessionId', (req, reply) =>
    handoff('station', req.params.sessionId)(req as never, reply as never));
  app.get<{ Params: { id: string } }>('/api/v1/webrtc-call/:id/pstn-stream', (req, reply) =>
    handoff('pstn', req.params.id)(req as never, reply as never));
  app.get('/ping', async () => ({ ok: true }));
  await app.ready();

  // Mirrors `@fastify/websocket`'s own `onUpgrade`: dispatch the upgrade through the Fastify
  // router with a ServerResponse bound to the socket, so hooks and 404s work as for HTTP.
  app.server.on('upgrade', (req: Raw, socket: net.Socket, head: Buffer) => {
    // Stop reading from the kernel NOW: whatever the client sends next must stay in the fd
    // and travel with it. `pause()` does not stop a plain socket's handle reading.
    const handle = (socket as unknown as { _handle?: { reading?: boolean; readStop(): number } })._handle;
    if (handle?.reading && process.env['SPIKE_NO_READSTOP'] !== '1') { handle.reading = false; handle.readStop(); }
    socket.on('error', () => socket.destroy());
    req[kSocket] = socket;
    req[kHead] = head;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    (app as unknown as { routing(req: unknown, res: unknown): void }).routing(req, res);
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as net.AddressInfo).port;

  const sample = sampler();
  const primaryStats: Array<{ at: number; elu: number; cpuPct: number }> = [];
  const timer = setInterval(() => primaryStats.push({ at: Date.now(), ...sample() }), 1000);
  // The client marks its steady-state load phase; only samples taken inside it count.
  const loadPhase = { from: Infinity, to: Infinity };

  const client = fork(__filename, ['client', String(port)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const result = await new Promise<{ checks: Record<string, boolean | number | string>; load: Record<string, number> }>((resolve) =>
    client.on('message', (m: { kind?: string }) => {
      if (m.kind === 'load-start') loadPhase.from = Date.now() + 1500; // skip the first second and a half
      if (m.kind === 'load-end') loadPhase.to = Date.now();
      if (m.kind === 'result') resolve(m as never);
    }));
  clearInterval(timer);
  const rtt = await Promise.all(workers.map((w) => new Promise<unknown>((resolve) => {
    w.on('message', (m: { kind?: string }) => { if (m.kind === 'rtt-result') resolve(m); });
    w.send({ kind: 'rtt' });
  })));

  const avg = (xs: number[]) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : 0);
  // A sample covers the second before it was taken, so it must end inside the phase.
  const loadWindow = <T extends { at: number }>(xs: T[]) => xs.filter((x) => x.at - 1000 >= loadPhase.from && x.at <= loadPhase.to);
  const perWorker = [...workerStats.entries()].map(([slot, xs]) => {
    const w = loadWindow(xs);
    return { slot, samples: w.length, elu: avg(w.map((x) => x.elu)), cpuPct: Math.round(avg(w.map((x) => x.cpuPct))), relayedPerS: Math.round(avg(w.map((x) => x.relayedPerS))) };
  });
  const pw = loadWindow(primaryStats);
  const summary = {
    workers: WORKERS, calls: CALLS, seconds: SECONDS,
    handoffs, checks: result.checks, load: result.load, ipcRoundTripMs: rtt,
    primary: { samples: pw.length, elu: avg(pw.map((x) => x.elu)), cpuPct: Math.round(avg(pw.map((x) => x.cpuPct))) },
    perWorker,
  };
  console.log(JSON.stringify(summary, null, 2));
  const failed = Object.entries(result.checks).filter(([, v]) => v === false).map(([k]) => k);
  for (const w of workers) w.kill();
  client.kill();
  await app.close();
  if (failed.length > 0) { console.error('FAILED:', failed.join(', ')); process.exit(1); }
  process.exit(0);
}

// ─── worker ─────────────────────────────────────────────────────────────────

async function runWorker(slot: number): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: MAX_PAYLOAD } });
  const calls = new Map<string, { station?: WebSocket; pstn?: WebSocket }>();
  let relayed = 0;
  const legOf = (id: string) => { let c = calls.get(id); if (!c) { c = {}; calls.set(id, c); } return c; };
  const hello = (ws: WebSocket, route: string, ip: string, url: string) =>
    ws.send(JSON.stringify({ event: 'hello', slot, pid: process.pid, route, ip, url }));

  app.get<{ Params: { sessionId: string } }>('/proxy/agency/station/:sessionId', { websocket: true }, (ws, req) => {
    const call = legOf(req.params.sessionId);
    call.station = ws;
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const p = call.pstn;
      if (p?.readyState === WebSocket.OPEN) { p.send(JSON.stringify({ event: 'media', media: { payload: data.toString('base64') } })); relayed++; }
    });
    ws.on('close', () => { if (call.station === ws) call.station = undefined; });
    hello(ws, 'station', req.ip, req.url);
  });
  app.get<{ Params: { id: string } }>('/api/v1/webrtc-call/:id/pstn-stream', { websocket: true }, (ws, req) => {
    const call = legOf(req.params.id);
    call.pstn = ws;
    ws.on('message', (data: Buffer) => {
      let frame: { event?: string; media?: { payload?: string } };
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.event !== 'media' || typeof frame.media?.payload !== 'string') return;
      const s = call.station;
      if (s?.readyState === WebSocket.OPEN) { s.send(Buffer.from(frame.media.payload, 'base64'), { binary: true }); relayed++; }
    });
    ws.on('close', () => { if (call.pstn === ws) call.pstn = undefined; });
    hello(ws, 'pstn', req.ip, req.url);
  });
  await app.ready();

  // IPC round-trip to the primary, the shape a `pacing.stillAuthorised` or event would take.
  let nextId = 1;
  const pending = new Map<number, number>();
  const rtts: number[] = [];

  process.on('message', (msg: HandoffMessage | { kind: 'res'; id: number } | { kind: 'rtt' }, handle?: unknown) => {
    if (msg.kind === 'handoff') {
      const socket = handle as net.Socket;
      socket.setNoDelay(true);
      const req = new http.IncomingMessage(socket);
      req.method = msg.method;
      req.url = msg.url;
      req.httpVersion = msg.httpVersion;
      const [major, minor] = msg.httpVersion.split('.').map(Number);
      req.httpVersionMajor = major ?? 1;
      req.httpVersionMinor = minor ?? 1;
      req.rawHeaders = msg.rawHeaders;
      const headers: http.IncomingHttpHeaders = {};
      for (let i = 0; i < msg.rawHeaders.length; i += 2) {
        const name = msg.rawHeaders[i]!.toLowerCase();
        const value = msg.rawHeaders[i + 1]!;
        const prev = headers[name];
        headers[name] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : `${prev}, ${value}`;
      }
      req.headers = headers;
      app.server.emit('upgrade', req, socket, Buffer.from(msg.head, 'base64'));
      return;
    }
    if (msg.kind === 'res') {
      const sentAt = pending.get(msg.id);
      if (sentAt !== undefined) { rtts.push(performance.now() - sentAt); pending.delete(msg.id); }
      return;
    }
    if (msg.kind === 'rtt') {
      const p = (q: number) => +([...rtts].sort((a, b) => a - b)[Math.floor(q * (rtts.length - 1))] ?? 0).toFixed(3);
      process.send!({ kind: 'rtt-result', slot, n: rtts.length, p50: p(0.5), p99: p(0.99) });
    }
  });
  // 20 requests a second to the primary throughout, so the RTT is measured under load.
  setInterval(() => { const id = nextId++; pending.set(id, performance.now()); process.send!({ kind: 'req', id, type: 'pacing.stillAuthorised' }); }, 50);

  const sample = sampler();
  let lastRelayed = 0;
  setInterval(() => {
    const s = sample();
    process.send!({ kind: 'stats', ...s, relayedPerS: relayed - lastRelayed });
    lastRelayed = relayed;
  }, 1000);
  process.send!({ kind: 'ready', slot });
}

// ─── client ─────────────────────────────────────────────────────────────────

function openWs(url: string, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; hello: { slot: number; pid: number; ip: string; url: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)));
    ws.once('error', reject);
    ws.once('message', (data) => resolve({ ws, hello: JSON.parse(data.toString()) }));
  });
}

/** One masked client frame (RFC 6455 §5.2), small payload. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]);
}

/**
 * A raw TCP upgrade whose first WebSocket frame is sent before the 101 is read: in the same
 * write as the request (`sameWrite`), or 1 ms later, while the primary is inside its async
 * hook. The worker must still see it.
 */
function earlyFrame(port: number, id: string, sameWrite: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const request = Buffer.from(
      `GET /proxy/agency/station/${id}?token=t HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const frame = clientFrame(0x2, Buffer.alloc(100, 0x55));
    let gotRelay = false;
    // Open the carrier leg first so the worker has somewhere to relay the early frame.
    openWs(`ws://127.0.0.1:${port}/api/v1/webrtc-call/${id}/pstn-stream?token=p`).then(({ ws }) => {
      ws.on('message', (d) => { const f = JSON.parse(d.toString()); if (f.event === 'media' && Buffer.from(f.media.payload, 'base64').length === 100) gotRelay = true; });
      if (sameWrite) sock.write(Buffer.concat([request, frame]));
      else { sock.write(request); setTimeout(() => sock.write(frame), 1); }
      setTimeout(() => { sock.destroy(); ws.close(); resolve(gotRelay); }, 500);
    }, () => resolve(false));
  });
}

async function runClient(port: number): Promise<void> {
  const checks: Record<string, boolean | number | string> = {};
  const base = `ws://127.0.0.1:${port}`;

  // 1. Both legs of one call land on the same worker, chosen by the key; the request line,
  //    query and client IP survive the handoff.
  const id = crypto.randomUUID();
  const st = await openWs(`${base}/proxy/agency/station/${id}?token=abc&client=web&media=alaw8`);
  const ps = await openWs(`${base}/api/v1/webrtc-call/${id}/pstn-stream?token=def`);
  checks['both_legs_same_worker'] = st.hello.slot === ps.hello.slot && st.hello.slot === slotFor(id, WORKERS);
  checks['query_survives'] = st.hello.url.endsWith('?token=abc&client=web&media=alaw8');
  checks['client_ip_survives'] = st.hello.ip === '127.0.0.1';

  // 2. Frames both ways through the worker's relay.
  const fromCarrier = new Promise<boolean>((r) => st.ws.once('message', (d, bin) => r(bin && (d as Buffer).length === 160)));
  const fromAgent = new Promise<boolean>((r) => ps.ws.once('message', (d) => r(Buffer.from(JSON.parse(d.toString()).media.payload, 'base64').length === 160)));
  st.ws.send(Buffer.alloc(160, 0x55), { binary: true });
  ps.ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.alloc(160, 0xd5).toString('base64') } }));
  checks['agent_to_carrier_frame'] = await fromAgent;
  checks['carrier_to_agent_frame'] = await fromCarrier;

  // 3. maxPayload is the worker's: past 64 KiB the socket closes 1009.
  checks['max_payload_1009'] = await new Promise<boolean>((r) => {
    st.ws.once('close', (code) => r(code === 1009));
    st.ws.send(Buffer.alloc(MAX_PAYLOAD + 1), { binary: true });
  });
  ps.ws.close();

  // 4. The primary's hooks answer before any handoff: a 429 and a 404 on the raw socket.
  checks['rate_limit_429_in_primary'] = await openWs(`${base}/proxy/agency/station/${crypto.randomUUID()}`, { 'x-spike-limit': '1' })
    .then(() => false, (e: Error) => e.message === 'http 429');
  checks['unknown_ws_route_404'] = await openWs(`${base}/nope`).then(() => false, (e: Error) => e.message === 'http 404');

  // 5. Plain HTTP stays in the primary, keep-alive and all.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const get = () => new Promise<number>((r) => http.get({ port, host: '127.0.0.1', path: '/ping', agent }, (res) => { res.resume(); res.on('end', () => r(res.statusCode ?? 0)); }));
  checks['http_keepalive_in_primary'] = (await get()) === 200 && (await get()) === 200;
  agent.destroy();

  // 6. A first frame sent before the 101 is read is not lost by the handoff.
  checks['early_frame_same_write'] = await earlyFrame(port, crypto.randomUUID(), true);
  checks['early_frame_during_hook'] = await earlyFrame(port, crypto.randomUUID(), false);

  // 7. Load: CALLS calls, both legs, 50 frames a second each way.
  const legs: Array<{ st: WebSocket; ps: WebSocket }> = [];
  for (let i = 0; i < CALLS; i++) {
    const cid = crypto.randomUUID();
    const a = await openWs(`${base}/proxy/agency/station/${cid}?token=t&media=alaw8`);
    const b = await openWs(`${base}/api/v1/webrtc-call/${cid}/pstn-stream?token=p`);
    legs.push({ st: a.ws, ps: b.ws });
  }
  let received = 0;
  for (const l of legs) { l.st.on('message', () => { received++; }); l.ps.on('message', () => { received++; }); }
  process.send!({ kind: 'load-start' });
  const alaw = Buffer.alloc(160, 0x55);
  const carrierFrame = JSON.stringify({ event: 'media', media: { payload: alaw.toString('base64') } });
  const groups = 10;
  const timers: NodeJS.Timeout[] = [];
  for (let g = 0; g < groups; g++) {
    timers.push(setTimeout(() => timers.push(setInterval(() => {
      for (let i = g; i < legs.length; i += groups) {
        const l = legs[i]!;
        if (l.st.readyState === WebSocket.OPEN) l.st.send(alaw, { binary: true });
        if (l.ps.readyState === WebSocket.OPEN) l.ps.send(carrierFrame);
      }
    }, 20)), g * 2));
  }
  const startedAt = Date.now();
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  for (const t of timers) clearInterval(t);
  const secs = (Date.now() - startedAt) / 1000;
  process.send!({ kind: 'load-end' });
  for (const l of legs) { l.st.close(); l.ps.close(); }
  process.send!({ kind: 'result', checks, load: { framesDeliveredPerS: Math.round(received / secs), expectedPerS: CALLS * 100 } });
}

// ─── entry ──────────────────────────────────────────────────────────────────

if (role === 'worker') {
  void runWorker(Number(process.argv[3]));
} else if (role === 'client') {
  void runClient(Number(process.argv[3])).catch((err) => { console.error(err); process.exit(1); });
} else {
  void runPrimary().catch((err) => { console.error(err); process.exit(1); });
}
