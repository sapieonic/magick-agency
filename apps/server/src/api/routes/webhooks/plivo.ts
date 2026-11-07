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
// covers the exact URL Plivo was given, so it is rebuilt from env
// (`PLIVO_WEBHOOK_BASE_URL`'s origin) and the request's own path and query, never from a
// Host header. A refused answer callback is answered with a hangup, so a call we will not
// bridge is put down rather than left on the line.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { config } from '../../../config/index.js';
import type { WebRtcBridgeManager } from '../../../core/webrtc-bridge-manager.js';
import { PLIVO_HANGUP_XML } from '../../../telephony/plivo/plivo.adapter.js';
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
  /** The public URL Plivo called (our env origin + the request's path and query): the signature's subject. */
  url: string;
  /** The form params, one string per key. */
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
}

/** What Plivo is answered with. */
export interface PlivoCallbackAnswer {
  statusCode: number;
  contentType: 'text/xml' | 'application/json';
  body: string;
}

const HANGUP: PlivoCallbackAnswer = { statusCode: 200, contentType: 'text/xml', body: PLIVO_HANGUP_XML };
const OK: PlivoCallbackAnswer = { statusCode: 200, contentType: 'application/json', body: '{"status":true}' };
const FORBIDDEN: PlivoCallbackAnswer = { statusCode: 403, contentType: 'application/json', body: '{"status":false}' };
const UNAVAILABLE: PlivoCallbackAnswer = { statusCode: 503, contentType: 'application/json', body: '{"status":false}' };

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
    return kind === 'answer' ? HANGUP : UNAVAILABLE;
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

/** The public origin Plivo calls, from env; null when `PLIVO_WEBHOOK_BASE_URL` is unset or malformed. */
function publicOrigin(base: string): string | null {
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export function registerPlivoWebhookRoutes(
  app: FastifyInstance,
  opts: {
    webrtcBridge: WebRtcBridgeManager | null | undefined;
    /**
     * True when callbacks may belong to a media worker (`webhookForwarder` set: the
     * server runs as several processes). Plivo callbacks are not forwarded yet.
     */
    forwardsToMediaWorkers: () => boolean;
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
      // TODO(plivo part 2): forward to the media worker the URL's `w` names, with the URL
      // and headers the signature needs, and let the IPC answer carry XML. Until then a
      // media worker refuses Plivo dials before the carrier (the bridge's step 5b), so a
      // hinted callback here names no live call.
      if (opts.forwardsToMediaWorkers() && request.query?.w) {
        log.error({ callId, kind, hint: request.query.w }, 'Plivo callbacks are not forwarded to media workers yet — refusing');
        return send(kind === 'answer' ? HANGUP : UNAVAILABLE);
      }
      const origin = publicOrigin(baseUrl());
      if (!origin) {
        log.error({ callId, kind }, 'PLIVO_WEBHOOK_BASE_URL is not set: a Plivo callback cannot be verified — refusing');
        return send(refuse(kind));
      }
      return send(await handlePlivoCallback(bridge, {
        kind,
        callId,
        token: request.query?.token,
        url: `${origin}${request.url}`,
        params: formParams(request.body),
        headers: request.headers as Record<string, string | undefined>,
      }));
    });
  };
  route('answer', '/plivo/webrtc-answer/:callId');
  route('status', '/plivo/webrtc-status/:callId');
  route('recording', '/plivo/webrtc-recording/:callId');
}
