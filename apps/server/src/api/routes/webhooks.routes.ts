// Carrier webhooks: the plugin-scoped form-urlencoded content-type parser and
// `POST /voicelink/webrtc-status/:callId`, the only webhook the bridge depends on
// (VoiceLink posts every lifecycle event of a bridge leg here, token-gated by the
// purpose-bound webhook token). No other carrier's webhooks are served.
import querystring from 'node:querystring';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { parseVoicelinkWebhook } from '../../telephony/voicelink/voicelink.webhook.js';
import type { VoicelinkWebhookBody } from '../../telephony/voicelink/voicelink.types.js';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';

const log = createChildLogger({ component: 'webhooks-routes' });

export async function webhooksRoutes(
  app: FastifyInstance,
  opts: { webrtcBridge?: WebRtcBridgeManager | null },
): Promise<void> {
  const { webrtcBridge } = opts;

  // Carrier webhooks can arrive as application/x-www-form-urlencoded. Register a
  // content-type parser scoped to this plugin so Fastify can parse them.
  //
  // The undecoded string is stashed on the request as `rawBody` as well as
  // parsed, for a signature check over the exact bytes: `querystring.parse` +
  // `stringify` does not round-trip byte-for-byte (parameter order, `+` vs
  // `%20`, and the array-on-repeated-key collapse all move), so a check over a
  // re-serialised body would fail every valid request. Nothing reads `rawBody`
  // today.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      done(null, querystring.parse(body as string));
    },
  );

  // ─── VoiceLink WebRTC human-bridge webhook ───────────────────────────────
  // VoiceLink has no answer XML — the PSTN leg connects to the pstn-stream WS
  // (URL baked into the add_lead dial request), so lifecycle arrives only here.
  // Owned by the WebRtcBridgeManager. Terminal events also carry the
  // carrier-managed recording URL, which the bridge persists for playback and
  // optional post-call analysis.
  // POST /api/v1/webhooks/voicelink/webrtc-status/:callId?token=<webhook token>
  app.post('/voicelink/webrtc-status/:callId', async (
    request: FastifyRequest<{ Params: { callId: string }; Querystring: { token?: string } }>,
    reply: FastifyReply,
  ) => {
    const { callId } = request.params;
    if (!webrtcBridge) return reply.send({ status: true });
    const answer = await handleVoicelinkStatusWebhook(webrtcBridge, callId, request.query?.token, request.body);
    return reply.code(answer.statusCode).send(answer.body);
  });
}

/** What the status webhook answers: the HTTP status and body the carrier gets. */
export interface VoicelinkWebhookAnswer {
  statusCode: number;
  body: { status: boolean };
}

/**
 * The VoiceLink status webhook, after the route's parsing: verify the purpose-bound
 * webhook token, decode the event, hand it to the bridge. A function of plain data so the
 * process that owns the call can run it when the request arrived elsewhere
 * (`docs/scaling.md` §3.2); the route calls it directly.
 *
 * Verify the purpose-bound webhook token so forged lifecycle events (which drive
 * status/settlement/concurrency release) can't be posted with just a leaked call id.
 * Q6 (Manas, 2026-10-09): a missing token while Redis answers is refused 403; Redis
 * unavailable (absent or erroring), or the token's SET failed at mint, accepts. The token
 * outlives the call by 2h for the carrier's late terminal post.
 */
export async function handleVoicelinkStatusWebhook(
  webrtcBridge: WebRtcBridgeManager,
  callId: string,
  token: string | undefined,
  rawBody: unknown,
): Promise<VoicelinkWebhookAnswer> {
  const tokenOk = await webrtcBridge.verifyWsToken(callId, token, 'webhook');
  if (!tokenOk) {
    log.warn({ callId }, 'VoiceLink WebRTC webhook with invalid token — rejecting');
    return { statusCode: 403, body: { status: false } };
  }

  const body = (rawBody || {}) as VoicelinkWebhookBody;
  const event = parseVoicelinkWebhook(body, callId);
  log.info(
    { callId, event: body.event, eventType: event?.eventType },
    'VoiceLink WebRTC status webhook received',
  );
  // parseVoicelinkWebhook returns null for informational events (call.initiated).
  if (event) {
    await webrtcBridge.handleVoicelinkStatus(callId, event);
  }
  return { statusCode: 200, body: { status: true } };
}
