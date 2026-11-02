/**
 * A media worker's Fastify instance (`docs/scaling.md` §2.3). It never listens: every
 * request it serves is an upgrade the primary handed over (`ws-adopt.ts`), so it carries
 * only what those need:
 *
 *  - the same `trustProxy` hop count and request ids as `buildApp`, so `request.ip` and
 *    the log lines match the primary's for the same upgrade;
 *  - the client log context hook, the error handler and the 5xx mask;
 *  - `@fastify/websocket`, with the same `maxPayload` (`utils/ws-limits.ts`), which
 *    completes the handshake and bounds every frame here, where the frames are;
 *  - the two WebSocket routes, unchanged: the station socket (`proxyAgencyStationRoutes`,
 *    which verifies and spends the single-use token) and the carrier's PSTN stream
 *    (`webrtcCallRoutes`, which verifies the provider token).
 *
 * No rate limiter: the primary charged every upgrade once, before handing it over.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import websocket from '@fastify/websocket';
import type { AppConfig } from '../config/schema.js';
import { hopCountTrust } from '../app.js';
import { clientLogContextHook } from '../api/middleware/client-log-context.js';
import { agencyErrorHandler } from '../api/middleware/agency-error-handler.js';
import { errorMaskHook } from '../api/middleware/error-mask.middleware.js';
import { websocketPluginOptions } from '../utils/ws-limits.js';
import { proxyAgencyStationRoutes } from '../api/routes/proxy-agency-station.routes.js';
import { webrtcCallRoutes } from '../api/routes/webrtc-call.routes.js';
import { AGENCY_ROUTE_PREFIXES } from '../api/agency.plugin.js';
import type { AgencyRuntime } from '../agency/runtime.js';
import type { WebRtcBridgeManager } from '../core/webrtc-bridge-manager.js';

export async function buildWorkerApp(input: {
  config: AppConfig;
  runtime: AgencyRuntime;
  bridge: WebRtcBridgeManager;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    routerOptions: { maxParamLength: 200 },
    trustProxy: hopCountTrust(input.config.server.trustProxyHops),
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
  });
  app.addHook('onRequest', clientLogContextHook);
  app.setErrorHandler(agencyErrorHandler);
  app.addHook('onSend', errorMaskHook);
  await app.register(websocket, websocketPluginOptions(input.config.server.wsMaxPayloadBytes));
  await app.register(proxyAgencyStationRoutes, {
    prefix: AGENCY_ROUTE_PREFIXES.proxyAgencyStation,
    getRuntime: () => input.runtime,
  });
  await app.register(webrtcCallRoutes, { prefix: '/api/v1/webrtc-call', bridge: input.bridge });
  await app.ready();
  return app;
}
