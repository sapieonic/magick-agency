/**
 * The primary's half of the upgrade handoff (`docs/scaling.md` §2.1). Registered by
 * `buildApp({ wsTransport: 'handoff' })` in place of `@fastify/websocket`:
 *
 *  1. On `upgrade`, stop the socket's reads at once (`socket-pause.ts`) so nothing the
 *     client sends is read into this process, then route the request through Fastify
 *     with a `ServerResponse` bound to the socket, as `@fastify/websocket` does. Every
 *     app hook runs: the client log context and the rate limiter, which charges the
 *     `station` / `carrier_media` bucket here and only here. A 429 or 404 is written to
 *     the raw socket as an HTTP answer, before any handoff.
 *  2. Every `websocket: true` route must declare `config.wsOwner` (refused at
 *     registration otherwise). Its handler is replaced: an upgrade is hijacked, the owner
 *     slot is resolved, and the request line, raw headers and `head` are sent with the
 *     socket handle to that worker, which completes the handshake (`ws-adopt.ts`). A
 *     plain GET on the route is 404, as with `@fastify/websocket`.
 *  3. No owner available (the slot is down or restarting, or the hint names no slot):
 *     HTTP 503 with `retry-after`, never a silent drop. The station token is never read
 *     here, so it is spent once, by the worker that keeps the socket.
 */
import http from 'node:http';
import type net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { trackWsHandoff } from '@magick-agency/observability/metrics/voice';
import { IPC_PROTOCOL_VERSION, type WsHandoff } from './ipc-protocol.js';
import { detachFromServer, stopSocketReads } from './socket-pause.js';

const log = createChildLogger({ component: 'ws-handoff' });

/** Which worker owns a WebSocket route's upgrade. */
export interface WsOwnerConfig {
  /** `session`: the path param is an agent session id; `carrier_hint`: the `w` query names the slot. */
  by: 'session' | 'carrier_hint';
  /** The path param that keys the owner (`sessionId`, `id`). */
  param: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** `docs/scaling.md` §2.1: which media worker an upgrade on this route is handed to. */
    wsOwner?: WsOwnerConfig;
  }
}

export interface WsHandoffTarget {
  /** The ready slot that owns this upgrade, or null (answered 503). */
  slotFor(owner: WsOwnerConfig, params: Record<string, string | undefined>, query: Record<string, unknown>): number | null;
  /** Send the socket. False when it could not be sent (the socket is then destroyed). */
  handoff(slot: number, msg: WsHandoff, socket: net.Socket): boolean;
}

export interface WsHandoffOptions {
  /** Resolved per upgrade: the cluster layer installs it after `buildApp`, before `listen`. */
  target: () => WsHandoffTarget | null;
}

const kSocket = Symbol('ws-handoff-socket');
const kHead = Symbol('ws-handoff-head');
const kHandedOff = Symbol('ws-handoff-done');
type UpgradeRequest = http.IncomingMessage & { [kSocket]?: net.Socket; [kHead]?: Buffer; [kHandedOff]?: boolean };

/** An HTTP answer on a raw upgrade socket that will never be a WebSocket. */
function refuse(socket: net.Socket, status: 503, retryAfterSeconds: number): void {
  if (socket.destroyed) return;
  // Destroyed once written: a client need not close its side of a refused upgrade, and a
  // half-closed socket would hold the server's close() open.
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nRetry-After: ${retryAfterSeconds}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
}

let warnedNoReadStop = false;

export function registerWsHandoff(app: FastifyInstance, opts: WsHandoffOptions): void {
  app.server.on('upgrade', (req: UpgradeRequest, socket: net.Socket, head: Buffer) => {
    // First, synchronously: nothing the client sends next may be read into this process.
    if (!stopSocketReads(socket)) {
      // The boot probe makes this unreachable (no media workers without the internal);
      // kept so a socket is refused rather than half-handed if it ever is reached.
      if (!warnedNoReadStop) {
        warnedNoReadStop = true;
        log.warn('Cannot stop a socket reading on this Node — refusing WebSocket upgrades instead of handing them off');
      }
      trackWsHandoff('unknown', 'unsupported');
      refuse(socket, 503, 2);
      return;
    }
    socket.on('error', () => socket.destroy());
    req[kSocket] = socket;
    req[kHead] = head;
    const res = new http.ServerResponse(req);
    res.assignSocket(socket);
    try {
      (app as unknown as { routing(req: http.IncomingMessage, res: http.ServerResponse): void }).routing(req, res);
    } catch (err) {
      log.warn({ err }, 'WebSocket upgrade routing failed');
      socket.destroy();
    }
  });

  // An upgrade that got an HTTP answer (429, 404, 503) is finished: close its connection.
  app.addHook('onResponse', async (request) => {
    const raw = request.raw as UpgradeRequest;
    if (raw[kSocket] && !raw[kHandedOff]) raw[kSocket].destroy();
  });

  app.addHook('onRoute', (route) => {
    const r = route as typeof route & { websocket?: boolean };
    if (!r.websocket) return;
    const owner = route.config?.wsOwner;
    if (!owner) {
      throw new Error(`WebSocket route ${route.url} has no config.wsOwner: say which media worker owns its upgrades (docs/scaling.md §2.1)`);
    }
    route.handler = function handoffHandler(request: FastifyRequest, reply: FastifyReply) {
      const raw = request.raw as UpgradeRequest;
      const socket = raw[kSocket];
      if (!socket) return reply.code(404).send();
      reply.hijack();
      const target = opts.target();
      const slot = target?.slotFor(
        owner,
        (request.params ?? {}) as Record<string, string | undefined>,
        (request.query ?? {}) as Record<string, unknown>,
      ) ?? null;
      const route = owner.by === 'session' ? 'station' : 'pstn';
      if (!target || slot === null) {
        trackWsHandoff(route, 'no_owner');
        refuse(socket, 503, 2);
        return;
      }
      if (socket.readableLength > 0) {
        // Should be unreachable with reads stopped at the upgrade: refuse rather than
        // hand off a socket whose bytes would stay behind.
        log.warn({ url: request.url, buffered: socket.readableLength }, 'Upgrade socket has bytes buffered in the primary — refusing');
        trackWsHandoff(route, 'buffered');
        refuse(socket, 503, 1);
        return;
      }
      const msg: WsHandoff = {
        v: IPC_PROTOCOL_VERSION,
        kind: 'handoff',
        route,
        method: 'GET',
        url: raw.url ?? request.url,
        httpVersion: raw.httpVersion,
        rawHeaders: raw.rawHeaders,
        head: (raw[kHead] ?? Buffer.alloc(0)).toString('base64'),
        requestId: String(request.id),
      };
      if (!detachFromServer(socket)) {
        trackWsHandoff(route, 'unsupported');
        refuse(socket, 503, 2);
        return;
      }
      raw[kHandedOff] = true;
      if (!target.handoff(slot, msg, socket)) {
        log.warn({ slot, url: request.url }, 'Upgrade handoff could not be sent — closing the socket');
        trackWsHandoff(route, 'not_sent');
        socket.destroy();
        return;
      }
      trackWsHandoff(route, 'handed_off');
    };
  });
}
