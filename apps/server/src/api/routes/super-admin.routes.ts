import type { FastifyInstance } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { registerSuperAdminLoginRoute } from './super-admin/login.js';
import { registerSuperAdminAccountRoutes } from './super-admin/account.js';
import { registerSuperAdminTenantRoutes } from './super-admin/tenants.js';
import { registerSuperAdminAdminRoutes } from './super-admin/admins.js';
import { registerSuperAdminConcurrencyRoutes } from './super-admin/concurrency.js';

/*
 * Super-admin routes, serving the super-admin console: login (5/min), `/me`,
 * `/change-password`, tenants list/create/detail, add user (with an `account_id`,
 * issuing an invite), users, role change and revoke on a membership, admins
 * (create, list, delete, reactivate, reset password), audit, accounts +
 * concurrency. Deliberately absent:
 *  - credits — no credits in v1 (decision S6);
 *  - AI pipeline/provider service settings — there is no AI calling
 *    (decision S7);
 *  - tenant delete — not part of the super-admin surface;
 *  - concurrency synchronization and drift tracking — this server is both the
 *    system of record and the enforcer, so there is nothing to synchronize or
 *    drift;
 *  - telephony-provider catalog checks on a provider breakdown — one carrier;
 *  - a broadcast-cap cache invalidation — no broadcast campaigns.
 */

export async function superAdminRoutes(app: FastifyInstance): Promise<void> {
  // The login (`./super-admin/login.ts`) sits outside the authenticated scope.
  await registerSuperAdminLoginRoute(app);

  // ── All routes below require super admin JWT ──────────
  await app.register(async function authenticatedRoutes(authApp) {
    authApp.addHook('preHandler', superAdminMiddleware);

    // The routes, by family (`./super-admin/`), inside this one authenticated scope.
    await registerSuperAdminAccountRoutes(authApp);
    await registerSuperAdminTenantRoutes(authApp);
    await registerSuperAdminAdminRoutes(authApp);
    await registerSuperAdminConcurrencyRoutes(authApp);
  }); // end authenticatedRoutes sub-plugin
}
