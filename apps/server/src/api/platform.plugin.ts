import type { FastifyPluginAsync } from 'fastify';
import type { AppContext } from '../app-context.js';
import { config as loadedConfig } from '../config/index.js';
import { redisCache } from '../cache/redis-cache.js';
import { initFirebase } from '../auth/firebase.js';
import { authRoutes } from './routes/auth.routes.js';
import { tenantRoutes } from './routes/tenant.routes.js';
import { accountRoutes } from './routes/account.routes.js';
import { userRoutes } from './routes/user.routes.js';
import { inviteRoutes } from './routes/invites.routes.js';
import { notificationRoutes } from './routes/notification.routes.js';
import { featureFlagsRoutes } from './routes/feature-flags.routes.js';
import { superAdminRoutes } from './routes/super-admin.routes.js';
import { superAdminPhoneRoutes } from './routes/super-admin-phone.routes.js';
import { superAdminFeatureFlagsRoutes } from './routes/super-admin-feature-flags.routes.js';
import { superAdminUsageCountsRoutes } from './routes/super-admin-usage-counts.routes.js';
import { superAdminAccountSettingsRoutes } from './routes/super-admin-account-settings.routes.js';

/**
 * Every prefix lane A registers a route plugin under. The route-table tests
 * (`test/unit/api/platform-agent-reach.test.ts`) read this list rather than a
 * copy of it.
 */
export const PLATFORM_ROUTE_PREFIXES = {
  auth: '/auth',
  tenants: '/tenants',
  accounts: '/accounts',
  users: '/users',
  invites: '/invites',
  notifications: '/notifications',
  featureFlags: '/feature-flags',
  superAdmin: '/super-admin',
} as const;

/**
 * Lane A's HTTP surface: identity, tenancy, team, invites, notification
 * preferences, the client flag map, and the super-admin tree.
 *
 * Prefixes are master's (`magick-master/src/index.ts:494-631` @a1f0756a), except
 * the client flag map: master's `/proxy/feature-flags` was a proxy to core's
 * `GET /api/v1/feature-flags`; in one app there is no proxy, so it is
 * `GET /feature-flags` (Phase 8 settles final paths).
 *
 * With `ctx` (a real process), the Redis cache and Firebase are initialised here,
 * before any route can run — master did both in `main()` before registering
 * routes (`index.ts:121,181`).
 */
export const platformPlugin: FastifyPluginAsync<{ ctx: AppContext | null }> = async (app, opts) => {
  const config = opts.ctx?.config ?? loadedConfig;

  if (opts.ctx) {
    // master `index.ts:181-184`. Channel is namespaced by hand: ioredis applies
    // `keyPrefix` to KEYS, not to pub/sub channel names.
    redisCache.init(opts.ctx.redis, {
      ...config.localCache,
      channel: `${config.redis.keyPrefix}cache:invalidate`,
    });
    if (!config.firebase && config.server.env === 'production') {
      // PORT NOTE (magick-agency): master's schema requires the block; agency's
      // keeps a minimal env parseable, so production refuses here instead.
      throw new Error('FIREBASE_PROJECT_ID is required in production (platform config block)');
    }
    await initFirebase(config);
  }

  /*
   * PORT NOTE (magick-agency, Phase 8): lane A registered `@fastify/rate-limit` here with
   * `global: false` so its per-route buckets (master's `POST /super-admin/login` 5/min, the
   * two public invite routes 20/min/IP, `PUBLIC_INVITE_RATE_LIMIT`) had a plugin to read their
   * route `config.rateLimit`. Phase 8 hoisted core's limiter to `app.ts` (global, as core and
   * master each registered theirs once), and that one registration honours those route
   * configs exactly as master's single global limiter did. A second registration here would
   * charge each of those routes twice, so it is removed; the routes' configs are unchanged.
   */

  const P = PLATFORM_ROUTE_PREFIXES;
  await app.register(authRoutes, { prefix: P.auth });
  await app.register(tenantRoutes, { prefix: P.tenants });
  await app.register(accountRoutes, { prefix: P.accounts });
  await app.register(userRoutes, { prefix: P.users });
  await app.register(inviteRoutes, { prefix: P.invites });
  await app.register(notificationRoutes, { prefix: P.notifications });
  await app.register(featureFlagsRoutes, { prefix: P.featureFlags });

  // master `index.ts:620-631`: the super-admin tree exists only with its JWT secret.
  if (config.superAdmin) {
    await app.register(superAdminRoutes, { prefix: P.superAdmin });
    await app.register(superAdminPhoneRoutes, { prefix: P.superAdmin });
    await app.register(superAdminFeatureFlagsRoutes, { prefix: P.superAdmin });
    await app.register(superAdminUsageCountsRoutes, { prefix: P.superAdmin });
    await app.register(superAdminAccountSettingsRoutes, { prefix: P.superAdmin });
  }
};
