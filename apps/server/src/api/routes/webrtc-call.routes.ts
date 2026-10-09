// The PSTN media leg `GET /:id/pstn-stream`: VoiceLink dials into it with the
// purpose-bound provider token, which `attachPstnLegVerified` checks. There is no
// browser leg route — every agency browser leg is a borrowed station socket bound
// in-process — and no call control API. `bridge` may be null when the app is
// built without storage (route-table tests); a connect then is refused by
// closing the socket.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import { trackWebsocketConnection } from '@magick-agency/observability/metrics/voice';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'webrtc-call-routes' });

/**
 * WebRTC human calling routes (browser→PSTN bridge).
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

  // PSTN leg — the provider connects here. VoiceLink connects to the URL we baked
  // into its add_lead request, which carries a purpose-bound `token` — verify it
  // so a leaked call id alone can't hijack the provider socket.
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
