/**
 * FCM HTTP v1 (Android, Mode B; `docs/seams.md` §3.6). A data-only message, so the app's
 * messaging service runs (and rings natively) whether it is in the foreground, in the background
 * or killed: a `notification` block would be shown by the system instead, in the background.
 *
 *  - Auth: the service account signs an RS256 assertion, which Google's token endpoint trades for
 *    an access token (one hour). It is cached for 55 minutes (or its lifetime less 5 minutes, if
 *    shorter); concurrent sends share one refresh. A failed exchange is not cached: the next send
 *    tries again. A send answered 401 drops the cached token and is sent once more with a new one.
 *  - The message: `data` (every value a string, IQ61's fields only), `android.priority: HIGH` (a
 *    ring must wake a dozing phone) and `android.ttl` the ring window in whole seconds (rounded
 *    up): a phone that comes online after it is not rung for a caller who has gone.
 *  - Errors (`AgencyPushFailureReason`, {@link mapFcmAnswer}): `UNREGISTERED` → `unregistered`;
 *    `SENDER_ID_MISMATCH` (a token of another Firebase project) and `INVALID_ARGUMENT` on the token
 *    itself (`message.token`) → `invalid` (both revoke the device); 429 or `QUOTA_EXCEEDED` →
 *    `rate_limited`, and the device is held back until its `Retry-After` (never retried inside a
 *    ring; while held, a send answers `rate_limited` with the 429's own scope, `service`: the
 *    project's quota, not this phone's); 401/403 (our
 *    credentials), a bare 404, 5xx, any other 4xx (a message refused as malformed), a network
 *    error, a timeout or a failed token exchange → `unavailable`.
 *  - Hosts are fixed ({@link FCM_OAUTH_TOKEN_URL}, {@link FCM_API_ORIGIN}); tests swap the
 *    transport (`fetchImpl`, or `setPushTransportsForTests` in `push-sender.ts`), never the host.
 */
import type { AgencyRingPush } from '@magick-agency/contracts/agency';
import { pushFailureScope, type PushSendOptions, type PushSendResult, type PushSenderDevice } from '../../seams/push-sender.js';
import type { FcmCredentials } from './credentials.js';
import { signJwt } from './jwt.js';
import {
  PUSH_REQUEST_TIMEOUT_MS, RetryAfterGate, parseRetryAfter, pushData, settle,
  type PlatformPushSender, type SendOutcome,
} from './common.js';

export const FCM_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_API_ORIGIN = 'https://fcm.googleapis.com';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** The access token is used for at most this long (Google issues them for an hour). */
export const FCM_TOKEN_CACHE_MS = 55 * 60 * 1000;
/** FCM's longest `ttl` (28 days). */
const FCM_MAX_TTL_S = 28 * 24 * 60 * 60;

/** The slice of `fetch` the sender uses: a POST with a body and an abort signal. */
export type PushFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<Response>;

export interface FcmSenderOptions {
  credentials: FcmCredentials;
  /** Default: the global `fetch`. */
  fetchImpl?: PushFetch;
  /** Each request's bound; default {@link PUSH_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Default `Date.now`. */
  now?: () => number;
}

type Answer =
  | { kind: 'response'; status: number; body: string; retryAfter: string | null }
  | { kind: 'failed'; code: 'timeout' | 'network' };

/** The send URL of a project: `https://fcm.googleapis.com/v1/projects/{id}/messages:send`. */
export function fcmSendUrl(projectId: string): string {
  return `${FCM_API_ORIGIN}/v1/projects/${encodeURIComponent(projectId)}/messages:send`;
}

/** `android.ttl`: whole seconds, rounded up, in [0, 28 days], as FCM's duration string (`"20s"`). */
export function fcmTtl(ttlMs: number): string {
  const seconds = Math.min(FCM_MAX_TTL_S, Math.max(0, Math.ceil(ttlMs / 1000)));
  return `${seconds}s`;
}

/** The FCM error's `errorCode` (from `details`), else its canonical `status`. */
/** What an FCM error body says: its `errorCode` (else `status`), and whether it refused the token itself. */
export function fcmErrorDetail(body: string): { code: string | undefined; tokenRefused: boolean } {
  try {
    const error = (JSON.parse(body) as {
      error?: {
        status?: string;
        message?: string;
        details?: Array<{ errorCode?: string; fieldViolations?: Array<{ field?: string }> }>;
      };
    }).error;
    const code = error?.details?.find((d) => typeof d?.errorCode === 'string')?.errorCode ?? error?.status;
    const tokenField = error?.details?.some((d) => d?.fieldViolations?.some((v) => v?.field === 'message.token')) ?? false;
    const tokenMessage = typeof error?.message === 'string' && /registration token/i.test(error.message);
    return { code, tokenRefused: tokenField || tokenMessage };
  } catch {
    return { code: undefined, tokenRefused: false };
  }
}

/**
 * An FCM answer as the seam's result. Exported for the mapping tests.
 *
 *  - `UNREGISTERED` (FCM v1 always sends it with its 404) → `unregistered`. A bare 404 names no
 *    token (a wrong project or path, a proxy): `unavailable`, never a revoke;
 *  - `SENDER_ID_MISMATCH`, or `INVALID_ARGUMENT` on the token itself (`message.token`) → `invalid`:
 *    this token can never be pushed to by this sender (the device is revoked);
 *  - 429 / `QUOTA_EXCEEDED` → `rate_limited`, the push service's (no scope: see `PushFailureScope`);
 *  - 401, 403, 404, 5xx, and any other 4xx (a message refused as malformed: ours, every device
 *    alike) → `unavailable`.
 */
export function mapFcmAnswer(status: number, code: string | undefined, opts: { tokenRefused?: boolean } = {}): PushSendResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (code === 'UNREGISTERED') return { ok: false, reason: 'unregistered' };
  if (status === 429 || code === 'QUOTA_EXCEEDED') return { ok: false, reason: 'rate_limited' };
  if (code === 'SENDER_ID_MISMATCH') return { ok: false, reason: 'invalid' };
  if (code === 'INVALID_ARGUMENT' && opts.tokenRefused) return { ok: false, reason: 'invalid' };
  return { ok: false, reason: 'unavailable' };
}

export class FcmSender implements PlatformPushSender {
  readonly platform = 'android' as const;
  readonly #credentials: FcmCredentials;
  readonly #fetch: PushFetch;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #gate: RetryAfterGate;
  #token: { value: string; expiresAt: number } | null = null;
  #refreshing: Promise<string> | null = null;

  constructor(opts: FcmSenderOptions) {
    this.#credentials = opts.credentials;
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
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
    return settle('android', device, payload, outcome);
  }

  async close(): Promise<void> {
    this.#token = null;
  }

  async #send(device: PushSenderDevice, payload: AgencyRingPush, { ttlMs }: PushSendOptions): Promise<SendOutcome> {
    const token = device.fcm_token;
    if (!token) return { result: { ok: false, reason: 'invalid' }, code: 'no_token' };
    // Held by a Retry-After: answered with the scope of the 429 that set the hold (an FCM 429 is
    // the project's quota, so the service's: ringing pauses, the phone is not passed over).
    const held = this.#gate.blocked(device.id);
    if (held) return { result: { ok: false, reason: 'rate_limited', scope: held }, code: 'retry_after' };

    const started = performance.now();
    const seconds = () => (performance.now() - started) / 1000;
    const body = JSON.stringify({
      message: {
        token,
        data: pushData(payload),
        android: { priority: 'HIGH', ttl: fcmTtl(ttlMs) },
      },
    });

    let answer: Answer | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let accessToken: string;
      try {
        accessToken = await this.#accessToken();
      } catch {
        return { result: { ok: false, reason: 'unavailable' }, code: 'oauth_failed', seconds: seconds() };
      }
      answer = await this.#post(fcmSendUrl(this.#credentials.projectId), {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json; charset=utf-8',
      }, body);
      // A token Google no longer honours (revoked, or a clock skew past its expiry): drop it and
      // send once more with a fresh one.
      if (answer.kind === 'response' && answer.status === 401 && attempt === 0) {
        if (this.#token?.value === accessToken) this.#token = null;
        continue;
      }
      break;
    }
    if (!answer || answer.kind === 'failed') {
      return { result: { ok: false, reason: 'unavailable' }, code: answer?.code ?? 'network', seconds: seconds() };
    }
    const detail = answer.status >= 300 ? fcmErrorDetail(answer.body) : { code: undefined, tokenRefused: false };
    const code = detail.code;
    const result = mapFcmAnswer(answer.status, code, { tokenRefused: detail.tokenRefused });
    if (!result.ok && result.reason === 'rate_limited') {
      this.#gate.hold(device.id, parseRetryAfter(answer.retryAfter, this.#now()), pushFailureScope(result));
    }
    return { result, status: answer.status, code, seconds: seconds() };
  }

  /** The cached access token, or one fresh from Google; concurrent callers share one exchange. */
  async #accessToken(): Promise<string> {
    if (this.#token && this.#now() < this.#token.expiresAt) return this.#token.value;
    if (!this.#refreshing) {
      this.#refreshing = this.#exchange().finally(() => { this.#refreshing = null; });
    }
    return this.#refreshing;
  }

  async #exchange(): Promise<string> {
    const issuedAt = Math.floor(this.#now() / 1000);
    const assertion = signJwt('RS256', { typ: 'JWT' }, {
      iss: this.#credentials.clientEmail,
      scope: FCM_SCOPE,
      aud: FCM_OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    }, this.#credentials.privateKey);
    const answer = await this.#post(FCM_OAUTH_TOKEN_URL, {
      'content-type': 'application/x-www-form-urlencoded',
    }, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString());
    if (answer.kind !== 'response' || answer.status !== 200) throw new Error('FCM OAuth token exchange failed');
    const parsed = JSON.parse(answer.body) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token === '') {
      throw new Error('FCM OAuth token exchange answered no access_token');
    }
    const lifetimeMs = typeof parsed.expires_in === 'number' ? parsed.expires_in * 1000 : 3600_000;
    const usableMs = Math.min(FCM_TOKEN_CACHE_MS, Math.max(0, lifetimeMs - 5 * 60 * 1000));
    this.#token = { value: parsed.access_token, expiresAt: this.#now() + usableMs };
    return parsed.access_token;
  }

  async #post(url: string, headers: Record<string, string>, body: string): Promise<Answer> {
    // The abort stops the request; the race bounds the send even if a transport ignored it.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<Answer>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: 'failed', code: 'timeout' });
      }, this.#timeoutMs);
    });
    const request = (async (): Promise<Answer> => {
      try {
        const res = await this.#fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        const text = await res.text();
        return { kind: 'response', status: res.status, body: text, retryAfter: res.headers.get('retry-after') };
      } catch {
        return { kind: 'failed', code: controller.signal.aborted ? 'timeout' : 'network' };
      }
    })();
    try {
      return await Promise.race([request, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}
