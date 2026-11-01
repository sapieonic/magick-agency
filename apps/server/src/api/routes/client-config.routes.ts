import type { FastifyInstance } from 'fastify';
import type { ClientConfigResponse } from '@magick-agency/contracts/api/platform/client-config';
import type { AppConfig } from '../../config/schema.js';

export interface ClientConfigRouteOptions {
  mobile: AppConfig['mobile'];
}

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
 * The body is built once, at registration: it is config, and config changes with a restart.
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
}
