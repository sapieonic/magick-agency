// Plivo's callbacks for calls CUSTOMERS place to a tenant's numbers linked to inbound
// (docs/inbound.md §3, §3.1, §10), under `/api/v1/webhooks/plivo` (registered by
// `webhooks.routes.ts`, whose plugin-scoped form parser reads their bodies):
//
//   POST /plivo/inbound-answer/:credentialId   the Application's answer_url: we reply with XML
//   POST /plivo/inbound-status/:credentialId   the Application's hangup_url
//   POST /plivo/inbound-fallback               the Application's fallback answer URL: fixed XML
//
// The first two are the credential's, not a call's: one Plivo Application per credential names
// them for every number linked to it. Each is checked before anything is read or written:
//
//  1. the purpose token in the query (`?token=`, minted when inbound was enabled): its sha256 must
//     match the credential's current hash, or the previous one inside a Re-point's grace
//     (`inboundTokenMatches`);
//  2. Plivo's V3 signature against the credential's own auth token(s) (`call_control`: a disabled
//     or invalid credential still verifies, §10), computed over the URL STORED on the credential
//     (`inbound_answer_url` / `inbound_hangup_url`, the exact string the Application was given)
//     plus the request's query (`inboundSignedUrl`, `inbound-urls.ts`, which builds those URLs). Never
//     rebuilt from env or from the path the request arrived on:
//     the URL lives in the tenant's Plivo account and is the signature's subject (PL9's rule);
//  3. the signed nonce, once per credential (`claimInboundCallbackNonce`): a captured callback
//     replayed is refused. A callback that fails to process gives its nonce back. When Redis
//     cannot answer, the check fails CLOSED (QA-F11): a 503 on either URL, so Plivo answers the
//     caller from the Application's fallback answer URL (and retries a hangup), and a replay
//     cannot slip through an outage.
// A refusal on the answer URL is a hangup (`<Hangup/>`); on the status URL a 403.
//
// The fallback answer URL takes no token and reads nothing: it is what Plivo plays while we are
// unreachable, so it answers the same fixed XML to anyone (rate-limited as every webhook, by the
// app's `webhook` bucket).
//
// What a verified call means is the agency area's (`seams/inbound-call-router.ts`): this file
// renders its decision. The answer is bounded ({@link INBOUND_ANSWER_BUDGET_MS}): past it the
// caller hears the fallback message and the router is told (its abort signal), so it places
// nothing more and leaves no follow-up for a caller who was asked to try again.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { trackInboundAnswer } from '@magick-agency/observability/metrics/agency';
import { telephonyCredentialRepository } from '@magick-agency/db/repositories/telephony-credential.repository';
import type { TelephonyCredentialInboundRecord } from '@magick-agency/db/models/telephony-credential.model';
import type { WebRtcBridgeManager } from '../../../core/webrtc-bridge-manager.js';
import type { TelephonyProvider } from '../../../telephony/types.js';
import { PLIVO_HANGUP_XML } from '../../../telephony/plivo/plivo.adapter.js';
import { hashInboundToken } from '../../../telephony/plivo/inbound-token.js';
import { PLIVO_INBOUND_ROUTES, inboundSignedUrl } from '../../../telephony/plivo/inbound-urls.js';
import { PLIVO_SIGNATURE_V3_NONCE_HEADER, headerValue } from '../../../telephony/plivo/plivo-signature.js';
import {
  PLIVO_INBOUND_FALLBACK_XML,
  PLIVO_INBOUND_SPOKEN_XML,
  plivoInboundHangupEvent,
  readPlivoInboundArrival,
  readPlivoInboundHangup,
} from '../../../telephony/plivo/plivo-inbound.webhook.js';
import { getInboundCallRouter, type InboundAnswerDecision } from '../../../seams/inbound-call-router.js';
import { formParams, signatureHeaders } from './plivo.js';

const log = createChildLogger({ component: 'plivo-inbound-webhooks' });

const PROVIDER = 'plivo';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long the answer webhook may take before the caller is answered with the fallback message
 * instead. Plivo's own answer-URL timeout is not verified yet (P0, docs/inbound.md §12); this
 * keeps our answer well inside any plausible one. The work is lean already (indexed reads, one
 * transaction, Redis): the budget guards a stalled pool or Redis, not the normal path.
 */
export const INBOUND_ANSWER_BUDGET_MS = 4_000;

type Kind = 'answer' | 'status';

/** What Plivo is answered with. */
interface Answer {
  statusCode: number;
  contentType: 'text/xml' | 'application/json';
  body: string;
}

const xml = (body: string): Answer => ({ statusCode: 200, contentType: 'text/xml', body });
const HANGUP = xml(PLIVO_HANGUP_XML);
const FALLBACK = xml(PLIVO_INBOUND_FALLBACK_XML);
const OK: Answer = { statusCode: 200, contentType: 'application/json', body: '{"status":true}' };
const FORBIDDEN: Answer = { statusCode: 403, contentType: 'application/json', body: '{"status":false}' };
const UNAVAILABLE: Answer = { statusCode: 503, contentType: 'application/json', body: '{"status":false}' };

const refuse = (kind: Kind): Answer => (kind === 'answer' ? HANGUP : FORBIDDEN);

/** One inbound callback after the route's parsing: plain data. */
export interface PlivoInboundCallbackInput {
  kind: Kind;
  credentialId: string;
  token: string | undefined;
  /** The path and query the request arrived on: its query, appended to the stored URL, is the signature's subject (`inboundSignedUrl`). */
  requestUrl: string;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
}

/** The credential's verified callback: its record and the nonce this request claimed. */
interface Verified {
  credential: TelephonyCredentialInboundRecord;
  nonce: string;
}

/** Checks 1–3 of the header. Null: refused (logged, with ids only); `unavailable`: the replay guard could not be asked. */
async function verify(bridge: WebRtcBridgeManager, input: PlivoInboundCallbackInput): Promise<Verified | null | 'unavailable'> {
  const { kind, credentialId } = input;
  if (!UUID.test(credentialId)) {
    log.warn({ kind }, 'Inbound Plivo callback for a malformed credential id — refusing');
    return null;
  }
  if (!input.token) {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback with no purpose token — refusing');
    return null;
  }
  const credential = await telephonyCredentialRepository.findInbound(credentialId);
  const storedUrl = kind === 'answer' ? credential?.answer_url : credential?.hangup_url;
  if (!credential || credential.provider !== PROVIDER || !storedUrl) {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback for a credential with no inbound Application — refusing');
    return null;
  }
  if (!await telephonyCredentialRepository.inboundTokenMatches(credentialId, hashInboundToken(input.token))) {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback with a purpose token that does not match — refusing');
    return null;
  }
  const adapter: TelephonyProvider | null = await bridge.inboundCallbackAdapter(credentialId, credential.tenant_id, PROVIDER);
  const signed = adapter?.verifyCarrierRequest?.({
    method: 'POST', url: inboundSignedUrl(storedUrl, input.requestUrl), params: input.params, headers: input.headers,
  }) === true;
  if (!signed) {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback with a signature that does not verify over the stored URL — refusing');
    return null;
  }
  // A verified signature has a nonce (`verifyPlivoV3Signature` refuses one without); refused here
  // too, so no two requests could ever share an empty nonce's key.
  const nonce = headerValue(input.headers, PLIVO_SIGNATURE_V3_NONCE_HEADER);
  if (!nonce) {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback with no signed nonce — refusing');
    return null;
  }
  const claimed = await bridge.claimInboundCallbackNonce(credentialId, nonce);
  if (claimed === 'unavailable') {
    log.error({ kind, credentialId }, 'Inbound Plivo callback whose replay guard cannot be checked (Redis) — 503, the carrier falls back');
    return 'unavailable';
  }
  if (claimed === 'replay') {
    log.warn({ kind, credentialId }, 'Inbound Plivo callback whose signed nonce this credential has already seen (a replay) — refusing');
    return null;
  }
  return { credential, nonce };
}

/** The decision, rendered as the XML Plivo runs. */
function render(adapter: TelephonyProvider | null, decision: InboundAnswerDecision): Answer {
  switch (decision.kind) {
    case 'stream':
      if (!adapter) return FALLBACK;
      return xml(adapter.generateAnswerResponse(decision.callId, decision.streamUrl, { maxDurationSeconds: decision.maxDurationSeconds }));
    case 'spoken':
      return xml(PLIVO_INBOUND_SPOKEN_XML[decision.message]);
    case 'hangup':
      return HANGUP;
    case 'fallback':
      return FALLBACK;
  }
}

/** `p`, or `onTimeout` once `ms` pass first. */
async function within<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(onTimeout), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const TIMED_OUT = Symbol('timed out');

/**
 * Handle one inbound callback. Never throws: a refusal is a hangup (answer) or 403 (status); a
 * fault is the fallback message (answer) or 503 (status), with the nonce given back.
 */
export async function handlePlivoInboundCallback(
  bridge: WebRtcBridgeManager,
  input: PlivoInboundCallbackInput,
  opts: { budgetMs?: number } = {},
): Promise<Answer> {
  const startedAt = performance.now();
  const { kind, credentialId } = input;
  let verified: Verified | null = null;
  try {
    const checked = await verify(bridge, input);
    if (checked === 'unavailable') {
      // Not ours to answer now: Plivo's fallback answer URL speaks to the caller (QA-F11).
      if (kind === 'answer') trackInboundAnswer('fallback', (performance.now() - startedAt) / 1000);
      return UNAVAILABLE;
    }
    verified = checked;
    if (!verified) {
      if (kind === 'answer') trackInboundAnswer('refused', (performance.now() - startedAt) / 1000);
      return refuse(kind);
    }
    const { credential } = verified;
    if (kind === 'answer') {
      const read = readPlivoInboundArrival(input.params);
      if (!read.ok) {
        log.warn({ credentialId, reason: read.reason }, 'Inbound Plivo answer callback that is not an arriving call — hanging up');
        trackInboundAnswer('refused', (performance.now() - startedAt) / 1000);
        return HANGUP;
      }
      const budget = new AbortController();
      const work = getInboundCallRouter().answer({
        credentialId,
        tenantId: credential.tenant_id,
        provider: PROVIDER,
        credentialStatus: credential.status,
        carrierCallId: read.arrival.callUuid,
        fromE164: read.arrival.fromE164,
        toE164: read.arrival.toE164,
      }, { signal: budget.signal });
      const decision = await within<InboundAnswerDecision | typeof TIMED_OUT>(work, opts.budgetMs ?? INBOUND_ANSWER_BUDGET_MS, TIMED_OUT);
      if (decision === TIMED_OUT) {
        // The caller is the fallback's now: the router stops placing the call where it got to
        // and leaves no follow-up (they were told to try again, not that we would call).
        budget.abort();
        work.catch((err: unknown) => log.error({ err, credentialId }, 'Inbound answer failed after its budget'));
        log.error({ credentialId, budgetMs: opts.budgetMs ?? INBOUND_ANSWER_BUDGET_MS }, 'Inbound answer over its budget — answering with the fallback message');
        trackInboundAnswer('timed_out', (performance.now() - startedAt) / 1000);
        return FALLBACK;
      }
      const adapter = decision.kind === 'stream' ? await bridge.inboundCallbackAdapter(credentialId, credential.tenant_id, PROVIDER) : null;
      const answer = render(adapter, decision);
      trackInboundAnswer(decision.kind, (performance.now() - startedAt) / 1000);
      log.info({ credentialId, decision: decision.kind }, 'Inbound Plivo call answered');
      return answer;
    }
    const hangup = readPlivoInboundHangup(input.params);
    if (!hangup.callUuid) {
      log.warn({ credentialId }, 'Inbound Plivo status callback with no CallUUID — ignoring');
      return OK;
    }
    if (!hangup.terminal) return OK;
    const { legId } = await getInboundCallRouter().ended({
      credentialId,
      tenantId: credential.tenant_id,
      provider: PROVIDER,
      carrierCallId: hangup.callUuid,
      callStatus: hangup.callStatus,
      hangupSource: hangup.hangupSource,
      ...(hangup.durationSec !== undefined ? { durationSeconds: hangup.durationSec } : {}),
    });
    // The bridge settles its leg as the carrier ended it: no hangup is sent back, and a clip still
    // playing stops (its stream is gone). With no live session, the late path writes the terminal.
    if (legId) await bridge.handleCarrierStatus(legId, plivoInboundHangupEvent(hangup, legId), PROVIDER);
    return OK;
  } catch (err) {
    log.error({ err, credentialId, kind }, 'Inbound Plivo callback failed');
    if (verified) await bridge.releaseInboundCallbackNonce(credentialId, verified.nonce);
    if (kind === 'answer') {
      trackInboundAnswer('fallback', (performance.now() - startedAt) / 1000);
      return FALLBACK;
    }
    return UNAVAILABLE;
  }
}

export function registerPlivoInboundWebhookRoutes(
  app: FastifyInstance,
  opts: { webrtcBridge: WebRtcBridgeManager | null | undefined; budgetMs?: number },
): void {
  const route = (kind: Kind): void => {
    app.post(`/plivo/${PLIVO_INBOUND_ROUTES[kind]}/:credentialId`, async (
      request: FastifyRequest<{ Params: { credentialId: string }; Querystring: { token?: string } }>,
      reply: FastifyReply,
    ) => {
      const send = (a: Answer) => reply.code(a.statusCode).type(a.contentType).send(a.body);
      const bridge = opts.webrtcBridge;
      if (!bridge) return send(kind === 'answer' ? FALLBACK : UNAVAILABLE);
      return send(await handlePlivoInboundCallback(bridge, {
        kind,
        credentialId: request.params.credentialId,
        token: request.query?.token,
        requestUrl: request.url,
        params: formParams(request.body),
        headers: signatureHeaders(request.headers),
      }, opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}));
    });
  };
  route('answer');
  route('status');
  // Fixed XML for anyone: no token, no read, no write (the Application's fallback answer URL).
  app.post(`/plivo/${PLIVO_INBOUND_ROUTES.fallback}`, async (_request, reply) =>
    reply.code(200).type('text/xml').send(PLIVO_INBOUND_FALLBACK_XML));
}
