import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../app-context.js';
import { ensureVoiceEngine } from '../bootstrap/voice.js';
import { webrtcCallRoutes } from './routes/webrtc-call.routes.js';
import { webhooksRoutes } from './routes/webhooks.routes.js';

/**
 * Lane C's HTTP/WebSocket surface: the VoiceLink PSTN media leg and the VoiceLink
 * bridge webhook, under core's prefixes (core `src/index.ts:678,693`). Both are
 * unauthenticated carrier surfaces in core and keep their token checks exactly
 * (purpose-bound provider / webhook tokens, verified in the bridge).
 *
 * The rate limiter was registered inside this plugin's scope; Phase 8 hoisted it to
 * `app.ts`, where core had it (global: the `webhook` and `carrier_media` buckets still
 * apply to these routes, and the tenant/ip/internal/exempt buckets now cover every other
 * route too). `@fastify/websocket` was likewise registered here originally; the lead
 * hoisted it to `app.ts` (one registration for the whole app) before Phase 6 added the
 * station socket.
 */
export const voicePlugin: FastifyPluginAsync<{ ctx: AppContext | null }> = async (app, opts) => {
  const ctx = opts.ctx;
  const bridge = ctx ? ensureVoiceEngine(ctx.redis).bridge : null;

  await app.register(webhooksRoutes, { prefix: '/api/v1/webhooks', webrtcBridge: bridge });
  await app.register(webrtcCallRoutes, { prefix: '/api/v1/webrtc-call', bridge });
};
