// PORT NOTE (magick-agency): ported from magic-voice-core/src/api/routes/webrtc-call.routes.ts@4850d1d9,
// subset. Kept verbatim: the PSTN media leg `GET /:id/pstn-stream` (the only route the
// agency path uses — VoiceLink dials into it with the purpose-bound provider token, which
// `attachPstnLegVerified` checks). Deleted (softphone, plan §5): the token-gated browser
// leg `GET /:id/browser-stream` (it attached an OWNED browser leg via `attachBrowserLeg`,
// which only `createCall` produced; every agency leg is a borrowed station socket bound
// in-process), and the whole authenticated control API (`/caller-ids`, `POST /`, `GET /`,
// `GET /:id`, `/:id/recording`, `/:id/recording-url`, `/:id/end`, `/:id/retry-analysis`,
// `DELETE /:id/transcript`), which served the softphone's `'dialer'`-scoped calls.
// `bridge` may be null when the app is built without storage (route-table tests); core
// always had one, so a connect then is refused by closing the socket.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import { trackWebsocketConnection } from '@magick-agency/observability/metrics/voice';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'webrtc-call-routes' });

/**
 * WebRTC human calling routes (browser→PSTN bridge). See
 * docs/webrtc-human-calling-design.md.
 *
 * The PSTN media-stream WebSocket leg is registered unauthenticated at the plugin
 * root (VoiceLink, guarded by its purpose-bound provider token).
 */
export async function webrtcCallRoutes(
  app: FastifyInstance,
  opts: { bridge: WebRtcBridgeManager | null },
): Promise<void> {
  const { bridge } = opts;

  // ─── Media-stream WebSocket legs (no header auth) ──────────────────────────

  // PSTN leg — the provider connects here. VoBiz connects per the answer XML
  // <Stream> URL (gated by that flow). VoiceLink connects to the URL we baked into
  // its add_lead request, which carries a purpose-bound `token` — verify it so a
  // leaked call id alone can't hijack the provider socket.
  app.get('/:id/pstn-stream', { websocket: true }, (socket: WebSocket, request: FastifyRequest<{
    Params: { id: string };
    Querystring: { token?: string };
  }>) => {
    const { id } = request.params;
    const token = request.query?.token;
    log.info({ callId: id }, 'WebRTC PSTN leg WebSocket connected');
    trackWebsocketConnection('webrtc_pstn', 1);
    socket.on('close', () => trackWebsocketConnection('webrtc_pstn', -1));
    if (!bridge) {
      try { socket.close(); } catch { /* ignore */ }
      return;
    }
    bridge.attachPstnLegVerified(id, socket, token).catch((err) => {
      log.error({ err, callId: id }, 'Error attaching PSTN leg');
      try { socket.close(); } catch { /* ignore */ }
    });
  });
}
