/**
 * One end of the primary ↔ child channel (`docs/scaling.md` §4.4): typed events, and
 * requests correlated by id with a deadline each, over Node's `child_process` IPC.
 *
 *  - **Every incoming message is decoded** (`ipc-protocol.ts`) before a handler sees it.
 *    A bad event is dropped and counted; a bad request is answered `malformed`, a request
 *    with no handler `unsupported`, so the sender learns at once instead of timing out.
 *  - **Requests have deadlines.** Past it the caller's promise rejects `timeout`; a late
 *    answer is dropped and counted. A timeout says nothing about whether the receiver
 *    acted: callers that must not double-act (a dial) treat it as "outcome unknown".
 *  - **A closed channel fails everything outstanding with `gone`**, and refuses new
 *    requests with `refused`, so nothing waits on a process that has exited.
 *  - **Bounded.** At most `maxInFlight` requests may be outstanding; past it a request is
 *    refused, not queued. A `false` from the transport's `send` (Node's backlog threshold)
 *    is counted; the message is still queued by Node, never dropped here.
 */
import type { ChildProcess } from 'node:child_process';
import { createChildLogger } from '@magick-agency/observability';
import {
  IPC_DEFAULT_DEADLINES_MS,
  IPC_EVENT_DECODERS,
  IPC_PROTOCOL_VERSION,
  IPC_REQUEST_DECODERS,
  parseWsHandoff,
  isIpcEventType,
  isIpcRequestType,
  parseIpcEnvelope,
  type IpcErrorCode,
  type IpcEventMap,
  type IpcEventType,
  type IpcRequestEnvelope,
  type IpcRequestMap,
  type IpcRequestType,
  type IpcResponseEnvelope,
  type WsHandoff,
} from './ipc-protocol.js';

const log = createChildLogger({ component: 'ipc-channel' });

/** What the channel needs from Node's IPC: send, receive, and hear the close. */
export interface IpcTransport {
  /** Queue a message. False means Node's backlog threshold is passed (still queued) or the channel is closed. */
  send(message: unknown): boolean;
  /**
   * Send a message with a socket handle (the upgrade handoff). The sender's copy of the
   * socket is closed once it has gone. False when it could not be sent. Absent on a
   * transport that cannot carry handles (the in-memory test pair).
   */
  sendHandle?(message: unknown, handle: unknown): boolean;
  /** `handle` is the socket that came with the message, when one did. */
  onMessage(handler: (message: unknown, handle?: unknown) => void): () => void;
  onClose(handler: () => void): () => void;
  readonly connected: boolean;
}

/** The primary's end of a forked child's channel. */
export function childProcessTransport(child: ChildProcess): IpcTransport {
  return {
    send: (message) => {
      if (!child.connected) return false;
      // With a callback, a send on a channel that closes under it reports here rather
      // than as an unhandled 'error' on the child object.
      return child.send(message as never, (err) => {
        if (err) log.debug({ err, pid: child.pid }, 'IPC send to child failed');
      });
    },
    sendHandle: (message, handle) => {
      if (!child.connected) return false;
      try {
        child.send(message as never, handle as never, (err) => {
          if (err) log.warn({ err, pid: child.pid }, 'IPC handoff to child failed');
          // Sent or not, this process is done with the socket. Node closes the parent's
          // handle after a send but never destroys the JS socket, so the HTTP server
          // would count the connection forever and `server.close()` (shutdown's first
          // step) would never return. Its handle is already detached: destroying the
          // object closes nothing the worker holds.
          (handle as { destroy?: () => void }).destroy?.();
        });
        return true;
      } catch (err) {
        log.warn({ err, pid: child.pid }, 'IPC handoff to child threw');
        return false;
      }
    },
    onMessage: (handler) => {
      const listener = (m: unknown, h?: unknown): void => handler(m, h);
      child.on('message', listener);
      return () => { child.off('message', listener); };
    },
    onClose: (handler) => {
      child.once('disconnect', handler);
      return () => { child.off('disconnect', handler); };
    },
    get connected() { return child.connected; },
  };
}

/** A child's end of the channel to its parent. */
export function parentTransport(proc: NodeJS.Process = process): IpcTransport {
  return {
    send: (message) => {
      if (!proc.send || !proc.connected) return false;
      return proc.send(message, undefined, undefined, (err: Error | null) => {
        if (err) log.debug({ err }, 'IPC send to parent failed');
      });
    },
    onMessage: (handler) => {
      const listener = (m: unknown, h?: unknown): void => handler(m, h);
      proc.on('message', listener);
      return () => { proc.off('message', listener); };
    },
    onClose: (handler) => {
      proc.once('disconnect', handler);
      return () => { proc.off('disconnect', handler); };
    },
    get connected() { return proc.connected === true; },
  };
}

export class IpcRequestError extends Error {
  constructor(readonly code: IpcErrorCode, readonly type: string, message: string) {
    super(`${type}: ${code}: ${message}`);
    this.name = 'IpcRequestError';
  }
}

export interface IpcChannelOptions {
  /** For log lines: whose end this is (`primary→analysis0`, `analysis0→primary`). */
  name: string;
  /** Outstanding requests allowed before new ones are refused. */
  maxInFlight?: number;
}

export interface IpcChannelStats {
  sent: number;
  received: number;
  inFlight: number;
  /** Sends Node reported over its backlog threshold. */
  backlogged: number;
  /** Incoming messages that did not decode (envelope or body). */
  malformed: number;
  /** Incoming event or request types this end does not know or has no handler for. */
  unsupported: number;
  /** Responses that arrived after their request had timed out or was never sent. */
  late: number;
}

interface Pending {
  type: IpcRequestType;
  resolve: (body: unknown) => void;
  reject: (err: IpcRequestError) => void;
  timer: NodeJS.Timeout;
}

type EventHandler<K extends IpcEventType> = (body: IpcEventMap[K]) => void;
type RequestHandler<K extends IpcRequestType> = (body: IpcRequestMap[K]['req']) =>
  IpcRequestMap[K]['res'] | Promise<IpcRequestMap[K]['res']>;

export const DEFAULT_IPC_MAX_IN_FLIGHT = 256;
/** At most one malformed-message warning per type per this window. */
const MALFORMED_LOG_WINDOW_MS = 60_000;

export class IpcChannel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly eventHandlers = new Map<string, Set<(body: unknown) => void>>();
  private readonly requestHandlers = new Map<string, (body: unknown) => unknown>();
  private readonly maxInFlight: number;
  private closed = false;
  private readonly lastMalformedLogAt = new Map<string, number>();
  private readonly counters: Omit<IpcChannelStats, 'inFlight'> = {
    sent: 0, received: 0, backlogged: 0, malformed: 0, unsupported: 0, late: 0,
  };
  private readonly unsubscribe: Array<() => void> = [];
  private readonly closeListeners = new Set<() => void>();
  private handoffHandler: ((msg: WsHandoff, handle: unknown) => void) | null = null;

  constructor(private readonly transport: IpcTransport, private readonly opts: IpcChannelOptions) {
    this.maxInFlight = opts.maxInFlight ?? DEFAULT_IPC_MAX_IN_FLIGHT;
    this.unsubscribe.push(transport.onMessage((m, h) => this.receive(m, h)));
    this.unsubscribe.push(transport.onClose(() => this.close()));
    if (!transport.connected) this.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  stats(): IpcChannelStats {
    return { ...this.counters, inFlight: this.pending.size };
  }

  /** Be told once when the channel closes (the other process exited or disconnected). */
  onClose(listener: () => void): () => void {
    if (this.closed) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  /**
   * Hand an upgraded socket to the other process (`docs/scaling.md` §2.2). False when it
   * could not be sent (closed channel, or a transport without handles); the caller then
   * still owns the socket.
   */
  sendHandoff(msg: WsHandoff, socket: unknown): boolean {
    if (this.closed || !this.transport.sendHandle) return false;
    this.counters.sent++;
    return this.transport.sendHandle(msg, socket);
  }

  /** Receive handed-off sockets. One handler; a handoff with no handler or no socket is closed. */
  onHandoff(handler: (msg: WsHandoff, socket: unknown) => void): void {
    this.handoffHandler = handler;
  }

  /** Fire and forget. False when the channel is closed (nothing was sent). */
  emit<K extends IpcEventType>(type: K, body: IpcEventMap[K]): boolean {
    if (this.closed) return false;
    this.write({ v: IPC_PROTOCOL_VERSION, kind: 'event', type, body });
    return true;
  }

  /**
   * Send a request and wait for its answer. Rejects with {@link IpcRequestError}:
   * `refused` (closed, or `maxInFlight` reached), `timeout`, `gone`, `malformed`, or the
   * receiver's `unsupported` / `malformed` / `handler_error`.
   */
  request<K extends IpcRequestType>(
    type: K,
    body: IpcRequestMap[K]['req'],
    opts: { deadlineMs?: number } = {},
  ): Promise<IpcRequestMap[K]['res']> {
    if (this.closed) return Promise.reject(new IpcRequestError('refused', type, 'channel closed'));
    if (this.pending.size >= this.maxInFlight) {
      return Promise.reject(new IpcRequestError('refused', type, `${this.maxInFlight} requests already in flight`));
    }
    const deadlineMs = opts.deadlineMs ?? IPC_DEFAULT_DEADLINES_MS[type];
    const id = this.nextId++;
    return new Promise<IpcRequestMap[K]['res']>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new IpcRequestError('timeout', type, `no answer within ${deadlineMs} ms`));
      }, deadlineMs);
      timer.unref?.();
      this.pending.set(id, { type, resolve: resolve as (b: unknown) => void, reject, timer });
      this.write({ v: IPC_PROTOCOL_VERSION, kind: 'req', id, type, body, deadlineMs });
    });
  }

  /** Handle every event of `type`. Returns the unsubscribe. */
  onEvent<K extends IpcEventType>(type: K, handler: EventHandler<K>): () => void {
    let set = this.eventHandlers.get(type);
    if (!set) {
      set = new Set();
      this.eventHandlers.set(type, set);
    }
    const h = handler as (body: unknown) => void;
    set.add(h);
    return () => { set.delete(h); };
  }

  /** Answer every request of `type`. One handler per type; a second registration replaces the first. */
  handle<K extends IpcRequestType>(type: K, handler: RequestHandler<K>): () => void {
    const h = handler as (body: unknown) => unknown;
    this.requestHandlers.set(type, h);
    return () => { if (this.requestHandlers.get(type) === h) this.requestHandlers.delete(type); };
  }

  /** Stop listening and fail everything outstanding with `gone`. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const off of this.unsubscribe.splice(0)) off();
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new IpcRequestError('gone', p.type, 'channel closed'));
      this.pending.delete(id);
    }
    for (const listener of [...this.closeListeners]) {
      try { listener(); } catch (err) { log.warn({ err, channel: this.opts.name }, 'IPC close listener threw'); }
    }
    this.closeListeners.clear();
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private write(envelope: unknown): void {
    this.counters.sent++;
    if (!this.transport.send(envelope)) this.counters.backlogged++;
  }

  private receive(raw: unknown, handle?: unknown): void {
    if (this.closed) {
      (handle as { destroy?: () => void } | undefined)?.destroy?.();
      return;
    }
    this.counters.received++;
    if ((raw as { kind?: unknown } | null)?.kind === 'handoff') {
      const msg = parseWsHandoff(raw);
      if (!msg || !handle || !this.handoffHandler) {
        this.noteMalformed('handoff', raw, msg ? 'no socket or no handler' : 'did not decode');
        (handle as { destroy?: () => void } | undefined)?.destroy?.();
        return;
      }
      try {
        this.handoffHandler(msg, handle);
      } catch (err) {
        log.error({ err, channel: this.opts.name }, 'IPC handoff handler threw');
        (handle as { destroy?: () => void }).destroy?.();
      }
      return;
    }
    const env = parseIpcEnvelope(raw);
    if (!env) {
      this.noteMalformed('envelope', raw);
      return;
    }
    switch (env.kind) {
      case 'event': return this.receiveEvent(env.type, env.body);
      case 'req': return void this.receiveRequest(env);
      case 'res': return this.receiveResponse(env);
    }
  }

  private receiveEvent(type: string, rawBody: unknown): void {
    if (!isIpcEventType(type)) {
      this.counters.unsupported++;
      this.noteMalformed(`event:${type}`, rawBody, 'unknown event type');
      return;
    }
    const body = (IPC_EVENT_DECODERS[type] as (r: unknown) => unknown)(rawBody);
    if (body === null) {
      this.noteMalformed(`event:${type}`, rawBody);
      return;
    }
    const handlers = this.eventHandlers.get(type);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      try {
        handler(body);
      } catch (err) {
        log.error({ err, channel: this.opts.name, type }, 'IPC event handler threw');
      }
    }
  }

  private async receiveRequest(env: IpcRequestEnvelope): Promise<void> {
    const answer = (res: { ok: true; body: unknown } | { ok: false; error: { code: IpcErrorCode; message: string } }): void => {
      if (this.closed) return;
      this.write({ v: IPC_PROTOCOL_VERSION, kind: 'res', id: env.id, ...res });
    };
    if (!isIpcRequestType(env.type)) {
      this.counters.unsupported++;
      answer({ ok: false, error: { code: 'unsupported', message: `unknown request type ${env.type}` } });
      return;
    }
    const body = (IPC_REQUEST_DECODERS[env.type].req as (r: unknown) => unknown)(env.body);
    if (body === null) {
      this.noteMalformed(`req:${env.type}`, env.body);
      answer({ ok: false, error: { code: 'malformed', message: 'request body did not decode' } });
      return;
    }
    const handler = this.requestHandlers.get(env.type);
    if (!handler) {
      this.counters.unsupported++;
      answer({ ok: false, error: { code: 'unsupported', message: `no handler for ${env.type}` } });
      return;
    }
    try {
      const result = await handler(body);
      answer({ ok: true, body: result });
    } catch (err) {
      log.warn({ err, channel: this.opts.name, type: env.type }, 'IPC request handler threw');
      answer({ ok: false, error: { code: 'handler_error', message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private receiveResponse(env: IpcResponseEnvelope): void {
    const p = this.pending.get(env.id);
    if (!p) {
      this.counters.late++;
      return;
    }
    this.pending.delete(env.id);
    clearTimeout(p.timer);
    if (!env.ok) {
      p.reject(new IpcRequestError(env.error.code, p.type, env.error.message));
      return;
    }
    const body = (IPC_REQUEST_DECODERS[p.type].res as (r: unknown) => unknown)(env.body);
    if (body === null) {
      this.noteMalformed(`res:${p.type}`, env.body);
      p.reject(new IpcRequestError('malformed', p.type, 'response body did not decode'));
      return;
    }
    p.resolve(body);
  }

  private noteMalformed(what: string, raw: unknown, why = 'did not decode'): void {
    if (why === 'did not decode') this.counters.malformed++;
    const now = Date.now();
    const last = this.lastMalformedLogAt.get(what) ?? 0;
    if (now - last < MALFORMED_LOG_WINDOW_MS) return;
    this.lastMalformedLogAt.set(what, now);
    log.warn({ channel: this.opts.name, what, why, sample: typeof raw === 'object' ? '[object]' : String(raw).slice(0, 80) },
      'Dropped an IPC message that did not decode');
  }
}
