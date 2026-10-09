import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../app-context.js';
import { ensureVoiceEngine } from '../bootstrap/voice.js';
import { webrtcCallRoutes } from './routes/webrtc-call.routes.js';
import { webhooksRoutes } from './routes/webhooks.routes.js';

/**
 * The voice engine's HTTP/WebSocket surface: the VoiceLink PSTN media leg and the
 * VoiceLink bridge webhook. Both are unauthenticated carrier surfaces and keep their token
 * checks (purpose-bound provider / webhook tokens, verified in the bridge).
 *
 * The rate limiter and `@fastify/websocket` are registered once, app-wide, in `app.ts`; the
 * `webhook` and `carrier_media` buckets apply to these routes.
 */
export const voicePlugin: FastifyPluginAsync<{ ctx: AppContext | null }> = async (app, opts) => {
  const ctx = opts.ctx;
  const bridge = ctx ? ensureVoiceEngine(ctx.redis).bridge : null;

  await app.register(webhooksRoutes, { prefix: '/api/v1/webhooks', webrtcBridge: bridge });
  await app.register(webrtcCallRoutes, { prefix: '/api/v1/webrtc-call', bridge });
};
