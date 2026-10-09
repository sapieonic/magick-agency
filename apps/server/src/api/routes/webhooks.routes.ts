// PORT NOTE (magick-agency): ported from magic-voice-core/src/api/routes/webhooks.routes.ts@4850d1d9
// (4,901 lines), subset. Kept verbatim: the plugin-scoped form-urlencoded content-type
// parser and `POST /voicelink/webrtc-status/:callId` (the only webhook the bridge depends
// on: VoiceLink posts every lifecycle event of a bridge leg here, token-gated by the
// purpose-bound webhook token). Not carried: every AI-call, static, IVR, inbound,
// escalation, recording and WS-static webhook, the Telnyx/Twilio signature hooks (those
// carriers are not carried), and the three VoBiz WebRTC routes (`/vobiz/webrtc-answer`,
// `/vobiz/webrtc-status`, `/vobiz/webrtc-recording` — VoBiz deleted, plan §5).
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

  // Twilio, Plivo and Telnyx send webhooks as application/x-www-form-urlencoded.
  // Register a content-type parser scoped to this plugin so Fastify can parse them.
  //
  // The undecoded string is stashed on the request as well as parsed. Telnyx
  // signs `${telnyx-timestamp}|${rawBody}`, and a signature check over a
  // re-serialised body is not a signature check: `querystring.parse` +
  // `stringify` does not round-trip byte-for-byte (parameter order, `+` vs
  // `%20`, and the array-on-repeated-key collapse all move), so every valid
  // request would fail verification. Capturing it costs one property assignment
  // on a route family that is already parsing the string.
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
  // Distinct from the AI-call /voicelink/status route above: owned by the
  // WebRtcBridgeManager, not CallManager. Terminal events also carry the
  // carrier-managed recording URL, which the bridge persists for playback and
  // optional post-call analysis.
  // POST /api/v1/webhooks/voicelink/webrtc-status/:callId?token=<webhook token>
  app.post('/voicelink/webrtc-status/:callId', async (
    request: FastifyRequest<{ Params: { callId: string }; Querystring: { token?: string } }>,
    reply: FastifyReply,
  ) => {
    const { callId } = request.params;
    if (!webrtcBridge) return reply.send({ status: true });

    // Verify the purpose-bound webhook token so forged lifecycle events (which
    // drive status/settlement/concurrency release) can't be posted with just a
    // leaked call id. Degrades to accept when Redis/token is unavailable.
    // Q6 (Manas, 2026-10-09): now only when REDIS is unavailable (absent or erroring), or
    // the token's SET failed at mint; a missing token while Redis answers is refused 403.
    // The token outlives the call by 2h for the carrier's late terminal post.
    const tokenOk = await webrtcBridge.verifyWsToken(callId, request.query?.token, 'webhook');
    if (!tokenOk) {
      log.warn({ callId }, 'VoiceLink WebRTC webhook with invalid token — rejecting');
      return reply.code(403).send({ status: false });
    }

    const body = (request.body || {}) as VoicelinkWebhookBody;
    const event = parseVoicelinkWebhook(body, callId);
    log.info(
      { callId, event: body.event, eventType: event?.eventType },
      'VoiceLink WebRTC status webhook received',
    );
    // parseVoicelinkWebhook returns null for informational events (call.initiated).
    if (event) {
      await webrtcBridge.handleVoicelinkStatus(callId, event);
    }
    return reply.send({ status: true });
  });
}
