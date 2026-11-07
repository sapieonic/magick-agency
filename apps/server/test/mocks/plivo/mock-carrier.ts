/**
 * A scriptable mock of Plivo, for end-to-end tests of calls on a tenant's own Plivo
 * account (B18). Node-native, in-process, on `node:http` and `ws`, like the VoiceLink one
 * (`test/mocks/voicelink/mock-carrier.ts`, which says why not WireMock: the carrier is a
 * CLIENT of ours for the callbacks and the media socket).
 *
 * ── What it serves (Plivo's paths, Basic auth `auth_id:auth_token`) ────────────
 *  - `GET  /v1/Account/{id}/`                    the credential check: 200
 *  - `GET  /v1/Account/{id}/Number/?limit&offset` the number sync: one page of `numbers`
 *  - `POST /v1/Account/{id}/Call/`               201 `{message, request_uuid, api_id}`, and
 *    the call is placed: a {@link PlivoCall} runs the script `scriptFor` chooses
 *  - `DELETE /v1/Account/{id}/Request/{uuid}/`   204 while the dial has not been answered,
 *    404 otherwise; Plivo then posts the `cancel` hangup callback
 *  - `DELETE /v1/Account/{id}/Call/{uuid}/`      204 for a live call it has named, 404
 *    otherwise; the stream is closed and the `completed` hangup callback posted
 * A wrong auth id or token is 401. Every request is recorded (route, auth, body, the status
 * it was answered with, the fault applied).
 *
 * ── Faults ───────────────────────────────────────────────────────────────────
 * Per route: any status (401, 403, 429, 5xx), `hang` (never answers: the adapter's own
 * timeout fires), `malformed` (2xx with an unreadable body), `reset`, `latency`.
 *
 * ── Pointing the server at it ────────────────────────────────────────────────
 * Plivo's REST host is fixed in the server (`PLIVO_API_BASE`) and not configurable.
 * {@link MockPlivoCarrier.fetch} is a `PlivoFetch` that accepts ONLY URLs on that host and
 * sends them to this server's loopback port instead: a test installs it with
 * `setPlivoTransportForTests` (the adapters the registry builds) and hands it to the
 * credential service it builds (the check and the number sync). A request to any other
 * host is refused and recorded in `offHost`. The call side is as VoiceLink's: the public
 * `https://agency.test/…` and `wss://…` URLs the bridge built are rewritten by
 * `targetOrigin` to the listening app.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import { PLIVO_API_BASE } from '../../../src/telephony/credentials/credential-specs.js';
import { PlivoCall, type PlivoCallScript, type PlivoDialRequest } from './carrier-call.js';

export type PlivoRoute = 'account' | 'numbers' | 'create_call' | 'cancel_request' | 'hangup_call' | 'unknown';

export type PlivoFault =
  | { kind: 'latency'; ms: number }
  | { kind: 'status'; status: number; body?: string }
  /** Never answered; the client's timeout aborts it, `stop()` destroys the connection. */
  | { kind: 'hang' }
  /** A 2xx (201 for a create-call) whose body is not JSON. */
  | { kind: 'malformed' }
  /** The TCP connection destroyed with no response. */
  | { kind: 'reset' };

export interface RecordedPlivoRequest {
  seq: number;
  route: PlivoRoute;
  method: string;
  path: string;
  /** The id in the path (`request_uuid` or `call_uuid`) for a DELETE. */
  id: string | null;
  authorized: boolean;
  body: unknown;
  status: number;
  fault: PlivoFault['kind'] | null;
}

export interface PlivoNumberEntry {
  number: string;
  voice_enabled?: boolean;
  alias?: string;
  /** The subaccount a main account transferred the number to (its auth id); null: the account's own. */
  sub_account?: string | null;
}

export interface MockPlivoOptions {
  /** `MA` + 18 upper-case alphanumerics. */
  authId?: string;
  /** 16–128 of `[A-Za-z0-9_-]`. */
  authToken?: string;
  targetOrigin?: string | (() => string | null);
  scriptFor?: (dial: PlivoDialRequest, ctx: { index: number; callId: string }) => PlivoCallScript | null;
  /** The account's numbers, digits with country code as Plivo lists them. */
  numbers?: PlivoNumberEntry[];
  /** Post the hangup callback on a REST cancel or hangup, as Plivo does (default true). */
  hangupCallbackOnApi?: boolean;
}

interface FaultRule { route: PlivoRoute; fault: PlivoFault; remaining: number }

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ID = '[A-Za-z0-9-]+';

function routeOf(method: string, path: string, authId: string): { route: PlivoRoute; id: string | null } {
  const prefix = `/v1/Account/${authId}/`;
  if (!path.startsWith(prefix)) return { route: 'unknown', id: null };
  const rest = path.slice(prefix.length);
  if (method === 'GET' && rest === '') return { route: 'account', id: null };
  if (method === 'GET' && rest === 'Number/') return { route: 'numbers', id: null };
  if (method === 'POST' && rest === 'Call/') return { route: 'create_call', id: null };
  let m = new RegExp(`^Request/(${ID})/$`).exec(rest);
  if (method === 'DELETE' && m) return { route: 'cancel_request', id: m[1]! };
  m = new RegExp(`^Call/(${ID})/$`).exec(rest);
  if (method === 'DELETE' && m) return { route: 'hangup_call', id: m[1]! };
  return { route: 'unknown', id: null };
}

const DIGITS = /^[1-9]\d{6,14}$/;

export class MockPlivoCarrier {
  readonly authId: string;
  /** The account's auth token NOW. {@link rotateAuthToken} changes it. */
  authToken: string;
  readonly requests: RecordedPlivoRequest[] = [];
  /** Requests the transport refused because they were not for Plivo's fixed host. */
  readonly offHost: string[] = [];
  /** Every call placed, by OUR call id (from the answer URL). */
  readonly calls = new Map<string, PlivoCall>();
  readonly callOrder: PlivoCall[] = [];
  numbers: PlivoNumberEntry[];

  private server: http.Server | null = null;
  private port = 0;
  private readonly httpSockets = new Set<Socket>();
  private readonly mediaSockets = new Set<WebSocket>();
  private readonly faults: FaultRule[] = [];
  private readonly runs: Promise<unknown>[] = [];
  private reqSeq = 0;
  private scriptFor: MockPlivoOptions['scriptFor'];
  private readonly opts: MockPlivoOptions;
  private stopped = false;

  constructor(opts: MockPlivoOptions = {}) {
    this.opts = opts;
    this.authId = opts.authId ?? 'MAMOCKPLIVO000000001';
    this.authToken = opts.authToken ?? 'mockPlivoAuthToken-0001';
    this.scriptFor = opts.scriptFor;
    this.numbers = opts.numbers ?? [];
  }

  async start(): Promise<void> {
    const server = http.createServer((req, res) => { void this.handle(req, res); });
    server.on('connection', (socket) => {
      this.httpSockets.add(socket);
      socket.on('close', () => this.httpSockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
  }

  /**
   * The transport: only `PLIVO_API_BASE` URLs, sent to this server. The Basic auth, method,
   * body, `redirect` and timeout signal pass through unchanged.
   */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    if (!url.startsWith(`${PLIVO_API_BASE}/`)) {
      this.offHost.push(url);
      throw new Error('mock Plivo: refused a request that is not for Plivo\'s API host');
    }
    return fetch(`http://127.0.0.1:${this.port}${url.slice(PLIVO_API_BASE.length)}`, init);
  };

  setScript(scriptFor: MockPlivoOptions['scriptFor']): void {
    this.scriptFor = scriptFor;
  }

  /** Apply `fault` to the next `times` requests on `route`. */
  injectFault(route: PlivoRoute, fault: PlivoFault, times = 1): void {
    this.faults.push({ route, fault, remaining: times });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  /** The account's token changes (the tenant rotated it at Plivo): the old one is refused from now on. */
  rotateAuthToken(next: string): void {
    this.authToken = next;
  }

  requestsTo(route: PlivoRoute): RecordedPlivoRequest[] {
    return this.requests.filter((r) => r.route === route);
  }

  openSocketCount(): { media: number; http: number } {
    return { media: this.mediaSockets.size, http: this.httpSockets.size };
  }

  async settled(): Promise<void> {
    let n = -1;
    while (n !== this.runs.length) {
      n = this.runs.length;
      await Promise.all(this.runs);
    }
  }

  async waitForCalls(n: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.callOrder.length < n) {
      if (Date.now() > deadline) throw new Error(`mock Plivo: ${this.callOrder.length}/${n} calls placed before the deadline`);
      await sleep(10);
    }
  }

  reset(): void {
    this.requests.length = 0;
    this.offHost.length = 0;
    this.calls.clear();
    this.callOrder.length = 0;
    this.runs.length = 0;
    this.faults.length = 0;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const ws of this.mediaSockets) ws.terminate();
    this.mediaSockets.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    for (const s of this.httpSockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  rewrite(url: string): string {
    const target = typeof this.opts.targetOrigin === 'function' ? this.opts.targetOrigin() : this.opts.targetOrigin;
    if (!target) return url;
    const u = new URL(url);
    const t = new URL(target);
    const ws = u.protocol === 'wss:' || u.protocol === 'ws:';
    return `${ws ? 'ws' : 'http'}://${t.host}${u.pathname}${u.search}`;
  }

  // ── Request handling ──────────────────────────────────────────────────────

  private takeFault(route: PlivoRoute): PlivoFault | null {
    const i = this.faults.findIndex((f) => f.route === route && f.remaining > 0);
    if (i < 0) return null;
    const rule = this.faults[i]!;
    rule.remaining -= 1;
    if (rule.remaining <= 0) this.faults.splice(i, 1);
    return rule.fault;
  }

  private authorized(header: string | undefined): boolean {
    const m = /^Basic (.+)$/.exec(header ?? '');
    if (!m) return false;
    return Buffer.from(m[1]!, 'base64').toString('utf8') === `${this.authId}:${this.authToken}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://plivo.local');
    const method = req.method ?? 'GET';
    const { route, id } = routeOf(method, url.pathname, this.authId);
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const record: RecordedPlivoRequest = {
      seq: ++this.reqSeq, route, method, path: url.pathname, id,
      authorized: this.authorized(req.headers['authorization']), body, status: 0, fault: null,
    };
    this.requests.push(record);
    const send = (status: number, payload: unknown, rawBody = false): void => {
      record.status = status;
      if (res.writableEnded || res.destroyed) return;
      if (status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(rawBody ? String(payload) : JSON.stringify(payload));
    };

    let fault = this.takeFault(route);
    while (fault?.kind === 'latency') {
      record.fault = 'latency';
      await sleep(fault.ms);
      fault = this.takeFault(route);
    }
    if (fault) record.fault = fault.kind;
    switch (fault?.kind) {
      case 'status':
        send(fault.status, fault.body ?? JSON.stringify({ api_id: randomUUID(), error: `injected ${fault.status}` }), true);
        return;
      case 'hang':
        return;
      case 'malformed':
        send(route === 'create_call' ? 201 : 200, '<html>502 Bad Gateway</html>{"request_uuid":', true);
        return;
      case 'reset':
        req.socket.destroy();
        return;
      default:
        break;
    }

    if (route === 'unknown') {
      send(404, { api_id: randomUUID(), error: 'not found' });
      return;
    }
    if (!record.authorized) {
      send(401, { api_id: randomUUID(), error: 'Authentication credentials invalid' });
      return;
    }
    switch (route) {
      case 'account':
        send(200, { api_id: randomUUID(), account_type: 'standard', auth_id: this.authId, name: 'Mock account', resource_uri: `/v1/Account/${this.authId}/` });
        return;
      case 'numbers':
        this.handleNumbers(url, send);
        return;
      case 'create_call':
        this.handleCreateCall(body, send);
        return;
      case 'cancel_request':
        this.handleCancel(id!, send);
        return;
      case 'hangup_call':
        this.handleHangup(id!, send);
        return;
    }
  }

  private handleNumbers(url: URL, send: (s: number, p: unknown) => void): void {
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const page = this.numbers.slice(offset, offset + limit);
    const more = offset + limit < this.numbers.length;
    send(200, {
      api_id: randomUUID(),
      meta: { limit, offset, total_count: this.numbers.length, next: more ? `/v1/Account/${this.authId}/Number/?limit=${limit}&offset=${offset + limit}` : null, previous: null },
      objects: page.map((n) => ({
        number: n.number, voice_enabled: n.voice_enabled ?? true, alias: n.alias ?? null, country: 'United States',
        sub_account: n.sub_account ?? null,
      })),
    });
  }

  private dialProblems(d: Partial<PlivoDialRequest>): string[] {
    const out: string[] = [];
    if (!d.from || !DIGITS.test(d.from)) out.push('from must be digits with the country code');
    if (!d.to || !DIGITS.test(d.to)) out.push('to must be digits with the country code');
    for (const k of ['answer_url', 'hangup_url'] as const) {
      if (!d[k] || !/^https:\/\//.test(d[k]!)) out.push(`${k} must be https`);
    }
    if (d.answer_method !== 'POST') out.push('answer_method must be POST');
    if (typeof d.time_limit !== 'number' || d.time_limit < 1) out.push('time_limit must be a positive number');
    return out;
  }

  private handleCreateCall(body: unknown, send: (s: number, p: unknown) => void): void {
    const dial = (body ?? {}) as Partial<PlivoDialRequest>;
    const problems = this.dialProblems(dial);
    if (problems.length > 0) {
      send(400, { api_id: randomUUID(), error: problems.join('; ') });
      return;
    }
    const requestUuid = randomUUID();
    if (!this.stopped) {
      const call = new PlivoCall({
        request: dial as PlivoDialRequest,
        requestUuid,
        authId: this.authId,
        authToken: () => this.authToken,
        rewrite: (u) => this.rewrite(u),
        sockets: this.mediaSockets,
      });
      this.calls.set(call.callId, call);
      this.callOrder.push(call);
      const script = this.scriptFor?.(call.request, { index: this.callOrder.length - 1, callId: call.callId }) ?? null;
      // The response first, then the call (Plivo answers the create-call before it rings).
      if (script) setImmediate(() => this.runs.push(call.run(script)));
    }
    send(201, { api_id: randomUUID(), message: 'call fired', request_uuid: requestUuid });
  }

  private handleCancel(requestUuid: string, send: (s: number, p: unknown) => void): void {
    const call = this.callOrder.find((c) => c.requestUuid === requestUuid);
    if (!call || call.answered || call.ended) {
      send(404, { api_id: randomUUID(), error: 'not found' });
      return;
    }
    call.canceledByApi = true;
    call.ended = true;
    send(204, null);
    if (this.opts.hangupCallbackOnApi !== false) this.runs.push(call.postHangup('cancel', { source: 'API Request' }));
  }

  private handleHangup(callUuid: string, send: (s: number, p: unknown) => void): void {
    const call = this.callOrder.find((c) => c.callUuid === callUuid && c.named);
    if (!call || call.ended) {
      send(404, { api_id: randomUUID(), error: 'not found' });
      return;
    }
    call.hungUpByApi = true;
    call.ended = true;
    send(204, null);
    call.closeMedia();
    if (this.opts.hangupCallbackOnApi !== false) this.runs.push(call.postHangup('completed', { source: 'API Request' }));
  }
}
