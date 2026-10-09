/**
 * Every super-admin endpoint the UI calls, as `METHOD /path-template`.
 *
 * NEW (magick-agency). `__tests__/api/saRoutes.test.ts` checks it both ways:
 * each exported function in `api/super-admin.ts` must hit an entry here, and
 * each entry must be a route the server registers
 * (`apps/server/src/api/routes/super-admin*.ts`). Param names are placeholders.
 */
export const SA_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: '/super-admin/login' },
  { method: 'GET', path: '/super-admin/me' },
  { method: 'PUT', path: '/super-admin/change-password' },

  { method: 'GET', path: '/super-admin/tenants' },
  { method: 'POST', path: '/super-admin/tenants' },
  { method: 'GET', path: '/super-admin/tenants/:id' },
  { method: 'POST', path: '/super-admin/tenants/:id/users' },
  { method: 'PUT', path: '/super-admin/tenants/:id/memberships/:membershipId/role' },
  { method: 'DELETE', path: '/super-admin/tenants/:id/memberships/:membershipId' },
  { method: 'GET', path: '/super-admin/users' },

  { method: 'GET', path: '/super-admin/tenants/:id/accounts' },
  { method: 'GET', path: '/super-admin/tenants/:id/accounts/:accountId/concurrency' },
  { method: 'PUT', path: '/super-admin/tenants/:id/accounts/:accountId/concurrency' },
  { method: 'GET', path: '/super-admin/tenants/:id/accounts/:accountId/settings' },
  { method: 'PUT', path: '/super-admin/tenants/:id/accounts/:accountId/settings' },

  { method: 'GET', path: '/super-admin/usage' },

  { method: 'GET', path: '/super-admin/feature-flags' },
  { method: 'GET', path: '/super-admin/feature-flags/resolve' },
  { method: 'PUT', path: '/super-admin/feature-flags/:flagKey/overrides' },
  { method: 'DELETE', path: '/super-admin/feature-flags/:flagKey/overrides' },
  { method: 'POST', path: '/super-admin/feature-flags/:flagKey/overrides/bulk' },

  { method: 'GET', path: '/super-admin/admins' },
  { method: 'POST', path: '/super-admin/admins' },
  { method: 'DELETE', path: '/super-admin/admins/:id' },
  { method: 'POST', path: '/super-admin/admins/:id/reactivate' },
  { method: 'PUT', path: '/super-admin/admins/:id/password' },

  { method: 'GET', path: '/super-admin/audit' },

  { method: 'GET', path: '/super-admin/telephony-providers' },
  { method: 'GET', path: '/super-admin/phone-numbers' },
  { method: 'POST', path: '/super-admin/phone-numbers' },
  { method: 'GET', path: '/super-admin/phone-numbers/:id' },
  { method: 'PUT', path: '/super-admin/phone-numbers/:id' },
  { method: 'DELETE', path: '/super-admin/phone-numbers/:id' },
  { method: 'POST', path: '/super-admin/phone-numbers/:id/reactivate' },
  { method: 'POST', path: '/super-admin/phone-numbers/:id/delete' },
  { method: 'POST', path: '/super-admin/phone-numbers/:id/assign' },
  { method: 'DELETE', path: '/super-admin/phone-numbers/:id/assign/:tenantId' },
  { method: 'GET', path: '/super-admin/tenants/:id/phone-numbers' },
];
