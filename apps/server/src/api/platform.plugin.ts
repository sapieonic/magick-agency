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
 * Every prefix the platform plugin registers a route plugin under. The route-table tests
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
 * The platform HTTP surface: identity, tenancy, team, invites, notification
 * preferences, the client flag map (`GET /feature-flags`), and the super-admin tree.
 *
 * With `ctx` (a real process), the Redis cache and Firebase are initialised here,
 * before any route can run.
 */
export const platformPlugin: FastifyPluginAsync<{ ctx: AppContext | null }> = async (app, opts) => {
  const config = opts.ctx?.config ?? loadedConfig;

  if (opts.ctx) {
    // The channel is namespaced by hand: ioredis applies
    // `keyPrefix` to KEYS, not to pub/sub channel names.
    redisCache.init(opts.ctx.redis, {
      ...config.localCache,
      channel: `${config.redis.keyPrefix}cache:invalidate`,
    });
    if (!config.firebase && config.server.env === 'production') {
      // The schema keeps the block optional so a minimal env parses; production
      // refuses here instead.
      throw new Error('FIREBASE_PROJECT_ID is required in production (platform config block)');
    }
    await initFirebase(config);
  }

  /*
   * No `@fastify/rate-limit` registration here: the one app-wide limiter in `app.ts`
   * honours these routes' `config.rateLimit` (`POST /super-admin/login` 5/min, the two
   * public invite routes 20/min/IP, `PUBLIC_INVITE_RATE_LIMIT`). A second registration
   * would charge each of those routes twice.
   */

  const P = PLATFORM_ROUTE_PREFIXES;
  await app.register(authRoutes, { prefix: P.auth });
  await app.register(tenantRoutes, { prefix: P.tenants });
  await app.register(accountRoutes, { prefix: P.accounts });
  await app.register(userRoutes, { prefix: P.users });
  await app.register(inviteRoutes, { prefix: P.invites });
  await app.register(notificationRoutes, { prefix: P.notifications });
  await app.register(featureFlagsRoutes, { prefix: P.featureFlags });

  // The super-admin tree exists only with its JWT secret.
  if (config.superAdmin) {
    await app.register(superAdminRoutes, { prefix: P.superAdmin });
    await app.register(superAdminPhoneRoutes, { prefix: P.superAdmin });
    await app.register(superAdminFeatureFlagsRoutes, { prefix: P.superAdmin });
    await app.register(superAdminUsageCountsRoutes, { prefix: P.superAdmin });
    await app.register(superAdminAccountSettingsRoutes, { prefix: P.superAdmin });
  }
};
