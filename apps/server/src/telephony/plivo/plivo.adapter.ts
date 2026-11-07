// The Plivo adapter: calls on a tenant's OWN Plivo account (BYOC, decision B18), built
// from the credential a call is pinned to (`factory.ts`, `BYOC_ADAPTERS`).
//
// Carrier facts it relies on:
//  - Create call (`POST /v1/Account/{auth_id}/Call/`) returns only a `request_uuid`; the
//    `call_uuid` every later operation takes arrives on the answer and status callbacks.
//  - A not-yet-answered call is cancelled by its request id (`DELETE …/Request/{id}/`);
//    a call is hung up by its call id (`DELETE …/Call/{id}/`). A hangup with an EMPTY id
//    disconnects every call on the account, so an id is checked before any URL is built.
//  - On answer Plivo fetches `answer_url` and runs the XML we return: a session
//    `<Record>` (when recording) and a bidirectional μ-law `<Stream>` to our bridge.
//  - Callbacks are signed (V3, `plivo-signature.ts`) with the account's auth token.
//
// Every request goes to the fixed host `PLIVO_API_BASE`, never one from tenant data, with
// redirects refused (so the Authorization header cannot be forwarded) and a timeout. The
// auth token is held as a `Secret` and revealed only into the Authorization header and
// the HMAC; it is never logged, nor is a URL carrying a token.
import { createChildLogger } from '@magick-agency/observability';
import { trackCarrierDialRefusal } from '@magick-agency/observability/metrics/voice';
import type {
  AnnouncementResponseParams,
  AnswerResponseOptions,
  CallEvent,
  CarrierHttpRequest,
  InitiateCallResult,
  IvrStepRenderParams,
  MediaStreamConfig,
  OutboundCallRequest,
  ProviderCallStatus,
  ProviderCapabilities,
  TelephonyProvider,
} from '../types.js';
import type { AppConfig } from '../../config/index.js';
import type { ResolvedCredential } from '../credentials/credential-service.js';
import { PLIVO_API_BASE } from '../credentials/credential-specs.js';
import { Secret } from '../credentials/secret.js';
import {
  CarrierAuthRejectedError,
  CarrierDialAbortedError,
  CarrierDialNotSentError,
  CarrierDialOutcomeUnknownError,
  CarrierRateLimitedError,
  CarrierRequestTimeoutError,
  isAbortTimeout,
  isConnectPhaseFailure,
  isDialOutcomeUnknown,
  type CarrierDialNotSentReason,
} from '../carrier-errors.js';
import { redactUrlTail } from '../voicelink/voicelink.adapter.js';
import { acquirePlivoDialSlot, getPlivoDialRateLimiter, type PlivoDialRateLimiter } from './plivo-dial-rate.js';
import { verifyPlivoV3Signature } from './plivo-signature.js';
import { inferPlivoCallbackKind, normalizePlivoCallback, plivoCallEvent } from './plivo.webhook.js';
import { PLIVO_STREAM_CONTENT_TYPE, PLIVO_STREAM_SAMPLE_RATE } from './plivo.media.js';

const log = createChildLogger({ component: 'plivo-adapter' });

/** Count a create-call that did not place a known call (`carrier_dial_refusals_total`), and hand back its error to throw. */
function dialRefused<E>(kind: 'auth_rejected' | 'rate_limited' | 'outcome_unknown' | 'refused' | 'not_sent', err: E): E {
  trackCarrierDialRefusal('plivo', kind);
  return err;
}

/** A dial refused before anything was sent. Counted (`not_sent`) where `initiateCall` throws it. */
function notSent(reason: CarrierDialNotSentReason, detail: string): CarrierDialNotSentError {
  return new CarrierDialNotSentError('plivo', reason, detail);
}

/** The env settings every Plivo adapter shares (`config.telephony.plivo`). */
export interface PlivoSettings {
  /** `PLIVO_WEBHOOK_BASE_URL`: our public base for Plivo's callbacks. Env only. */
  webhookBaseUrl: string;
  /** `PLIVO_CALLS_PER_SECOND`: new calls a second per Plivo account. */
  callsPerSecond: number;
  /** `PLIVO_DIAL_RATE_MAX_WAIT_MS`: the longest a dial waits for a calls-per-second slot. */
  dialRateMaxWaitMs: number;
  /** `PLIVO_REQUEST_TIMEOUT_MS`: each REST request (the create-call included) is abandoned after this. */
  requestTimeoutMs: number;
  /** `PLIVO_RING_TIMEOUT_SECONDS`: how long Plivo lets a dial ring before it gives up. */
  ringTimeoutSeconds: number;
}

export const DEFAULT_PLIVO_SETTINGS: PlivoSettings = {
  webhookBaseUrl: '',
  callsPerSecond: 2,
  dialRateMaxWaitMs: 5_000,
  requestTimeoutMs: 15_000,
  ringTimeoutSeconds: 45,
};

/** What the adapter needs from `fetch`. */
export type PlivoFetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status' | 'text'>>;

export interface PlivoAdapterOptions extends PlivoSettings {
  /** The account's Auth ID (`MA…`/`SA…`), the credential's `account_ref`. */
  authId: string;
  authToken: Secret<string>;
  /** Tokens a rotation retired that are still inside the grace window: signature checks only. */
  previousAuthTokens?: ReadonlyArray<Secret<string>>;
  /** Tests only. */
  fetchImpl?: PlivoFetch;
  /** Tests only: replaces the process-wide limiter. */
  rateLimiter?: PlivoDialRateLimiter;
  /** Tests only. */
  sleep?: (ms: number) => Promise<void>;
}

/** The answer XML for a call we will not bridge (unknown, ending, bad token or signature). */
export const PLIVO_HANGUP_XML = '<Response><Hangup/></Response>';

/** A Plivo call or request id: a UUID in practice. Anything else never reaches a URL. */
const PLIVO_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The default `<Record maxLength>` when the caller names none (Plivo's own default is 60 s). */
const DEFAULT_RECORD_MAX_LENGTH_SECONDS = 4 * 60 * 60;

/** Escape text for an XML attribute value or element body. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const positiveInt = (n: number | undefined): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;

/**
 * The XML Plivo runs on answer: a whole-session `<Record>` when recording, then a
 * bidirectional μ-law `<Stream>` to `streamUrl` that keeps the call up while it runs.
 * Attribute values and the URL are XML-escaped (a URL's `&` is `&amp;`).
 */
export function renderPlivoAnswerXml(streamUrl: string, options: AnswerResponseOptions = {}): string {
  if (!/^wss:\/\//i.test(streamUrl)) throw new Error('Plivo stream URL must be wss://');
  const parts: string[] = ['<Response>'];
  if (options.enableRecording) {
    const maxLength = positiveInt(options.recordingMaxLengthSeconds)
      ?? positiveInt(options.maxDurationSeconds)
      ?? DEFAULT_RECORD_MAX_LENGTH_SECONDS;
    const callback = options.recordingCallbackUrl
      ? ` callbackUrl="${xmlEscape(options.recordingCallbackUrl)}" callbackMethod="POST"`
      : '';
    parts.push(`<Record recordSession="true" redirect="false" maxLength="${maxLength}"${callback} fileFormat="mp3"/>`);
  }
  const streamTimeout = positiveInt(options.maxDurationSeconds);
  parts.push(
    `<Stream bidirectional="true" audioTrack="inbound" keepCallAlive="true"`
    + ` contentType="${xmlEscape(`${PLIVO_STREAM_CONTENT_TYPE};rate=${PLIVO_STREAM_SAMPLE_RATE}`)}"`
    + (streamTimeout ? ` streamTimeout="${streamTimeout}"` : '')
    + `>${xmlEscape(streamUrl)}</Stream>`,
  );
  parts.push('</Response>');
  return parts.join('');
}

/**
 * A phone number as Plivo's `to`/`from` take it: country code and number, digits only.
 * Separators and a leading `+` are dropped (numbers here are E.164, `+919812345678`);
 * anything else (a `sip:` URI, Plivo's `<` multi-dial delimiter, letters) is refused, so a
 * dial can never fan out to more than the one number it names.
 */
export function plivoNumber(raw: string, field: 'to' | 'from'): string {
  const cleaned = (raw ?? '').trim().replace(/[\s\-().]/g, '');
  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^[1-9]\d{6,14}$/.test(digits)) {
    // `to` is the contact's number; `from` is the campaign's caller ID, shared by its dials.
    throw notSent(
      field === 'to' ? 'destination' : 'configuration',
      `'${field}' is not a phone number with its country code`,
    );
  }
  return digits;
}

export class PlivoAdapter implements TelephonyProvider {
  readonly name = 'plivo';
  /**
   * `cancelRinging`: a ringing call is cancelled by its request id
   * (`cancelDialRequest`) and, once Plivo has named it, hung up by its call id.
   * The create-call places the call at once: nothing is queued. `ringTimeoutSeconds`: the
   * `ring_timeout` every dial carries (`PLIVO_RING_TIMEOUT_SECONDS`), so the bridge ends a
   * call whose answer and terminal callbacks never arrived soon after it.
   */
  readonly capabilities: ProviderCapabilities;

  private readonly authId: string;
  private readonly authToken: Secret<string>;
  private readonly previousAuthTokens: ReadonlyArray<Secret<string>>;
  private readonly settings: PlivoSettings;
  private readonly fetchImpl: PlivoFetch;
  private readonly rateLimiter: PlivoDialRateLimiter | undefined;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;

  constructor(opts: PlivoAdapterOptions) {
    if (!/^[A-Za-z0-9]{1,64}$/.test(opts.authId ?? '')) throw new Error('Plivo adapter: the Auth ID is malformed');
    if (!opts.authToken.reveal()) throw new Error('Plivo adapter: no auth token');
    this.authId = opts.authId;
    this.authToken = opts.authToken;
    this.previousAuthTokens = opts.previousAuthTokens ?? [];
    this.capabilities = { cancelRinging: true, queuesOutboundDials: false, ringTimeoutSeconds: opts.ringTimeoutSeconds };
    this.settings = {
      webhookBaseUrl: opts.webhookBaseUrl,
      callsPerSecond: opts.callsPerSecond,
      dialRateMaxWaitMs: opts.dialRateMaxWaitMs,
      requestTimeoutMs: opts.requestTimeoutMs,
      ringTimeoutSeconds: opts.ringTimeoutSeconds,
    };
    this.fetchImpl = opts.fetchImpl ?? (fetch as PlivoFetch);
    this.rateLimiter = opts.rateLimiter;
    this.sleep = opts.sleep;
  }

  private accountUrl(path: string): string {
    return `${PLIVO_API_BASE}/v1/Account/${encodeURIComponent(this.authId)}/${path}`;
  }

  private basicAuth(): string {
    return `Basic ${Buffer.from(`${this.authId}:${this.authToken.reveal()}`).toString('base64')}`;
  }

  /**
   * One request to Plivo, bounded by `requestTimeoutMs` (the body read included). Returns
   * the status and body, or throws: a timeout as {@link CarrierRequestTimeoutError} (its
   * `dialOutcomeUnknown` as the caller says), anything else (network, a redirect) as is.
   */
  private async send(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    operation: string,
    body?: Record<string, unknown>,
    opts: { timeoutMeansMaybePlaced?: boolean } = {},
  ): Promise<{ status: number; text: string }> {
    const timeoutMs = this.settings.requestTimeoutMs;
    let status: number | null = null;
    try {
      const res = await this.fetchImpl(this.accountUrl(path), {
        method,
        headers: {
          Authorization: this.basicAuth(),
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      return { status, text: await res.text() };
    } catch (err) {
      if (!isAbortTimeout(err)) throw err;
      // Headers arrived and said no: a slow body does not make a refusal unknown.
      const maybePlaced = Boolean(opts.timeoutMeansMaybePlaced) && (status === null || (status >= 200 && status < 300));
      log.error({ operation, timeoutMs, status, maybePlaced }, 'Plivo request timed out');
      if (status !== null && !(status >= 200 && status < 300)) {
        return { status, text: '' };
      }
      throw new CarrierRequestTimeoutError(operation, timeoutMs, maybePlaced);
    }
  }

  /** The answer and status URLs must be on our env webhook origin, over https. */
  private checkCallbackUrl(raw: string, field: string): string {
    const base = this.settings.webhookBaseUrl;
    if (!base) throw notSent('configuration', 'PLIVO_WEBHOOK_BASE_URL is not set');
    let url: URL;
    let origin: string;
    try {
      url = new URL(raw);
      origin = new URL(base).origin;
    } catch {
      throw notSent('configuration', `${field} is not a URL`);
    }
    if (url.protocol !== 'https:' || url.origin !== origin) {
      throw notSent('configuration', `${field} is not on PLIVO_WEBHOOK_BASE_URL's origin`);
    }
    return raw;
  }

  /**
   * Place a call. Returns `{ providerCallId: '', providerRequestId: request_uuid }`:
   * Plivo names the call only on its callbacks.
   *
   * Before anything is sent: the numbers are checked (digits only), the callback URLs
   * must be on our webhook origin, and the account's calls-per-second gate must admit the
   * dial within `dialRateMaxWaitMs` ({@link CarrierRateLimitedError} otherwise).
   * `time_limit` (the call's max duration) goes on every dial, so a call our bridge loses
   * track of still ends at Plivo.
   *
   * Outcomes, as the dial path must read them:
   *  - 2xx with a `request_uuid`: placed.
   *  - 401: {@link CarrierAuthRejectedError}; nothing placed, and the credential is refused.
   *  - 429: {@link CarrierRateLimitedError} (`carrier`); nothing placed.
   *  - Any other non-2xx (403 included: Plivo's answer for a destination its geo
   *    permissions do not allow): a plain refusal.
   *  - A timeout, or a 2xx whose body has no readable `request_uuid`: the call may have
   *    been placed (`dialOutcomeUnknown`); never retried here.
   *
   *  - The connection failed before the request was written (DNS, TCP connect, TLS
   *    certificate: `isConnectPhaseFailure`): {@link CarrierDialNotSentError} (`network`).
   *  - Any other network error (a reset, a closed socket): the request may have reached
   *    Plivo, so the call may be placed ({@link CarrierDialOutcomeUnknownError}).
   *
   * A dial refused before anything is sent (a malformed number, no webhook base, a callback
   * URL off it, no max duration) rejects with {@link CarrierDialNotSentError}: an unplaced
   * leg, never charged to the contact as a carrier refusal. A dial whose `req.signal` is
   * aborted before the create-call is sent (the call was torn down while it waited at the
   * gate) sends nothing and rejects with {@link CarrierDialAbortedError}: an unplaced leg,
   * not a refusal, and not counted.
   *
   * Each of these but a placed call and an aborted one counts once in
   * `carrier_dial_refusals_total{provider="plivo"}`, by kind (`not_sent` for a dial refused
   * before sending).
   */
  async initiateCall(req: OutboundCallRequest): Promise<InitiateCallResult> {
    let to: string;
    let from: string;
    let answerUrl: string;
    let statusUrl: string;
    let timeLimit: number | undefined;
    try {
      to = plivoNumber(req.to, 'to');
      from = plivoNumber(req.from, 'from');
      answerUrl = this.checkCallbackUrl(req.webhookUrl, 'answer_url');
      statusUrl = this.checkCallbackUrl(req.statusCallbackUrl, 'hangup_url');
      timeLimit = positiveInt(req.maxDuration);
      if (!timeLimit) throw notSent('configuration', 'no max duration for time_limit');
    } catch (err) {
      throw dialRefused('not_sent', err);
    }
    if (req.signal?.aborted) throw new CarrierDialAbortedError('plivo');

    const gate = await acquirePlivoDialSlot(this.rateLimiter ?? getPlivoDialRateLimiter(), this.authId, {
      perSecond: this.settings.callsPerSecond,
      maxWaitMs: this.settings.dialRateMaxWaitMs,
      ...(this.sleep ? { sleep: this.sleep } : {}),
    });
    if (!gate.admitted) {
      log.warn({ callId: req.callId, waitedMs: gate.waitedMs }, 'Plivo dial not sent: no calls-per-second slot in time');
      throw dialRefused('rate_limited', new CarrierRateLimitedError('plivo', 'local_gate', gate.waitedMs));
    }
    // The wait at the gate can be long (`dialRateMaxWaitMs`): a call torn down meanwhile
    // must not ring a customer for nobody. Nothing has been sent yet.
    if (req.signal?.aborted) {
      log.info({ callId: req.callId, waitedMs: gate.waitedMs }, 'Plivo dial not sent: the call ended while it waited for a calls-per-second slot');
      throw new CarrierDialAbortedError('plivo');
    }

    const body = {
      from,
      to,
      answer_url: answerUrl,
      answer_method: 'POST',
      hangup_url: statusUrl,
      hangup_method: 'POST',
      ring_url: statusUrl,
      ring_method: 'POST',
      time_limit: timeLimit,
      ring_timeout: this.settings.ringTimeoutSeconds,
    };
    log.info(
      {
        callId: req.callId,
        to,
        from,
        answerUrl: redactUrlTail(answerUrl),
        statusUrl: redactUrlTail(statusUrl),
        timeLimit,
        rateWaitMs: gate.waitedMs,
      },
      'Initiating Plivo call',
    );

    let answer: { status: number; text: string };
    try {
      answer = await this.send('POST', 'Call/', 'Plivo create call', body, { timeoutMeansMaybePlaced: true });
    } catch (err) {
      if (isDialOutcomeUnknown(err)) throw dialRefused('outcome_unknown', err);
      // Not a timeout (`send` turned those into the error above). A connection that never
      // got as far as writing the request placed nothing; anything else (a reset, a
      // socket closed under the response) may have reached Plivo after the request did.
      if (isConnectPhaseFailure(err)) {
        log.warn({ err, callId: req.callId }, 'Plivo dial not sent: the API could not be reached');
        throw dialRefused('not_sent', new CarrierDialNotSentError('plivo', 'network', 'the carrier API could not be reached'));
      }
      log.error({ err, callId: req.callId }, 'Plivo create call failed on the network; the call may be placed');
      throw dialRefused('outcome_unknown', new CarrierDialOutcomeUnknownError(
        'Plivo create call failed on the network after it may have been sent; the call may be placed',
        { cause: err },
      ));
    }
    const { status, text } = answer;
    if (status === 401) throw dialRefused('auth_rejected', new CarrierAuthRejectedError('plivo', status));
    if (status === 429) throw dialRefused('rate_limited', new CarrierRateLimitedError('plivo', 'carrier', 0));
    if (status < 200 || status >= 300) {
      throw dialRefused('refused', new Error(`Plivo create call error ${status}: ${text.slice(0, 300)}`));
    }
    let requestUuid: unknown;
    try {
      const parsed = JSON.parse(text) as { request_uuid?: unknown };
      requestUuid = Array.isArray(parsed.request_uuid) && parsed.request_uuid.length === 1
        ? parsed.request_uuid[0]
        : parsed.request_uuid;
    } catch {
      requestUuid = undefined;
    }
    if (typeof requestUuid !== 'string' || !PLIVO_ID.test(requestUuid)) {
      throw dialRefused('outcome_unknown', new CarrierDialOutcomeUnknownError(
        `Plivo create call answered ${status} without a readable request_uuid; the call may be placed`,
      ));
    }
    log.info({ callId: req.callId, requestUuid }, 'Plivo call dispatched');
    return { providerCallId: '', providerRequestId: requestUuid };
  }

  private requireId(id: string, what: string): string {
    if (typeof id !== 'string' || !PLIVO_ID.test(id)) {
      // An empty id would address every call on the account: never build that URL.
      throw new Error(`Plivo ${what} refused: ${id ? 'malformed' : 'empty'} id`);
    }
    return id;
  }

  /** Hang up a call by its `call_uuid`. Already gone (404) resolves. Throws on an empty id. */
  async endCall(providerCallId: string): Promise<void> {
    const id = this.requireId(providerCallId, 'hangup');
    const { status, text } = await this.send('DELETE', `Call/${encodeURIComponent(id)}/`, 'Plivo hangup');
    if (status === 204 || status === 404 || (status >= 200 && status < 300)) return;
    if (status === 401) throw new CarrierAuthRejectedError('plivo', status);
    throw new Error(`Plivo hangup error ${status}: ${text.slice(0, 300)}`);
  }

  /** Cancel a dial not yet answered, by its `request_uuid`. Throws on an empty id. */
  async cancelDialRequest(providerRequestId: string): Promise<'canceled' | 'not_found'> {
    const id = this.requireId(providerRequestId, 'cancel');
    const { status, text } = await this.send('DELETE', `Request/${encodeURIComponent(id)}/`, 'Plivo cancel request');
    if (status === 404) return 'not_found';
    if (status >= 200 && status < 300) return 'canceled';
    if (status === 401) throw new CarrierAuthRejectedError('plivo', status);
    throw new Error(`Plivo cancel request error ${status}: ${text.slice(0, 300)}`);
  }

  async getMediaStreamConfig(_providerCallId: string): Promise<MediaStreamConfig> {
    return { type: 'websocket', codec: 'pcmu', sampleRate: PLIVO_STREAM_SAMPLE_RATE, direction: 'both' };
  }

  /** `rawBody` is the callback's form params; the kind is inferred (recording, else status). */
  parseWebhookEvent(rawBody: unknown, _headers: Record<string, string>): CallEvent {
    const params = (rawBody ?? {}) as Record<string, string>;
    const n = normalizePlivoCallback(inferPlivoCallbackKind(params), params);
    const event = plivoCallEvent(n, '');
    if (event) return event;
    return {
      providerCallId: n.callUuid,
      callId: '',
      provider: 'plivo',
      eventType: 'error',
      timestamp: new Date(),
      metadata: { informational: true, rawEvent: n.kind, rawCallStatus: n.callStatus, recordingUrl: n.recordingUrl },
    };
  }

  generateAnswerResponse(_callId: string, streamUrl: string, options?: AnswerResponseOptions): string {
    return renderPlivoAnswerXml(streamUrl, options);
  }

  generateAnnouncementResponse(_params: AnnouncementResponseParams): string {
    // Clips are played over the media socket (`playAudio`), never by answer XML.
    return '';
  }

  generateIvrResponse(_steps: IvrStepRenderParams[]): string {
    throw new Error('IVR not supported for plivo');
  }

  /** The call's CDR. Best effort: `unknown` on a miss or any error. */
  async getCallStatus(providerCallId: string): Promise<ProviderCallStatus> {
    if (!PLIVO_ID.test(providerCallId ?? '')) return { status: 'unknown' };
    try {
      const { status, text } = await this.send('GET', `Call/${encodeURIComponent(providerCallId)}/`, 'Plivo get call');
      if (status < 200 || status >= 300) return { status: 'unknown' };
      const cdr = JSON.parse(text) as {
        call_status?: string; call_duration?: number; hangup_cause_name?: string; hangup_cause_code?: number | string;
      };
      return {
        status: (cdr.call_status || 'unknown').toLowerCase(),
        ...(typeof cdr.call_duration === 'number' ? { duration: cdr.call_duration } : {}),
        ...(cdr.hangup_cause_code !== undefined ? { errorCode: String(cdr.hangup_cause_code) } : {}),
        ...(cdr.hangup_cause_name ? { errorMessage: cdr.hangup_cause_name } : {}),
      };
    } catch (err) {
      log.warn({ err, providerCallId }, 'Plivo CDR fetch failed');
      return { status: 'unknown' };
    }
  }

  /**
   * The call's first recording URL (`GET …/Recording/?call_uuid=`), or null. The URL is
   * Plivo's; fetching it is the recording proxy's job, with its own host allow-list.
   */
  async getRecordingUrl(providerCallId: string): Promise<string | null> {
    if (!PLIVO_ID.test(providerCallId ?? '')) return null;
    try {
      const { status, text } = await this.send(
        'GET', `Recording/?call_uuid=${encodeURIComponent(providerCallId)}`, 'Plivo list recordings',
      );
      if (status < 200 || status >= 300) return null;
      const list = JSON.parse(text) as { objects?: Array<{ recording_url?: unknown }> };
      const url = list.objects?.find((o) => typeof o.recording_url === 'string' && o.recording_url)?.recording_url;
      return typeof url === 'string' ? url : null;
    } catch (err) {
      log.warn({ err, providerCallId }, 'Plivo recording lookup failed');
      return null;
    }
  }

  /** Plivo's signature covers the URL and a nonce, which this signature cannot carry. */
  validateWebhookSignature(_rawBody: string, _signature: string): boolean {
    return false;
  }

  /** V3 signature against the current auth token and those still inside the rotation grace. */
  verifyCarrierRequest(req: CarrierHttpRequest): boolean {
    return verifyPlivoV3Signature(
      [this.authToken.reveal(), ...this.previousAuthTokens.map((t) => t.reveal())],
      req,
    );
  }
}

/**
 * The transport adapters built by {@link createPlivoAdapter} send their requests through.
 * Null (production): the global `fetch`. Only a test sets it, to the mock carrier
 * (`test/mocks/plivo`), which serves Plivo's own paths: every URL is still built on the
 * fixed `PLIVO_API_BASE`, so this moves no host and no configuration can reach it.
 */
let transport: PlivoFetch | null = null;

/** Tests only: route new Plivo adapters' requests through `fetchImpl` (null restores `fetch`). */
export function setPlivoTransportForTests(fetchImpl: PlivoFetch | null): void {
  transport = fetchImpl;
}

/** The BYOC factory: a Plivo adapter on the credential's account, with the env settings. */
export function createPlivoAdapter(credential: ResolvedCredential, config: AppConfig): PlivoAdapter {
  const token = credential.secret.reveal()['auth_token'];
  if (!token) throw new Error(`Telephony credential ${credential.id} has no auth_token`);
  const previous = credential.previous
    .map((p) => p.secret.reveal()['auth_token'])
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map((t) => new Secret(t));
  return new PlivoAdapter({
    ...DEFAULT_PLIVO_SETTINGS,
    ...config.telephony.plivo,
    authId: credential.accountRef,
    authToken: new Secret(token),
    previousAuthTokens: previous,
    ...(transport ? { fetchImpl: transport } : {}),
  });
}
