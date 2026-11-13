/**
 * APNs VoIP pushes (iOS, Mode B; `docs/seams.md` §3.6). iOS is contract-only for now (IQ64): this
 * sender is complete, but no build of the app registers a VoIP token yet.
 *
 *  - Only `ring` and `test_ring` are sent. Since iOS 13 every VoIP push must be reported to CallKit
 *    as an incoming call, or iOS kills the app and, after repeated misses, stops delivering VoIP
 *    pushes to it. A `ring_cancel` or `ring_off` would be a push that is not a call, so each
 *    answers `{ ok: true }` unsent (counted `skipped`): the app checks the call when CallKit's
 *    call is answered instead.
 *  - Auth: an ES256 provider token (`kid` the key id, `iss` the team, `iat`), minted again after
 *    50 minutes (Apple refuses one older than an hour, and one minted more often than every 20).
 *    A send refused `ExpiredProviderToken` mints a new one and is sent once more.
 *  - Transport: one HTTP/2 session to the environment's fixed host
 *    ({@link APNS_ORIGINS}), reused for every send. A session that has gone away (GOAWAY, an error,
 *    a close) is dropped and the next send connects anew. A send refused unprocessed
 *    (`REFUSED_STREAM`, or its session already going away) is sent once more, on a new session if
 *    its own has gone; one reset after the request went out is not (the phone may have rung).
 *  - Headers: `apns-push-type: voip`, `apns-topic: {bundle}.voip`, `apns-priority: 10`,
 *    `apns-expiration` the end of `ttlMs` (epoch seconds; `0` sends once and stores nothing).
 *  - Errors (`AgencyPushFailureReason`): 410, `BadDeviceToken`, `Unregistered`, `ExpiredToken` →
 *    `unregistered` (a sandbox token sent to production is refused `BadDeviceToken` too: set
 *    `PUSH_APNS_ENV` to match the build); `DeviceTokenNotForTopic` → `invalid` (both revoke the
 *    device); 429 (`TooManyRequests`, per token) → `rate_limited` with scope `device` (held back,
 *    never retried in a ring); 403 (our provider token or topic), 5xx, any other 4xx (a request
 *    refused as malformed), a network error and the {@link PUSH_REQUEST_TIMEOUT_MS} timeout →
 *    `unavailable`.
 */
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { logger } from '@magick-agency/observability';
import type { AgencyRingPush, AgencyRingPushType } from '@magick-agency/contracts/agency';
import type { PushSendOptions, PushSendResult, PushSenderDevice } from '../../seams/push-sender.js';
import type { ApnsCredentials, ApnsEnvironment } from './credentials.js';
import { signJwt } from './jwt.js';
import {
  PUSH_REQUEST_TIMEOUT_MS, RetryAfterGate, parseRetryAfter, pushData, settle,
  type PlatformPushSender, type SendOutcome,
} from './common.js';

export const APNS_ORIGINS: Record<ApnsEnvironment, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** A provider token is minted again once it is this old (Apple: at most one hour, at least 20 minutes). */
export const APNS_PROVIDER_TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

/** The push types an iOS phone is sent: each is a call it reports to CallKit. */
export const APNS_SENT_TYPES: ReadonlySet<AgencyRingPushType> = new Set(['ring', 'test_ring']);

/** Opens an HTTP/2 session to `origin` (one of {@link APNS_ORIGINS}); tests point it at a mock. */
export type ApnsConnect = (origin: string) => ClientHttp2Session;

export interface ApnsSenderOptions {
  credentials: ApnsCredentials;
  /** Default: `http2.connect(origin)`. */
  connect?: ApnsConnect;
  /** Each request's bound; default {@link PUSH_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
}

/** A device token is hex (64 characters today); anything else never reaches the request path. */
const DEVICE_TOKEN = /^[0-9a-fA-F]{32,256}$/;

/** Errors that mean the request was never processed because its session was going away. */
const REFUSED_CODES = new Set(['ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_INVALID_SESSION']);

type Answer =
  | { kind: 'response'; status: number; body: string; retryAfter: string | null }
  | { kind: 'failed'; code: 'timeout' | 'network'; refused: boolean };

/** An APNs answer as the seam's result. Exported for the mapping tests. */
export function mapApnsAnswer(status: number, reason: string | undefined): PushSendResult {
  if (status === 200) return { ok: true };
  if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'ExpiredToken') {
    return { ok: false, reason: 'unregistered' };
  }
  // A token for another app (topic): this token can never be pushed to by this sender.
  if (reason === 'DeviceTokenNotForTopic') return { ok: false, reason: 'invalid' };
  // `TooManyRequests` is per device token.
  if (status === 429) return { ok: false, reason: 'rate_limited', scope: 'device' };
  // 403 (our provider token or topic), 5xx, and any other 4xx (a request refused as malformed:
  // ours, every device alike).
  return { ok: false, reason: 'unavailable' };
}

function apnsReason(body: string): string | undefined {
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === 'string' ? reason : undefined;
  } catch {
    return undefined;
  }
}

/** `apns-expiration`: when `ttlMs` from now ends, in epoch seconds; `0` for no time at all. */
export function apnsExpiration(nowMs: number, ttlMs: number): string {
  return ttlMs <= 0 ? '0' : String(Math.floor((nowMs + ttlMs) / 1000));
}

export class ApnsSender implements PlatformPushSender {
  readonly platform = 'ios' as const;
  readonly #credentials: ApnsCredentials;
  readonly #origin: string;
  readonly #connect: ApnsConnect;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #gate: RetryAfterGate;
  #session: ClientHttp2Session | null = null;
  #providerToken: { value: string; issuedAt: number } | null = null;
  #closed = false;

  constructor(opts: ApnsSenderOptions) {
    this.#credentials = opts.credentials;
    this.#origin = APNS_ORIGINS[opts.credentials.env];
    this.#connect = opts.connect ?? ((origin) => http2.connect(origin));
    this.#timeoutMs = opts.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
    this.#gate = new RetryAfterGate(this.#now);
  }

  async send(device: PushSenderDevice, payload: AgencyRingPush, opts: PushSendOptions): Promise<PushSendResult> {
    let outcome: SendOutcome;
    try {
      outcome = await this.#send(device, payload, opts);
    } catch {
      outcome = { result: { ok: false, reason: 'unavailable' }, code: 'internal' };
    }
    return settle('ios', device, payload, outcome);
  }

  /** Closes the session (at stop); a later send would connect again. */
  async close(): Promise<void> {
    this.#closed = true;
    const session = this.#session;
    this.#session = null;
    if (!session || session.destroyed) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { session.destroy(); resolve(); }, 1_000);
      session.close(() => { clearTimeout(timer); resolve(); });
    });
  }

  async #send(device: PushSenderDevice, payload: AgencyRingPush, { ttlMs }: PushSendOptions): Promise<SendOutcome> {
    if (!APNS_SENT_TYPES.has(payload.type)) return { result: { ok: true }, skipped: true };
    const token = device.voip_token;
    if (!token || !DEVICE_TOKEN.test(token)) return { result: { ok: false, reason: 'invalid' }, code: 'no_token' };
    // Held by this device's own Retry-After: this device's trouble, not the service's.
    if (this.#gate.blocked(device.id)) return { result: { ok: false, reason: 'rate_limited', scope: 'device' }, code: 'retry_after' };

    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    const body = JSON.stringify({ aps: {}, ...pushData(payload) });

    let answer: Answer | null = null;
    let reason: string | undefined;
    let refreshedToken = false;
    let reconnected = false;
    for (;;) {
      answer = await this.#request(token, body, ttlMs);
      if (answer.kind === 'failed') {
        // Refused unprocessed by a session going away: once more on a new session.
        if (answer.refused && !reconnected) { reconnected = true; continue; }
        break;
      }
      reason = answer.status === 200 ? undefined : apnsReason(answer.body);
      if (answer.status === 403 && reason === 'ExpiredProviderToken' && !refreshedToken) {
        refreshedToken = true;
        this.#providerToken = null;
        continue;
      }
      break;
    }
    if (answer.kind === 'failed') {
      return { result: { ok: false, reason: 'unavailable' }, code: answer.code, seconds: seconds() };
    }
    const result = mapApnsAnswer(answer.status, reason);
    if (!result.ok && result.reason === 'rate_limited') {
      this.#gate.hold(device.id, parseRetryAfter(answer.retryAfter, this.#now()));
    }
    return { result, status: answer.status, code: reason, seconds: seconds() };
  }

  /** The cached provider token, or a new one once it is {@link APNS_PROVIDER_TOKEN_MAX_AGE_MS} old. */
  #token(): string {
    const now = this.#now();
    if (this.#providerToken && now - this.#providerToken.issuedAt < APNS_PROVIDER_TOKEN_MAX_AGE_MS) {
      return this.#providerToken.value;
    }
    const value = signJwt('ES256', { kid: this.#credentials.keyId }, {
      iss: this.#credentials.teamId,
      iat: Math.floor(now / 1000),
    }, this.#credentials.key);
    this.#providerToken = { value, issuedAt: now };
    return value;
  }

  /** The live session, or a new one; a session that goes away drops itself. */
  #sessionNow(): ClientHttp2Session {
    const current = this.#session;
    if (current && !current.closed && !current.destroyed) return current;
    const session = this.#connect(this.#origin);
    const drop = () => { if (this.#session === session) this.#session = null; };
    session.on('error', (err: Error & { code?: string }) => {
      drop();
      logger.warn({ platform: 'ios', err_code: err.code, err_message: err.message }, 'APNs session error');
    });
    session.on('goaway', drop);
    session.on('close', drop);
    // A server process: the session never holds the event loop open on its own.
    session.unref();
    this.#session = session;
    return session;
  }

  /**
   * After a timed-out send: a session that never connected, or whose peer does not answer a PING
   * within the request timeout (a half-open connection), would hold every later send too, so it
   * is destroyed and the next send connects anew. One that answers is kept.
   */
  #probe(session: ClientHttp2Session): void {
    const kill = () => {
      if (this.#session === session) this.#session = null;
      session.destroy();
    };
    if (session.destroyed || session.closed) return;
    if (session.connecting) { kill(); return; }
    const timer = setTimeout(kill, this.#timeoutMs);
    timer.unref();
    try {
      session.ping((err) => { clearTimeout(timer); if (err) kill(); });
    } catch {
      clearTimeout(timer);
      kill();
    }
  }

  #request(token: string, body: string, ttlMs: number): Promise<Answer> {
    if (this.#closed) return Promise.resolve({ kind: 'failed', code: 'network', refused: false });
    return new Promise<Answer>((resolve) => {
      let settled = false;
      let stream: ClientHttp2Stream | null = null;
      let session: ClientHttp2Session | null = null;
      const done = (answer: Answer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        stream?.close(http2.constants.NGHTTP2_CANCEL);
        if (session) this.#probe(session);
        done({ kind: 'failed', code: 'timeout', refused: false });
      }, this.#timeoutMs);
      try {
        session = this.#sessionNow();
        stream = session.request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.#token()}`,
          'apns-push-type': 'voip',
          'apns-topic': `${this.#credentials.bundleId}.voip`,
          'apns-priority': '10',
          'apns-expiration': apnsExpiration(this.#now(), ttlMs),
          'content-type': 'application/json',
        });
      } catch (err) {
        if (session && this.#session === session) this.#session = null;
        const code = (err as { code?: string }).code ?? '';
        done({ kind: 'failed', code: 'network', refused: REFUSED_CODES.has(code) });
        return;
      }
      let status = 0;
      let retryAfter: string | null = null;
      let data = '';
      stream.setEncoding('utf8');
      stream.on('response', (headers) => {
        status = Number(headers[':status']);
        const header = headers['retry-after'];
        retryAfter = typeof header === 'string' ? header : null;
      });
      stream.on('data', (chunk: string) => { data += chunk; });
      stream.on('end', () => {
        if (status === 0) done({ kind: 'failed', code: 'network', refused: false });
        else done({ kind: 'response', status, body: data, retryAfter });
      });
      // Closed or failed without an answer: refused unprocessed (REFUSED_STREAM, as for a stream
      // past a GOAWAY's last id, or a session already going away) is safe to send again; a reset
      // after the request went out is not (the phone may have been rung).
      const refusedUnprocessed = (code: string | undefined) => status === 0
        && (REFUSED_CODES.has(code ?? '') || stream?.rstCode === http2.constants.NGHTTP2_REFUSED_STREAM);
      stream.on('close', () => {
        if (status !== 0) return;
        done({ kind: 'failed', code: 'network', refused: refusedUnprocessed(undefined) });
      });
      stream.on('error', (err: Error & { code?: string }) => {
        if (session && this.#session === session && (session.closed || session.destroyed)) this.#session = null;
        done({ kind: 'failed', code: 'network', refused: refusedUnprocessed(err.code) });
      });
      stream.end(body);
    });
  }
}
