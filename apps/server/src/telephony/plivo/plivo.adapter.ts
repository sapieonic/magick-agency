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
  StartRecordingRequest,
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
  CarrierDialRefusedError,
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
import type { PlivoInboundUrls } from './inbound-urls.js';
import {
  PLIVO_APP_ID,
  PLIVO_APPLICATIONS_MAX_PAGES,
  PLIVO_APPLICATIONS_PAGE_SIZE,
  PlivoApiError,
  plivoCreateApplicationBody,
  plivoNumberAppBody,
  plivoStartRecordingBody,
  plivoStatusFailure,
  plivoUpdateApplicationBody,
  readPlivoApplication,
  readPlivoApplicationPage,
  readPlivoCreatedApplication,
  readPlivoNumberApp,
  readPlivoRecordingStarted,
  type PlivoApplication,
} from './plivo-inbound.wire.js';

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

/**
 * The CDR's `call_state` values that already name a state in the status vocabulary the bridge
 * reads (`getCallStatus`, its ring deadline's `RING_DEADLINE_CARRIER_ENDED`), once lower-cased
 * with `_` and spaces read as `-` (`NO_ANSWER` → `no-answer`).
 */
const CDR_STATES = new Set(['busy', 'failed', 'no-answer', 'timeout', 'cancel', 'canceled', 'completed']);

/**
 * A CDR hangup cause name that says how an unanswered call ended, lower-cased: the names
 * Plivo's hangup callbacks carry (`HangupCauseName`, `plivo-carrier.fixture.json`), the one
 * catalogue its CDR's `hangup_cause_name` is read against.
 */
const CDR_CAUSES: ReadonlyMap<string, string> = new Map([
  ['busy line', 'busy'],
  ['no answer', 'no-answer'],
  ['ring timeout reached', 'no-answer'],
  ['cancelled', 'cancel'],
  ['canceled', 'cancel'],
  ['rejected', 'cancel'],
]);

/** A timestamp that parses and is not a zero placeholder. */
function isCdrInstant(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw === '') return false;
  const t = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  return Number.isFinite(t) && t > 0;
}

/**
 * Read Plivo's answer to `GET Call/{call_uuid}/` ("retrieve a call": the call detail record,
 * the SDK's `RetrieveCallResponse`). Its state is `call_state`; `call_status` belongs to the
 * live-call answer (`?status=live`, `GetLiveCallResponse`) and is not read here. The status is
 * in the vocabulary the bridge reads:
 *  - 404: no CDR, because the call is still live (or its CDR is not written yet): `live`,
 *    which is not an ended state;
 *  - any other non-2xx, or a body that is not a JSON object: `unknown`;
 *  - `call_state` that names a state of the vocabulary (`CDR_STATES`): that state;
 *  - otherwise an answered call (`answer_time` set): `completed`; an unanswered one: the state
 *    its `hangup_cause_name` names (`CDR_CAUSES`), else `failed` when it has ended (`end_time`
 *    or a hangup cause), else `unknown`.
 * The SDK names the fields but not `call_state`'s values: the live check (Plivo step 5)
 * confirms them (`docs/status.md`).
 */
export function readPlivoCallDetailRecord(httpStatus: number, text: string): ProviderCallStatus {
  if (httpStatus === 404) return { status: 'live' };
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'unknown' };
  let cdr: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unknown' };
    cdr = parsed as Record<string, unknown>;
  } catch {
    return { status: 'unknown' };
  }
  const str = (k: string): string => (typeof cdr[k] === 'string' ? (cdr[k] as string) : '');
  const state = str('call_state').trim().toLowerCase().replace(/[_\s]+/g, '-');
  const causeName = str('hangup_cause_name');
  const causeCode = cdr['hangup_cause_code'];
  let status: string;
  if (CDR_STATES.has(state)) status = state;
  else if (isCdrInstant(cdr['answer_time'])) status = 'completed';
  else status = CDR_CAUSES.get(causeName.trim().toLowerCase())
    ?? (isCdrInstant(cdr['end_time']) || causeName !== '' ? 'failed' : 'unknown');
  const duration = typeof cdr['call_duration'] === 'number' ? cdr['call_duration'] : Number(str('call_duration') || NaN);
  return {
    status,
    ...(Number.isFinite(duration) ? { duration } : {}),
    ...(typeof causeCode === 'number' || (typeof causeCode === 'string' && causeCode !== '') ? { errorCode: String(causeCode) } : {}),
    ...(causeName ? { errorMessage: causeName } : {}),
  };
}

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
   * call whose answer and terminal callbacks never arrived soon after it. `recordsOnDemand`: a
   * live call is recorded from now on with the Record API ({@link startRecording}).
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
    this.capabilities = {
      cancelRinging: true, queuesOutboundDials: false, ringTimeoutSeconds: opts.ringTimeoutSeconds, recordsOnDemand: true,
    };
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
   *    permissions do not allow): {@link CarrierDialRefusedError}, carrying the status, so
   *    the refusal breaker can tell a 4xx about the account from a 5xx outage (PL11).
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
      throw dialRefused('refused', new CarrierDialRefusedError('plivo', status, `Plivo create call error ${status}: ${text.slice(0, 300)}`));
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

  /**
   * The call's state, from its CDR (`GET Call/{call_uuid}/`, read by
   * {@link readPlivoCallDetailRecord}). Only the ring deadline asks, and only whether the call
   * has ended and how, so the live-call endpoint (`?status=live`) is not queried: a call still
   * live has no CDR (404, read as `live`: not ended). Best effort: `unknown` on any error.
   */
  async getCallStatus(providerCallId: string): Promise<ProviderCallStatus> {
    if (!PLIVO_ID.test(providerCallId ?? '')) return { status: 'unknown' };
    try {
      const { status, text } = await this.send('GET', `Call/${encodeURIComponent(providerCallId)}/`, 'Plivo get call');
      return readPlivoCallDetailRecord(status, text);
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

  // ── Inbound: the Application and numbers' apps (docs/inbound.md §8.1) ─────────────────
  // Request and response shapes: `plivo-inbound.wire.ts` (unverified until P0). Every failure
  // is a `PlivoApiError` (`auth_rejected`, `unreachable`, `refused`); a 404 the operation reads
  // as "gone" is an answer, not a failure. Nothing here is retried: the inbound service decides.

  /** One inbound REST request; any transport failure (timeout, network) is `unreachable`. */
  private async inboundRequest(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    operation: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> {
    try {
      return await this.send(method, path, operation, body);
    } catch (err) {
      log.warn({ err, operation }, 'Plivo inbound request failed before an answer');
      throw new PlivoApiError('unreachable', operation, null, 'Plivo could not be reached');
    }
  }

  /** `Number/{digits}/` for an E.164 number; a malformed one never reaches a URL. */
  private numberPath(e164: string, operation: string): string {
    try {
      return `Number/${plivoNumber(e164, 'from')}/`;
    } catch {
      throw new PlivoApiError('refused', operation, null, 'malformed phone number');
    }
  }

  private appPath(appId: string): string {
    if (!PLIVO_APP_ID.test(appId ?? '')) throw new PlivoApiError('refused', 'Plivo application', null, 'malformed application id');
    return `Application/${encodeURIComponent(appId)}/`;
  }

  /** Create the inbound Application; its id. The answer and hangup URLs carry `token`. */
  async createInboundApplication(appName: string, urls: PlivoInboundUrls, token: string): Promise<string> {
    const op = 'Plivo create application';
    const { status, text } = await this.inboundRequest('POST', 'Application/', op, plivoCreateApplicationBody(appName, urls, token));
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    const appId = readPlivoCreatedApplication(text);
    if (!appId) throw new PlivoApiError('refused', op, status, 'Plivo created an application without a readable app_id');
    return appId;
  }

  /** The Application as Plivo holds it; null when Plivo has no such Application (404). */
  async getInboundApplication(appId: string): Promise<PlivoApplication | null> {
    const op = 'Plivo get application';
    const { status, text } = await this.inboundRequest('GET', this.appPath(appId), op);
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    const app = readPlivoApplication(text);
    if (!app) throw new PlivoApiError('refused', op, status, 'Plivo sent an unreadable application');
    return app;
  }

  /** Point the Application at `urls` with `token`; `not_found` when Plivo has no such Application. */
  async updateInboundApplication(appId: string, urls: PlivoInboundUrls, token: string): Promise<'updated' | 'not_found'> {
    const op = 'Plivo update application';
    const { status, text } = await this.inboundRequest('POST', this.appPath(appId), op, plivoUpdateApplicationBody(urls, token));
    if (status === 404) return 'not_found';
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    return 'updated';
  }

  /** Delete the Application; `not_found` when it is already gone. */
  async deleteInboundApplication(appId: string): Promise<'deleted' | 'not_found'> {
    const op = 'Plivo delete application';
    const { status, text } = await this.inboundRequest('DELETE', this.appPath(appId), op);
    if (status === 404) return 'not_found';
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    return 'deleted';
  }

  /**
   * The ids of the account's Applications named exactly `appName`, page by page (the next
   * page's URL built from the offset, never taken from the response). Bounded: past
   * `PLIVO_APPLICATIONS_MAX_PAGES` pages the rest is not read (logged).
   */
  async findInboundApplications(appName: string): Promise<string[]> {
    const op = 'Plivo list applications';
    const found: string[] = [];
    for (let page = 0; page < PLIVO_APPLICATIONS_MAX_PAGES; page++) {
      const path = `Application/?app_name=${encodeURIComponent(appName)}&limit=${PLIVO_APPLICATIONS_PAGE_SIZE}`
        + `&offset=${page * PLIVO_APPLICATIONS_PAGE_SIZE}`;
      const { status, text } = await this.inboundRequest('GET', path, op);
      if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
      const read = readPlivoApplicationPage(text);
      if (!read) throw new PlivoApiError('refused', op, status, 'Plivo sent an unreadable application list');
      for (const app of read.apps) if (app.appName === appName) found.push(app.appId);
      if (!read.more) return found;
    }
    log.warn({ operation: op, pages: PLIVO_APPLICATIONS_MAX_PAGES }, 'Plivo application list longer than the pages read — an Application by this name past them is not found');
    return found;
  }

  /** The app number `e164` is on (null: none), or null when the account has no such number. */
  async getNumberApp(e164: string): Promise<{ appId: string | null } | null> {
    const op = 'Plivo get number';
    const { status, text } = await this.inboundRequest('GET', this.numberPath(e164, op), op);
    if (status === 404) return null;
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    const app = readPlivoNumberApp(text);
    if (!app) throw new PlivoApiError('refused', op, status, 'Plivo sent an unreadable number');
    return app;
  }

  /** Put number `e164` on app `appId` (null: none); `not_found` when the account has no such number. */
  async setNumberApp(e164: string, appId: string | null): Promise<'updated' | 'not_found'> {
    const op = 'Plivo update number';
    const path = this.numberPath(e164, op);
    if (appId !== null && !PLIVO_APP_ID.test(appId)) throw new PlivoApiError('refused', op, null, 'malformed application id');
    const { status, text } = await this.inboundRequest('POST', path, op, plivoNumberAppBody(appId));
    if (status === 404) return 'not_found';
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    return 'updated';
  }

  /**
   * Record a live call from now on (`POST Call/{call_uuid}/Record/`, the Record API; shapes in
   * `plivo-inbound.wire.ts`, unverified until P0): an mp3 of at most `timeLimitSeconds`, posted to
   * `callbackUrl` when ready. The callback URL must be on our webhook origin over https, as the
   * dial's are. Resolves Plivo's recording id (null when its answer names none); throws a
   * `PlivoApiError` on a refusal or no answer, and on a malformed call id or callback URL.
   */
  async startRecording(carrierCallId: string, req: StartRecordingRequest): Promise<{ recordingId: string | null }> {
    const op = 'Plivo record call';
    if (!PLIVO_ID.test(carrierCallId ?? '')) throw new PlivoApiError('refused', op, null, 'malformed call id');
    let callbackUrl: string;
    try {
      callbackUrl = this.checkCallbackUrl(req.callbackUrl, 'callback_url');
    } catch (err) {
      throw new PlivoApiError('refused', op, null, err instanceof Error ? err.message : 'callback_url refused');
    }
    const timeLimit = positiveInt(req.timeLimitSeconds);
    if (!timeLimit) throw new PlivoApiError('refused', op, null, 'no time limit');
    const { status, text } = await this.inboundRequest(
      'POST', `Call/${encodeURIComponent(carrierCallId)}/Record/`, op, plivoStartRecordingBody(callbackUrl, timeLimit),
    );
    if (status < 200 || status >= 300) throw plivoStatusFailure(op, status, text);
    return { recordingId: readPlivoRecordingStarted(text)?.recordingId ?? null };
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
