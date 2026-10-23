/**
 * A scriptable mock of the VoiceLink carrier, for load, concurrency and fault tests.
 *
 * ── Why Node-native and not WireMock ─────────────────────────────────────────
 * VoiceLink is two things to this server. Its REST API (`/v1/auth/login`,
 * `/v1/add_lead`, `/v1/call-log/details`) is an ordinary HTTP server we call, which any
 * stub server could mock. But the call itself runs the other way round: VoiceLink dials
 * OUT to the `websocket_url` we hand it in `add_lead` — our server is the WebSocket
 * SERVER and the carrier is the CLIENT — and it POSTs lifecycle webhooks to our
 * `webhook_url`. WireMock (including its WebSocket stubs) only mocks servers; it cannot
 * open a client socket to us, pace A-law frames into it, stall reading, destroy the TCP
 * connection, or fire a storm of out-of-order webhooks. So the carrier is built here on
 * `node:http` and `ws` (both already dependencies), in-process, with no new packages.
 *
 * ── What it does ──────────────────────────────────────────────────────────────
 *  - Serves the REST API the adapter (`voicelink.adapter.ts`) and token manager
 *    (`voicelink-token-manager.ts`) call, with the response shapes in `voicelink.types.ts`.
 *    Bearer tokens are issued by `login` and checked on every other route;
 *    {@link MockVoicelinkCarrier.revokeTokens} expires them all (Sanctum expiry).
 *  - Records every request (route, body, auth header, the status it was answered with).
 *  - Takes injectable faults per route: latency, any status (5xx, 429, 4xx), a request
 *    that never answers, a 200 with a non-JSON body, a reset TCP connection, a login with
 *    no token, and a response held until the call's script has run (the carrier dialling
 *    before its own `add_lead` response reaches us).
 *  - On an accepted `add_lead`, places the call the way the carrier does: a
 *    {@link CarrierCall} runs the per-call {@link CallScript} chosen by `scriptFor` —
 *    WebSocket client, `start` frame, paced media, webhooks, closes.
 *
 * ── Pointing the server at it ────────────────────────────────────────────────
 * The REST side: `config()` returns a `VoicelinkConfig` for a directly-built adapter, and
 * a full-stack test sets `config.telephony.voicelink.baseUrl` (the object the provider
 * registry hands the adapter) to {@link MockVoicelinkCarrier.baseUrl}. The call side: the
 * bridge builds `wss://<public host>/…` and `https://<public host>/…` from
 * `VOICELINK_WEBHOOK_BASE_URL`; `targetOrigin` stands in for DNS + TLS termination,
 * rewriting that public origin to the plain `ws://`/`http://` loopback server under test.
 */
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { VoicelinkConfig } from '../../../src/telephony/voicelink/voicelink.types.js';
import { CarrierCall, type CallScript, type LeadRequest } from './carrier-call.js';

export type CarrierRoute = 'login' | 'add_lead' | 'cdr' | 'unknown';

export type CarrierFault =
  /** Wait, then answer normally (or with the next fault's behaviour if `then` is set). */
  | { kind: 'latency'; ms: number }
  /** Answer with this status and body (5xx, 429, 400, 401 …). */
  | { kind: 'status'; status: number; body?: string; headers?: Record<string, string> }
  /** Never answer; the connection is destroyed when the carrier stops. */
  | { kind: 'hang' }
  /** 200 with a body that is not JSON. */
  | { kind: 'malformed' }
  /** Destroy the TCP connection without a response (a network error at the client). */
  | { kind: 'reset' }
  /** Login only: 200 with no `data.access_token`. */
  | { kind: 'no_token' }
  /** Answer normally once `gate` resolves (a test-controlled hold). */
  | { kind: 'hold'; gate: Promise<void> }
  /** add_lead only: place the call and run its WHOLE script before answering. */
  | { kind: 'respond_after_script' };

export interface RecordedRequest {
  seq: number;
  route: CarrierRoute;
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
  rawBody: string;
  receivedAt: number;
  /** The status the carrier answered with (0 = no answer: hang/reset). */
  status: number;
  /** The fault applied, if any. */
  fault: CarrierFault['kind'] | null;
}

export interface MockCarrierOptions {
  username?: string;
  password?: string;
  /**
   * The origin of the server under test (`http://127.0.0.1:<port>`). The public
   * `wss://`/`https://` origin in the lead's URLs is rewritten to it. A function, because
   * the server usually starts after the carrier. Unset: URLs are dialled as given.
   */
  targetOrigin?: string | (() => string | null);
  /** The script for an accepted lead. Unset (or returning null): the lead is accepted and never dialled. */
  scriptFor?: (lead: LeadRequest, ctx: { index: number; callId: string }) => CallScript | null;
  /** Our public host as the bridge sees it, for `config()`'s `webhookBaseUrl`. */
  publicWebhookBase?: string;
}

interface FaultRule {
  route: CarrierRoute;
  fault: CarrierFault;
  remaining: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeOf(method: string, path: string): CarrierRoute {
  if (method === 'POST' && path === '/api/v1/auth/login') return 'login';
  if (method === 'POST' && path === '/api/v1/add_lead') return 'add_lead';
  if (method === 'GET' && path === '/api/v1/call-log/details') return 'cdr';
  return 'unknown';
}

const DIGITS = /^[0-9]+$/;

export class MockVoicelinkCarrier {
  readonly username: string;
  readonly password: string;
  readonly requests: RecordedRequest[] = [];
  /** Every call placed, by OUR call id (parsed from the lead's `websocket_url`). */
  readonly calls = new Map<string, CarrierCall>();
  /** Calls in the order their leads were accepted. */
  readonly callOrder: CarrierCall[] = [];

  private server: http.Server | null = null;
  private port = 0;
  private readonly httpSockets = new Set<Socket>();
  private readonly mediaSockets = new Set<WebSocket>();
  private readonly faults: FaultRule[] = [];
  private readonly validTokens = new Set<string>();
  private tokenSeq = 0;
  private reqSeq = 0;
  private queueSeq = 1000;
  private readonly opts: MockCarrierOptions;
  private scriptFor: MockCarrierOptions['scriptFor'];
  private readonly runs: Promise<void>[] = [];
  private stopped = false;

  constructor(opts: MockCarrierOptions = {}) {
    this.opts = opts;
    this.username = opts.username ?? 'mock-vl-user';
    this.password = opts.password ?? 'mock-vl-password';
    this.scriptFor = opts.scriptFor;
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

  /** VoiceLink's REST base, the shape `VOICELINK_BASE_URL` takes (`…/api`). */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  /** A `VoicelinkConfig` for an adapter built directly against this carrier. */
  config(overrides: Partial<VoicelinkConfig> = {}): VoicelinkConfig {
    return {
      baseUrl: this.baseUrl,
      username: this.username,
      password: this.password,
      webhookBaseUrl: this.opts.publicWebhookBase ?? 'https://agency.test/api/v1/webhooks/voicelink',
      defaultCountryCode: '91',
      ...overrides,
    };
  }

  /** Replace the per-lead script chooser (between tests). */
  setScript(scriptFor: MockCarrierOptions['scriptFor']): void {
    this.scriptFor = scriptFor;
  }

  /** Apply `fault` to the next `times` requests on `route` (Infinity = until cleared). */
  injectFault(route: CarrierRoute, fault: CarrierFault, times = 1): void {
    this.faults.push({ route, fault, remaining: times });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  /** Expire every issued bearer token: the next authenticated call gets a 401. */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  requestsTo(route: CarrierRoute): RecordedRequest[] {
    return this.requests.filter((r) => r.route === route);
  }

  /** Media sockets the carrier still has open, plus HTTP connections still held. */
  openSocketCount(): { media: number; http: number } {
    return { media: this.mediaSockets.size, http: this.httpSockets.size };
  }

  /** Resolves when every call placed so far has finished its script. */
  async settled(): Promise<void> {
    let n = -1;
    // A call can be placed while we wait; loop until the set stops growing.
    while (n !== this.runs.length) {
      n = this.runs.length;
      await Promise.all(this.runs);
    }
  }

  /** Poll until `n` calls have been placed (bounded; a deadlock guard, not a speed check). */
  async waitForCalls(n: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.callOrder.length < n) {
      if (Date.now() > deadline) throw new Error(`mock carrier: ${this.callOrder.length}/${n} calls placed before the deadline`);
      await sleep(10);
    }
  }

  /** Forget recorded traffic and calls (sockets stay as they are). */
  reset(): void {
    this.requests.length = 0;
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
    const secure = u.protocol === 'wss:' || u.protocol === 'ws:';
    return `${secure ? 'ws' : 'http'}://${t.host}${u.pathname}${u.search}`;
  }

  // ── Request handling ────────────────────────────────────────────────────────

  private takeFault(route: CarrierRoute): CarrierFault | null {
    const i = this.faults.findIndex((f) => f.route === route && f.remaining > 0);
    if (i < 0) return null;
    const rule = this.faults[i]!;
    rule.remaining -= 1;
    if (rule.remaining <= 0) this.faults.splice(i, 1);
    return rule.fault;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://carrier.local');
    const route = routeOf(req.method ?? 'GET', url.pathname);
    let body: unknown = null;
    try { body = rawBody ? JSON.parse(rawBody) : null; } catch { body = rawBody; }
    const auth = req.headers['authorization'];
    const record: RecordedRequest = {
      seq: ++this.reqSeq,
      route,
      method: req.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: typeof auth === 'string' ? auth : null,
      body,
      rawBody,
      receivedAt: Date.now(),
      status: 0,
      fault: null,
    };
    this.requests.push(record);

    const send = (status: number, payload: unknown, raw = false, headers: Record<string, string> = {}): void => {
      record.status = status;
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(raw ? String(payload) : JSON.stringify(payload));
    };

    let fault = this.takeFault(route);
    while (fault?.kind === 'latency') {
      record.fault = 'latency';
      await sleep(fault.ms);
      fault = this.takeFault(route);
    }
    if (fault) record.fault = fault.kind;
    if (fault?.kind === 'hold') {
      await fault.gate;
      fault = null;
    }
    switch (fault?.kind) {
      case 'status':
        send(fault.status, fault.body ?? JSON.stringify({ status: false, message: `injected ${fault.status}` }), true, fault.headers);
        return;
      case 'hang':
        return; // never answered; stop() destroys the connection
      case 'malformed':
        send(200, '<html>502 Bad Gateway</html>{"status":', true, { 'content-type': 'application/json' });
        return;
      case 'reset':
        req.socket.destroy();
        return;
      default:
        break;
    }

    switch (route) {
      case 'login':
        this.handleLogin(body, fault?.kind === 'no_token', send);
        return;
      case 'add_lead':
        await this.handleAddLead(record, body, fault?.kind === 'respond_after_script', send);
        return;
      case 'cdr':
        this.handleCdr(record, url, send);
        return;
      default:
        send(404, { message: 'Not Found' });
    }
  }

  private bearerOk(record: RecordedRequest): boolean {
    const m = /^Bearer (.+)$/.exec(record.authorization ?? '');
    return Boolean(m && this.validTokens.has(m[1]!));
  }

  private handleLogin(body: unknown, noToken: boolean, send: (s: number, p: unknown) => void): void {
    const b = (body ?? {}) as { username?: unknown; password?: unknown };
    if (b.username !== this.username || b.password !== this.password) {
      send(401, { status: false, message: 'Invalid credentials' });
      return;
    }
    if (noToken) {
      send(200, { status: true, message: 'Login successful', data: { token_type: 'Bearer' } });
      return;
    }
    const n = ++this.tokenSeq;
    const token = `${n}|mockSanctumToken${randomUUID().replace(/-/g, '')}`;
    this.validTokens.add(token);
    send(200, {
      status: true,
      message: 'Login successful',
      data: { access_token: token, token_type: 'Bearer', user: { id: 1150, plain_api_token: token } },
    });
  }

  /** Field checks the real carrier is known to be strict about (the country-code split). */
  private leadProblems(lead: Partial<LeadRequest>): string[] {
    const problems: string[] = [];
    if (!lead.did_number || !DIGITS.test(lead.did_number)) problems.push('did_number must be bare digits');
    if (!lead.customer_number || !DIGITS.test(lead.customer_number) || lead.customer_number.startsWith('0')) {
      problems.push('customer_number must be a bare national number');
    }
    if (!lead.country_code || !DIGITS.test(lead.country_code)) problems.push('country_code must be bare digits');
    if (!lead.websocket_url || !/^wss?:\/\//.test(lead.websocket_url)) problems.push('websocket_url must be ws(s)://');
    if (!lead.webhook_url || !/^https?:\/\//.test(lead.webhook_url)) problems.push('webhook_url must be http(s)://');
    return problems;
  }

  private async handleAddLead(
    record: RecordedRequest,
    body: unknown,
    respondAfterScript: boolean,
    send: (s: number, p: unknown) => void,
  ): Promise<void> {
    if (!this.bearerOk(record)) {
      send(401, { message: 'Unauthenticated.' });
      return;
    }
    const lead = (body ?? {}) as Partial<LeadRequest>;
    const problems = this.leadProblems(lead);
    if (problems.length > 0) {
      send(422, { status: false, message: 'The given data was invalid.', errors: problems });
      return;
    }
    const outboundQueueId = ++this.queueSeq;
    const call = this.place(lead as LeadRequest);
    const accepted = {
      status: true,
      message: 'Lead added successfully',
      data: { outbound_queue_id: outboundQueueId, bot_id: 77, reseller_id: 3, client_id: 1150, carrier_id: 9 },
    };
    if (respondAfterScript && call) await call.done;
    send(200, accepted);
  }

  private handleCdr(record: RecordedRequest, url: URL, send: (s: number, p: unknown) => void): void {
    if (!this.bearerOk(record)) {
      send(401, { message: 'Unauthenticated.' });
      return;
    }
    const id = url.searchParams.get('call_id') ?? '';
    const call = [...this.calls.values()].find((c) => c.carrierCallId === id);
    if (!call) {
      send(404, { status: false, message: 'Call log not found' });
      return;
    }
    send(200, {
      data: {
        call_id: call.carrierCallId,
        call_status: call.close ? 'ANSWERED' : 'NO ANSWER',
        talk_duration: Math.round(call.mediaSentPattern.length * 0.02),
        hangup_reason: 'Normal Clearing',
      },
    });
  }

  /** Accept a lead: run its script in the background, as the carrier dials asynchronously. */
  private place(lead: LeadRequest): CarrierCall | null {
    if (this.stopped) return null;
    const call = new CarrierCall({
      lead,
      carrierCallId: randomUUID(),
      rewrite: (u) => this.rewrite(u),
      sockets: this.mediaSockets,
    });
    this.calls.set(call.callId, call);
    this.callOrder.push(call);
    const script = this.scriptFor?.(lead, { index: this.callOrder.length - 1, callId: call.callId }) ?? null;
    if (!script) return null;
    this.runs.push(call.run(script));
    return call;
  }
}
