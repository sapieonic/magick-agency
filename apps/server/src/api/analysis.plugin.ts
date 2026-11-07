import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../app-context.js';
import { webrtcRecordingsRoutes } from './routes/webrtc-recordings.routes.js';
import { createRecordingAccessResolver, processCredentialSource } from '../telephony/recording-access.js';

/**
 * The analysis HTTP surface.
 *
 *  - `/api/v1/webrtc-recordings`: unauthenticated by design; the HMAC-signed query token is
 *    the authorization (see the route's header comment).
 *
 * The call-analysis profile routes are registered by `agencyPlugin`, at the console's path
 * `/proxy/call-analysis-profiles` (decision B16), with the session → tenant-context → RBAC
 * chain as their `ProfileRouteAuth` (`profile-route-auth.ts`) and `agencyCampaignRepository`
 * as their `ProfileDependents`. They sit in the agency scope so its error handler (the 22P02
 * backstop) and `X-Tenant-Id` check apply. Their refuse-all default and the dependents' 503
 * stay in the route file for any other mount.
 */
export interface AnalysisPluginOptions {
  ctx: AppContext | null;
}

export const analysisPlugin: FastifyPluginAsync<AnalysisPluginOptions> = async (app, opts) => {
  await app.register(webrtcRecordingsRoutes, {
    prefix: '/api/v1/webrtc-recordings',
    // No ctx (a routing-only app): the route's own refuse-all default.
    ...(opts.ctx
      ? {
        resolveRecordingAccess: createRecordingAccessResolver({
          voicelinkHosts: opts.ctx.config.voicelinkRecording.allowedHosts,
          credentials: processCredentialSource,
        }),
      }
      : {}),
  });
};
