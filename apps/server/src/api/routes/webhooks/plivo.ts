// Plivo's callbacks for a bridge leg, under `/api/v1/webhooks/plivo` (registered by
// `webhooks.routes.ts`, whose plugin-scoped form parser reads their bodies):
//
//   POST /plivo/webrtc-answer/:callId     answer_url: we reply with XML (stream, recording)
//   POST /plivo/webrtc-status/:callId     ring_url and hangup_url: `CallStatus`
//   POST /plivo/webrtc-recording/:callId  the `<Record callbackUrl>`: `RecordUrl`
//
// Every one is checked twice before it can touch a call: the purpose-bound webhook token
// in its URL (`?token=`, as VoiceLink's status webhook), AND Plivo's V3 signature against
// the account the call was placed on (the credential pinned on it, resolved for
// `call_control`; for a callback after teardown, read off the call row). The signature
// covers the exact URL Plivo was given, so it is rebuilt by the function that built that
// URL at dial time (`carrierCallbackUrl`, `core/bridge/carrier-urls.ts`): env's
// `PLIVO_WEBHOOK_BASE_URL` as written, the route's own suffix and call id, and the
// request's query. Never from a Host header, and never from the path the request arrived
// on (a reverse proxy may strip a prefix of it). A refused answer callback is answered
// with a hangup, so a call we will not bridge is put down rather than left on the line.
//
// A signed callback is accepted once: its nonce is recorded for the call in Redis
// (`claimCallbackNonce`, wherever the callback is handled, so in the worker that holds the
// call when it is forwarded), and a repeat of the same (call, nonce) is refused as a
// replay. A callback that fails to process gives its nonce back, so Plivo's retry of it is
// not a replay. Redis failing fails open, with a log line.
//
// With media workers (`docs/scaling.md` §3.2) a callback whose URL carries `w` runs in the
// worker that slot names, where the call lives: the route hands its parsed input to the
// forwarder (`cluster/media-cluster.ts`, IPC `carrier.plivo_callback`) and answers with
// what the worker answered, XML included. No hint, or a worker gone, runs it here on the
// session-less bridge (a status or recording then takes the late path off the call row).
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../../../config/index.js';
import type { WebRtcBridgeManager } from '../../../core/webrtc-bridge-manager.js';
import { carrierCallbackUrl, type CarrierCallbackRoute } from '../../../core/bridge/carrier-urls.js';
import { PLIVO_HANGUP_XML } from '../../../telephony/plivo/plivo.adapter.js';
import {
  PLIVO_SIGNATURE_V3_HEADER, PLIVO_SIGNATURE_V3_NONCE_HEADER, headerValue,
} from '../../../telephony/plivo/plivo-signature.js';
import {
  normalizePlivoCallback, plivoCallEvent, type PlivoCallbackKind,
} from '../../../telephony/plivo/plivo.webhook.js';

const log = createChildLogger({ component: 'plivo-webhooks' });

const PROVIDER = 'plivo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Plivo callback after the route's parsing: plain data, so the process holding the call can run it. */
export interface PlivoCallbackInput {
  kind: PlivoCallbackKind;
  callId: string;
  /** The `token` query parameter. */
  token: string | undefined;
  /** The public URL Plivo called (`carrierCallbackUrl`: env base, route, call id, query): the signature's subject. */
  url: string;
  /** The form params, one string per key. */
  params: Record<string, string>;
  /** Only the two V3 signature headers ({@link signatureHeaders}). */
  headers: Record<string, string | undefined>;
}

/** What Plivo is answered with. */
export interface PlivoCallbackAnswer {
  statusCode: number;
  contentType: 'text/xml' | 'application/json';
  body: string;
}

/** The answer callback's refusal: hang the call up. */
export const PLIVO_HANGUP_ANSWER: PlivoCallbackAnswer = { statusCode: 200, contentType: 'text/xml', body: PLIVO_HANGUP_XML };
const HANGUP = PLIVO_HANGUP_ANSWER;
const OK: PlivoCallbackAnswer = { statusCode: 200, contentType: 'application/json', body: '{"status":true}' };
const FORBIDDEN: PlivoCallbackAnswer = { statusCode: 403, contentType: 'application/json', body: '{"status":false}' };
const UNAVAILABLE: PlivoCallbackAnswer = { statusCode: 503, contentType: 'application/json', body: '{"status":false}' };

/**
 * A callback that could not be processed: the answer callback hangs the call up (no XML
 * would leave Plivo to its own fallback), the others are 503, never a 200 for a post
 * that was not processed.
 */
export function plivoCallbackUnavailable(kind: PlivoCallbackKind): PlivoCallbackAnswer {
  return kind === 'answer' ? HANGUP : UNAVAILABLE;
}

/**
 * With media workers: run a callback in the worker its URL's `w` names. Returns null to
 * handle it in this process instead (no hint). Unset in one process.
 */
export type PlivoCallbackForwarder = (
  input: PlivoCallbackInput & { hint: string | undefined },
) => Promise<PlivoCallbackAnswer | null>;

/** The headers the signature check reads, and no other (they are what crosses to a worker). */
export function signatureHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [PLIVO_SIGNATURE_V3_HEADER, PLIVO_SIGNATURE_V3_NONCE_HEADER]) {
    const v = headers[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}

/** A refusal: the answer callback hangs the call up, the others are 403. */
function refuse(kind: PlivoCallbackKind): PlivoCallbackAnswer {
  return kind === 'answer' ? HANGUP : FORBIDDEN;
}

/**
 * Handle one Plivo callback: verify the webhook token and the signature, then hand it to
 * the bridge. Never throws for a bad request (each is refused); a fault reading the call
 * answers the answer callback with a hangup and the others with 503.
 */
export async function handlePlivoCallback(
  bridge: WebRtcBridgeManager,
  input: PlivoCallbackInput,
): Promise<PlivoCallbackAnswer> {
  const { kind, callId } = input;
  /** The nonce this request claimed, given back if it fails to process. */
  let nonce: string | null = null;
  if (!UUID.test(callId)) {
    log.warn({ kind }, 'Plivo callback for a malformed call id — refusing');
    return refuse(kind);
  }
  try {
    if (!await bridge.verifyWsToken(callId, input.token, 'webhook')) {
      log.warn({ callId, kind }, 'Plivo callback with an invalid webhook token — refusing');
      return refuse(kind);
    }
    const adapter = await bridge.carrierCallbackAdapter(callId, PROVIDER);
    if (!adapter) {
      log.warn({ callId, kind }, 'Plivo callback for a call with no Plivo account to check it against — refusing');
      return refuse(kind);
    }
    // Plivo signs every callback: an adapter that cannot check one refuses it.
    const signed = adapter.verifyCarrierRequest?.({ method: 'POST', url: input.url, params: input.params, headers: input.headers }) === true;
    if (!signed) {
      log.warn({ callId, kind }, 'Plivo callback with a signature that does not verify — refusing');
      return refuse(kind);
    }
    // A verified signature has a nonce (`verifyPlivoV3Signature` refuses one without).
    nonce = headerValue(input.headers, PLIVO_SIGNATURE_V3_NONCE_HEADER) ?? '';
    if (!await bridge.claimCallbackNonce(callId, nonce)) {
      nonce = null;
      log.warn({ callId, kind }, 'Plivo callback whose signed nonce this call has already seen (a replay) — refusing');
      return refuse(kind);
    }

    const n = normalizePlivoCallback(kind, input.params);
    switch (kind) {
      case 'answer': {
        const event = plivoCallEvent(n, callId);
        const plan = event ? await bridge.answerCarrierCall(callId, event, PROVIDER) : null;
        if (!plan) return HANGUP;
        const xml = adapter.generateAnswerResponse(callId, plan.streamUrl, {
          enableRecording: plan.enableRecording,
          ...(plan.recordingCallbackUrl ? { recordingCallbackUrl: plan.recordingCallbackUrl } : {}),
          ...(plan.maxDurationSeconds ? { recordingMaxLengthSeconds: plan.maxDurationSeconds, maxDurationSeconds: plan.maxDurationSeconds } : {}),
        });
        log.info({ callId, record: plan.enableRecording }, 'Plivo answer callback — streaming the call to the bridge');
        return { statusCode: 200, contentType: 'text/xml', body: xml };
      }
      case 'status': {
        const event = plivoCallEvent(n, callId);
        log.info({ callId, callStatus: n.callStatus, eventType: event?.eventType }, 'Plivo status callback received');
        if (event) await bridge.handleCarrierStatus(callId, event, PROVIDER);
        return OK;
      }
      case 'recording': {
        log.info({ callId, recordingId: n.recordingId }, 'Plivo recording callback received');
        if (n.recordingUrl) {
          await bridge.handleCarrierRecording(callId, PROVIDER, { recordingUrl: n.recordingUrl, carrierCallId: n.callUuid });
        }
        return OK;
      }
    }
  } catch (err) {
    log.error({ err, callId, kind }, 'Plivo callback failed');
    if (nonce !== null) await bridge.releaseCallbackNonce(callId, nonce);
    return plivoCallbackUnavailable(kind);
  }
}

/** Form params as one string per key (a repeated key keeps its first value). */
function formParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  return out;
}

/** Each callback kind's route under the Plivo namespace, as the dial named it. */
const ROUTE_OF: Record<PlivoCallbackKind, CarrierCallbackRoute> = {
  answer: 'webrtc-answer',
  status: 'webrtc-status',
  recording: 'webrtc-recording',
};

/**
 * The URL Plivo was handed for this callback, and so the one it signed: rebuilt from env's
 * base by the dial's own builder, with the request's query as it arrived. Null when
 * `PLIVO_WEBHOOK_BASE_URL` is unset or not an absolute URL (no dial could have named it).
 */
export function plivoCallbackPublicUrl(
  base: string,
  kind: PlivoCallbackKind,
  callId: string,
  requestUrl: string,
): string | null {
  if (!base) return null;
  try {
    new URL(base);
  } catch {
    return null;
  }
  const q = requestUrl.indexOf('?');
  return carrierCallbackUrl(base, ROUTE_OF[kind], callId, q >= 0 ? requestUrl.slice(q) : '');
}

export function registerPlivoWebhookRoutes(
  app: FastifyInstance,
  opts: {
    webrtcBridge: WebRtcBridgeManager | null | undefined;
    /** The media-worker forwarder, read per request (set once the cluster starts); null in one process. */
    forwarder: () => PlivoCallbackForwarder | null;
    /** `PLIVO_WEBHOOK_BASE_URL`; read per request (tests set it). */
    webhookBaseUrl?: () => string;
  },
): void {
  const baseUrl = opts.webhookBaseUrl ?? (() => config.telephony.plivo.webhookBaseUrl);
  const route = (kind: PlivoCallbackKind, path: string): void => {
    app.post(path, async (
      request: FastifyRequest<{ Params: { callId: string }; Querystring: { token?: string; w?: string } }>,
      reply: FastifyReply,
    ) => {
      const send = (a: PlivoCallbackAnswer) => reply.code(a.statusCode).type(a.contentType).send(a.body);
      const { callId } = request.params;
      const bridge = opts.webrtcBridge;
      if (!bridge) return send(refuse(kind));
      const url = plivoCallbackPublicUrl(baseUrl(), kind, callId, request.url);
      if (!url) {
        log.error({ callId, kind }, 'PLIVO_WEBHOOK_BASE_URL is not set: a Plivo callback cannot be verified — refusing');
        return send(refuse(kind));
      }
      const input: PlivoCallbackInput = {
        kind,
        callId,
        token: request.query?.token,
        url,
        params: formParams(request.body),
        headers: signatureHeaders(request.headers),
      };
      const forwarder = opts.forwarder();
      const forwarded = forwarder ? await forwarder({ ...input, hint: request.query?.w }) : null;
      return send(forwarded ?? await handlePlivoCallback(bridge, input));
    });
  };
  route('answer', `/plivo/${ROUTE_OF.answer}/:callId`);
  route('status', `/plivo/${ROUTE_OF.status}/:callId`);
  route('recording', `/plivo/${ROUTE_OF.recording}/:callId`);
}
