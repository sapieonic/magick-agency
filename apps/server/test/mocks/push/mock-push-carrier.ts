/**
 * A scriptable mock of both push carriers (Mode B, `docs/seams.md` §3.6), for tests of the push
 * senders (`src/notifications/push/`) and of what rings a phone (the agency side, through the
 * seam). In-process: FCM is a `PushFetch` that answers Google's two fixed URLs itself, APNs a local
 * HTTP/2 (h2c) server that an `ApnsConnect` points the APNs origins at.
 *
 * ── Using it ─────────────────────────────────────────────────────────────────
 *   const carrier = await MockPushCarrier.start();
 *   setPushSender(carrier.sender());          // the REAL senders, on the carrier's transports
 *   ... ring ...
 *   expect(carrier.sends).toMatchObject([{ platform: 'android', data: { type: 'ring', call_id } }]);
 *   resetPushSender(); await carrier.stop();
 *
 * Or, for an app built from env (`buildApp` + the bootstraps): put `carrier.env` in the env (the
 * `PUSH_*` keys of its generated credentials) and `carrier.install()` before the platform
 * bootstrap runs (`setPushTransportsForTests`); `stop()` uninstalls.
 *
 * ── What it checks ───────────────────────────────────────────────────────────
 *  - FCM: the OAuth assertion's RS256 signature (against the generated service account) and its
 *    claims (`iss`, `aud`, `scope`, `exp` after `iat`), the grant type; then each send's Bearer
 *    is an access token it issued. A wrong one is answered 401 (and recorded `authorized: false`).
 *  - APNs: the provider token's ES256 signature (the generated `.p8`), its `kid` and `iss`; a
 *    wrong one is 403 `InvalidProviderToken`. The `:path` is `/3/device/{token}`.
 *  - Any other URL or origin is refused (the request throws) and recorded in `offHost`.
 *
 * ── Scripting answers ────────────────────────────────────────────────────────
 * For each send, the first that applies: the token's own queue (`answer(token, ...)`), a token
 * marked gone (`unregister(token)`: every later send to it is FCM 404 `UNREGISTERED` / APNs 410),
 * the platform's queue (`answerNext(platform, ...)`), the default (`setDefault`, initially `ok`).
 * See {@link MockPushAnswer} for the answers and the carriers' bodies each one sends.
 */
import http2, { type Http2Session, type ServerHttp2Stream } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { createPublicKey, generateKeyPairSync, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { AgencyPushPlatform } from '@magick-agency/contracts/agency';
import type { PushSenderDevice } from '../../../src/seams/push-sender.js';
import { FCM_API_ORIGIN, FCM_OAUTH_TOKEN_URL, FCM_SCOPE, type PushFetch } from '../../../src/notifications/push/fcm-sender.js';
import { APNS_ORIGINS, type ApnsConnect } from '../../../src/notifications/push/apns-sender.js';
import {
  createPushSender, setPushTransportsForTests, type PushConfig, type PushTransports, type RoutingPushSender,
} from '../../../src/notifications/push/push-sender.js';
import type { ApnsEnvironment } from '../../../src/notifications/push/credentials.js';

export type MockPushAnswer =
  /** FCM 200 `{name}`; APNs 200 with an `apns-id`. */
  | { kind: 'ok' }
  /** FCM 404 `NOT_FOUND`/`UNREGISTERED`; APNs 410 `Unregistered`. */
  | { kind: 'unregistered' }
  /** FCM 400 `INVALID_ARGUMENT`; APNs 400 `DeviceTokenNotForTopic`. */
  | { kind: 'invalid' }
  /** 429 (FCM `QUOTA_EXCEEDED`, APNs `TooManyRequests`), with `Retry-After` when given. */
  | { kind: 'rate_limited'; retryAfterSeconds?: number }
  /** FCM 503 `UNAVAILABLE`; APNs 503 `ServiceUnavailable`. */
  | { kind: 'unavailable' }
  /** APNs: 503 `Shutdown`, then the session is sent GOAWAY (the next send must reconnect). FCM: as `unavailable`. */
  | { kind: 'shutdown' }
  /** Any status and body (and `Retry-After`), as given. */
  | { kind: 'status'; status: number; body?: unknown; retryAfter?: string }
  /** Never answered: the sender's own timeout ends it. */
  | { kind: 'hang' }
  /** FCM: the fetch rejects (a network error). APNs: the stream is reset (`INTERNAL_ERROR`) after the request was read. */
  | { kind: 'network' }
  /** APNs: the stream is refused unprocessed (`REFUSED_STREAM`), which the sender sends again once. FCM: as `network`. */
  | { kind: 'refused' }
  /** Wait `ms`, then answer `then` (default `ok`). */
  | { kind: 'latency'; ms: number; then?: MockPushAnswer };

export interface RecordedPush {
  seq: number;
  platform: AgencyPushPlatform;
  token: string;
  /** What the phone gets: FCM `message.data`, or the APNs payload without `aps`. */
  data: Record<string, string>;
  /** The credential on the request checked out. */
  authorized: boolean;
  /** The answer it was given (`hang` until the sender gave up). */
  answer: MockPushAnswer['kind'];
  /** The HTTP status sent; null for `hang`, `network`, `refused`. */
  status: number | null;
  /** FCM: `message.android`. */
  android?: { priority?: string; ttl?: string };
  /** APNs: the headers that matter. */
  apns?: { pushType?: string; topic?: string; priority?: string; expiration?: string; providerToken: string };
}

export interface MockPushCarrierOptions {
  projectId?: string;
  bundleId?: string;
  apnsEnv?: ApnsEnvironment;
}

const KEY_ID = 'MOCKKEY123';
const TEAM_ID = 'MOCKTEAM12';

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; input: string; signature: Buffer } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as Record<string, unknown>,
      claims: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>,
      input: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2]!, 'base64url'),
    };
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

export class MockPushCarrier {
  /** The credentials the carrier accepts, as the parsed `push` config block. */
  readonly config: Required<PushConfig>;
  /** The same credentials as the `PUSH_*` env keys (for an app built from env). */
  readonly env: Record<string, string>;
  /** Every send that reached the carrier, in order. */
  readonly sends: RecordedPush[] = [];
  /** Requests to a URL or origin that is not the carrier's. */
  readonly offHost: string[] = [];
  /** FCM OAuth exchanges (accepted or not). */
  oauthExchanges = 0;
  /** APNs HTTP/2 connections opened. */
  apnsConnections = 0;

  readonly #fcmPublic: KeyObject;
  readonly #apnsPublic: KeyObject;
  readonly #tokenQueues = new Map<string, MockPushAnswer[]>();
  readonly #platformQueues: Record<AgencyPushPlatform, MockPushAnswer[]> = { android: [], ios: [] };
  readonly #unregistered = new Set<string>();
  readonly #oauthQueue: MockPushAnswer[] = [];
  readonly #accessTokens = new Set<string>();
  readonly #sessions = new Set<Http2Session>();
  readonly #waiters: Array<() => void> = [];
  #default: MockPushAnswer = { kind: 'ok' };
  #seq = 0;
  #server: http2.Http2Server | null = null;
  #port = 0;
  #installed = false;

  private constructor(opts: MockPushCarrierOptions) {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.#fcmPublic = rsa.publicKey;
    this.#apnsPublic = ec.publicKey;
    const projectId = opts.projectId ?? 'mock-agent-project';
    const clientEmail = `push@${projectId}.iam.gserviceaccount.com`;
    const bundleId = opts.bundleId ?? 'com.example.agent';
    const env = opts.apnsEnv ?? 'production';
    this.config = {
      fcm: { projectId, clientEmail, privateKey: rsa.privateKey },
      apns: { key: ec.privateKey, keyId: KEY_ID, teamId: TEAM_ID, bundleId, env },
    };
    const serviceAccount = {
      type: 'service_account',
      project_id: projectId,
      client_email: clientEmail,
      private_key: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    };
    this.env = {
      PUSH_FCM_SERVICE_ACCOUNT_JSON_B64: Buffer.from(JSON.stringify(serviceAccount)).toString('base64'),
      PUSH_APNS_KEY_P8_B64: Buffer.from(ec.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()).toString('base64'),
      PUSH_APNS_KEY_ID: KEY_ID,
      PUSH_APNS_TEAM_ID: TEAM_ID,
      PUSH_APNS_BUNDLE_ID: bundleId,
      PUSH_APNS_ENV: env,
    };
  }

  /** A carrier with fresh credentials and its APNs server listening on loopback. */
  static async start(opts: MockPushCarrierOptions = {}): Promise<MockPushCarrier> {
    const carrier = new MockPushCarrier(opts);
    await carrier.#listen();
    return carrier;
  }

  // ── Transports and senders ────────────────────────────────────────────────

  /** FCM's transport: Google's token URL and the project's send URL, nothing else. */
  readonly fetch: PushFetch = async (url, init) => {
    if (init.signal.aborted) throw init.signal.reason;
    if (url === FCM_OAUTH_TOKEN_URL) return this.#oauth(init.body, init.signal);
    const m = /^(https:\/\/[^/]+)\/v1\/projects\/([^/]+)\/messages:send$/.exec(url);
    if (!m || m[1] !== FCM_API_ORIGIN || decodeURIComponent(m[2]!) !== this.config.fcm.projectId) {
      this.offHost.push(url);
      throw new TypeError(`MockPushCarrier: ${url} is not FCM's send URL for ${this.config.fcm.projectId}`);
    }
    return this.#fcmSend(init.headers, init.body, init.signal);
  };

  /** APNs' transport: the two APNs origins, both to this carrier's loopback server. */
  readonly apnsConnect: ApnsConnect = (origin) => {
    if (!Object.values(APNS_ORIGINS).includes(origin)) {
      this.offHost.push(origin);
      throw new TypeError(`MockPushCarrier: ${origin} is not an APNs origin`);
    }
    this.apnsConnections += 1;
    return http2.connect(`http://127.0.0.1:${this.#port}`);
  };

  /** The real routing sender (FCM and APNs) on this carrier's credentials and transports. */
  sender(extra: Omit<PushTransports, 'fetch' | 'apnsConnect'> = {}, config: PushConfig = this.config): RoutingPushSender {
    const sender = createPushSender(config, { ...extra, fetch: this.fetch, apnsConnect: this.apnsConnect });
    if (!sender) throw new Error('MockPushCarrier.sender: the config names no platform');
    return sender;
  }

  /** Senders the platform bootstrap builds (`createPushSender`) use this carrier until `stop`/`uninstall`. */
  install(extra: Omit<PushTransports, 'fetch' | 'apnsConnect'> = {}): void {
    setPushTransportsForTests({ ...extra, fetch: this.fetch, apnsConnect: this.apnsConnect });
    this.#installed = true;
  }

  uninstall(): void {
    if (this.#installed) setPushTransportsForTests(null);
    this.#installed = false;
  }

  /** A push device row for this carrier (a fresh token unless given). */
  static device(platform: AgencyPushPlatform, id = `push-device-${randomBytes(4).toString('hex')}`, token?: string): PushSenderDevice {
    return platform === 'android'
      ? { id, platform, fcm_token: token ?? `fcm-${randomBytes(16).toString('hex')}`, voip_token: null }
      : { id, platform, fcm_token: null, voip_token: token ?? randomBytes(32).toString('hex') };
  }

  // ── Scripting ────────────────────────────────────────────────────────────

  /** The next sends to `token` get these answers, in order (before anything else applies). */
  answer(token: string, ...answers: MockPushAnswer[]): void {
    const queue = this.#tokenQueues.get(token) ?? [];
    queue.push(...answers);
    this.#tokenQueues.set(token, queue);
  }

  /** The next sends on `platform` (whose token has no queue of its own) get these answers, in order. */
  answerNext(platform: AgencyPushPlatform, ...answers: MockPushAnswer[]): void {
    this.#platformQueues[platform].push(...answers);
  }

  /** The next FCM OAuth exchanges get these answers (`ok` issues a token; anything else fails it). */
  answerOAuthNext(...answers: MockPushAnswer[]): void {
    this.#oauthQueue.push(...answers);
  }

  /** The token is gone: every later send to it is answered unregistered. */
  unregister(token: string): void {
    this.#unregistered.add(token);
  }

  /** What a send gets when nothing else applies. */
  setDefault(answer: MockPushAnswer): void {
    this.#default = answer;
  }

  /** Every APNs session is sent GOAWAY (as Apple does when it rotates a connection). */
  goawayApns(): void {
    for (const session of this.#sessions) if (!session.closed) session.goaway(http2.constants.NGHTTP2_NO_ERROR);
  }

  /** Every APNs connection is cut with no GOAWAY. */
  dropApnsConnections(): void {
    for (const session of this.#sessions) session.destroy();
  }

  /** Clears the record and the scripts (not the credentials or the issued access tokens). */
  reset(): void {
    this.sends.length = 0;
    this.offHost.length = 0;
    this.oauthExchanges = 0;
    this.apnsConnections = 0;
    this.#tokenQueues.clear();
    this.#platformQueues.android.length = 0;
    this.#platformQueues.ios.length = 0;
    this.#oauthQueue.length = 0;
    this.#unregistered.clear();
    this.#default = { kind: 'ok' };
  }

  // ── Reading what was sent ────────────────────────────────────────────────

  sendsTo(token: string): RecordedPush[] {
    return this.sends.filter((s) => s.token === token);
  }

  /** Resolves once at least `count` sends have reached the carrier (rejects after `timeoutMs`). */
  async waitForSends(count: number, timeoutMs = 2_000): Promise<RecordedPush[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.sends.length < count) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`MockPushCarrier: ${this.sends.length} of ${count} sends after ${timeoutMs} ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.#waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return this.sends.slice();
  }

  async stop(): Promise<void> {
    this.uninstall();
    for (const session of this.#sessions) session.destroy();
    this.#sessions.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #record(push: Omit<RecordedPush, 'seq'>): RecordedPush {
    this.#seq += 1;
    const recorded = { seq: this.#seq, ...push };
    this.sends.push(recorded);
    for (const wake of this.#waiters.splice(0)) wake();
    return recorded;
  }

  #nextAnswer(platform: AgencyPushPlatform, token: string): MockPushAnswer {
    const own = this.#tokenQueues.get(token);
    if (own && own.length > 0) return own.shift()!;
    if (this.#unregistered.has(token)) return { kind: 'unregistered' };
    return this.#platformQueues[platform].shift() ?? this.#default;
  }

  async #oauth(body: string, signal: AbortSignal): Promise<Response> {
    this.oauthExchanges += 1;
    const form = new URLSearchParams(body);
    const jwt = decodeJwt(form.get('assertion') ?? '');
    const now = Math.floor(Date.now() / 1000);
    const valid = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
      && jwt !== null
      && jwt.header['alg'] === 'RS256'
      && jwt.claims['iss'] === this.config.fcm.clientEmail
      && jwt.claims['aud'] === FCM_OAUTH_TOKEN_URL
      && jwt.claims['scope'] === FCM_SCOPE
      && typeof jwt.claims['iat'] === 'number' && typeof jwt.claims['exp'] === 'number'
      && (jwt.claims['exp'] as number) > (jwt.claims['iat'] as number)
      && verify('sha256', Buffer.from(jwt.input), this.#fcmPublic, jwt.signature);
    if (!valid) return Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 });
    let answer = this.#oauthQueue.shift() ?? { kind: 'ok' };
    while (answer.kind === 'latency') {
      await delay(answer.ms, signal);
      answer = answer.then ?? { kind: 'ok' };
    }
    if (answer.kind === 'hang') return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (answer.kind === 'network' || answer.kind === 'refused') throw new TypeError('fetch failed');
    if (answer.kind !== 'ok') {
      const status = answer.kind === 'status' ? answer.status : 503;
      return Response.json({ error: 'temporarily_unavailable' }, { status });
    }
    const accessToken = `mock-access-${now}-${randomBytes(8).toString('hex')}`;
    this.#accessTokens.add(accessToken);
    return Response.json({ access_token: accessToken, expires_in: 3599, token_type: 'Bearer' });
  }

  async #fcmSend(headers: Record<string, string>, body: string, signal: AbortSignal): Promise<Response> {
    const message = (JSON.parse(body) as { message?: { token?: string; data?: Record<string, string>; android?: { priority?: string; ttl?: string } } }).message ?? {};
    const auth = headers['authorization'] ?? headers['Authorization'] ?? '';
    const authorized = auth.startsWith('Bearer ') && this.#accessTokens.has(auth.slice('Bearer '.length));
    const token = message.token ?? '';
    let answer: MockPushAnswer = authorized ? this.#nextAnswer('android', token) : { kind: 'status', status: 401 };
    const recorded = this.#record({
      platform: 'android', token, data: message.data ?? {}, authorized, answer: answer.kind, status: null,
      ...(message.android ? { android: message.android } : {}),
    });
    while (answer.kind === 'latency') {
      await delay(answer.ms, signal);
      answer = answer.then ?? { kind: 'ok' };
      recorded.answer = answer.kind;
    }
    if (answer.kind === 'hang') return new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (answer.kind === 'network' || answer.kind === 'refused') throw new TypeError('fetch failed');
    const fcmError = (status: number, canonical: string, errorCode: string, extra: Record<string, string> = {}) => {
      recorded.status = status;
      return Response.json({
        error: {
          code: status, message: canonical, status: canonical,
          details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
        },
      }, { status, headers: extra });
    };
    switch (answer.kind) {
      case 'ok':
        recorded.status = 200;
        return Response.json({ name: `projects/${this.config.fcm.projectId}/messages/${randomBytes(8).toString('hex')}` });
      case 'unregistered': return fcmError(404, 'NOT_FOUND', 'UNREGISTERED');
      case 'invalid': return fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT');
      case 'rate_limited':
        return fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED',
          answer.retryAfterSeconds !== undefined ? { 'retry-after': String(answer.retryAfterSeconds) } : {});
      case 'unavailable':
      case 'shutdown': return fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE');
      case 'status':
        recorded.status = answer.status;
        return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
          status: answer.status,
          headers: answer.retryAfter !== undefined ? { 'retry-after': answer.retryAfter } : {},
        });
    }
  }

  async #listen(): Promise<void> {
    const server = http2.createServer();
    server.on('session', (session) => {
      this.#sessions.add(session);
      session.on('close', () => this.#sessions.delete(session));
      session.on('error', () => {});
    });
    server.on('stream', (stream, headers) => {
      stream.on('error', () => {});
      let body = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => { body += chunk; });
      stream.on('end', () => { void this.#apnsSend(stream, headers, body); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
  }

  async #apnsSend(stream: ServerHttp2Stream, headers: http2.IncomingHttpHeaders, body: string): Promise<void> {
    const path = String(headers[':path'] ?? '');
    const token = /^\/3\/device\/([0-9a-fA-F]+)$/.exec(path)?.[1] ?? '';
    const providerToken = String(headers['authorization'] ?? '').replace(/^bearer /, '');
    const jwt = decodeJwt(providerToken);
    const authorized = jwt !== null
      && jwt.header['alg'] === 'ES256'
      && jwt.header['kid'] === this.config.apns.keyId
      && jwt.claims['iss'] === this.config.apns.teamId
      && typeof jwt.claims['iat'] === 'number'
      && verify('sha256', Buffer.from(jwt.input), { key: this.#apnsPublic, dsaEncoding: 'ieee-p1363' }, jwt.signature);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(body) as Record<string, unknown>; } catch { /* recorded empty */ }
    const { aps: _aps, ...rest } = payload;
    const data = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, String(v)]));
    let answer: MockPushAnswer = !token
      ? { kind: 'status', status: 404, body: { reason: 'BadPath' } }
      : authorized ? this.#nextAnswer('ios', token) : { kind: 'status', status: 403, body: { reason: 'InvalidProviderToken' } };
    const header = (name: string) => (typeof headers[name] === 'string' ? headers[name] : undefined);
    const recorded = this.#record({
      platform: 'ios', token, data, authorized, answer: answer.kind, status: null,
      apns: {
        pushType: header('apns-push-type'),
        topic: header('apns-topic'),
        priority: header('apns-priority'),
        expiration: header('apns-expiration'),
        providerToken,
      },
    });
    while (answer.kind === 'latency') {
      await delay(answer.ms);
      answer = answer.then ?? { kind: 'ok' };
      recorded.answer = answer.kind;
    }
    if (stream.closed || stream.destroyed) return;
    const respond = (status: number, reply?: unknown, extra: Record<string, string> = {}) => {
      recorded.status = status;
      stream.respond({ ':status': status, ...(status === 200 ? { 'apns-id': randomBytes(16).toString('hex') } : {}), ...extra });
      stream.end(reply === undefined ? undefined : JSON.stringify(reply));
    };
    switch (answer.kind) {
      case 'ok': return respond(200);
      case 'unregistered': return respond(410, { reason: 'Unregistered', timestamp: Date.now() });
      case 'invalid': return respond(400, { reason: 'DeviceTokenNotForTopic' });
      case 'rate_limited':
        return respond(429, { reason: 'TooManyRequests' },
          answer.retryAfterSeconds !== undefined ? { 'retry-after': String(answer.retryAfterSeconds) } : {});
      case 'unavailable': return respond(503, { reason: 'ServiceUnavailable' });
      case 'shutdown':
        respond(503, { reason: 'Shutdown' });
        stream.session?.goaway(http2.constants.NGHTTP2_NO_ERROR);
        return;
      case 'status':
        return respond(answer.status, answer.body, answer.retryAfter !== undefined ? { 'retry-after': answer.retryAfter } : {});
      case 'hang': return; // the sender's timeout cancels the stream
      case 'network': stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); return;
      case 'refused': stream.close(http2.constants.NGHTTP2_REFUSED_STREAM); return;
    }
  }
}

/** The public key of a private one (tests verifying a signature themselves). */
export function publicKeyOf(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}
