import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ClientConfigResponse, UplinkProbeResponse } from '@magick-agency/contracts/api/platform/client-config';
import type { UserRecord } from '@magick-agency/db/models/user.model';
import type { AppConfig } from '../../config/schema.js';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { createUserRateLimit } from '../middleware/rate-limit.middleware.js';

export interface ClientConfigRouteOptions {
  mobile: AppConfig['mobile'];
  /** The rate-limit window (`RATE_LIMIT_WINDOW`) the uplink probe's per-user cap counts in. */
  timeWindow?: string | number;
}

/** The uplink probe's body ceiling: the app sends 32 KB; twice that is the most it may. */
export const UPLINK_PROBE_BODY_LIMIT = 65_536;

/** Probes per user per rate-limit window: a pre-flight runs one or two, a retry a few more. */
export const UPLINK_PROBE_MAX_PER_WINDOW = 6;

/**
 * `GET /client-config`: what a client must know before it can sign in, today the mobile
 * app's version gate (`ClientConfigResponse`).
 *
 * PUBLIC, deliberately: an app too old to sign in must still learn that it has to update.
 * No session hook, no tenant context, nothing per user or tenant in the answer, and
 * nothing secret in it (the versions and the store links are public facts). It is charged
 * to the app-scope limiter like any unauthenticated request (`ip`, 200/min per IP, or
 * `ip_auth` when the app sends its bearer), so the app must treat a failed read as "no
 * gate" and retry later, never block on it.
 *
 * `POST /client-config/uplink-probe`: the mobile pre-flight's upload-speed check
 * (`UplinkProbeResponse`). See the route below.
 *
 * The GET body is built once, at registration: it is config, and config changes with a
 * restart.
 */
export async function clientConfigRoutes(app: FastifyInstance, opts: ClientConfigRouteOptions): Promise<void> {
  const { mobile } = opts;
  const storeUrls = {
    ...(mobile.iosStoreUrl ? { ios: mobile.iosStoreUrl } : {}),
    ...(mobile.androidStoreUrl ? { android: mobile.androidStoreUrl } : {}),
  };
  const body: ClientConfigResponse = {
    mobile: {
      min_supported: mobile.minSupportedVersion,
      latest: mobile.latestVersion,
      ...(Object.keys(storeUrls).length > 0 ? { store_urls: storeUrls } : {}),
    },
  };

  app.get('/', async (_request, reply) => reply.send(body));

  // This scope's only body is the probe's raw bytes: every other content type is a 415.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: UPLINK_PROBE_BODY_LIMIT },
    (_request, payload, done) => done(null, payload),
  );

  const probeCap = createUserRateLimit(app, {
    namespace: 'up',
    max: UPLINK_PROBE_MAX_PER_WINDOW,
    ...(opts.timeWindow !== undefined ? { timeWindow: opts.timeWindow } : {}),
  });

  /**
   * Authentication and the cap run in `preParsing`, BEFORE the body is read: an
   * unauthenticated or capped caller never gets a byte past the socket into this process.
   * (A `preHandler` would run after Fastify had already read up to 64 KB from anyone.)
   * `sessionMiddleware` also charges the general per-user bucket (`u:`); `up:` is this
   * route's own counter. No tenant context: the probe reads nothing of a tenant's.
   */
  async function authenticateBeforeBody(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await sessionMiddleware(request, reply);
    if (reply.sent || !request.user) return;
    await probeCap(request as FastifyRequest & { user: UserRecord }, reply);
  }

  /**
   * POST /client-config/uplink-probe — the mobile pre-flight's upload-speed check. The app
   * times the upload of 32 KB; this reads the whole body and says how much arrived. No DB
   * or Redis work beyond the two rate-limit counters.
   */
  app.post('/uplink-probe', {
    bodyLimit: UPLINK_PROBE_BODY_LIMIT,
    preParsing: async (request, reply) => {
      await authenticateBeforeBody(request, reply);
    },
  }, async (request, reply) => {
    const received = Buffer.isBuffer(request.body) ? request.body.length : 0;
    const answer: UplinkProbeResponse = { received_bytes: received };
    return reply.code(200).send(answer);
  });
}
