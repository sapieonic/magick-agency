import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.stubGlobal('fetch', mocks.fetch);

import * as api from '../../api/super-admin';
import { SA_ROUTES } from '../../api/saRoutes';

/**
 * NEW (magick-agency). Brief: "Check every saFetch path your UI calls against
 * the routes registered on main." Two checks:
 *   1. every exported API function hits an entry of SA_ROUTES (and every entry
 *      is hit), so the list cannot drift from the code;
 *   2. every entry is a route the server registers.
 *
 * The server's route table is read with a regex over its route files, not
 * Fastify's `onRoute` hook: the UI package cannot import the server (no fastify
 * or DB dependencies here, and the server's context needs a full env). The
 * regex is covered by its own sanity case below (it must find the known floor).
 */

const norm = (path: string) => path.replace(/:[A-Za-z]+/g, ':p');
const key = (method: string, path: string) => `${method.toUpperCase()} ${norm(path)}`;

function templateToRegex(path: string): RegExp {
  const src = path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${src}$`);
}

// ── 1. functions ↔ SA_ROUTES ──────────────────────────────────────────────────

const NOT_ENDPOINTS = new Set(['setToken', 'clearToken', 'hasToken', 'saFetch', 'SuperAdminApiError']);

const CALLS: Record<string, () => Promise<unknown>> = {
  superAdminLogin: () => api.superAdminLogin('a@b.c', 'pw'),
  getSuperAdminMe: () => api.getSuperAdminMe(),
  listTenants: () => api.listTenants(),
  getTenantDetail: () => api.getTenantDetail('t1'),
  createTenant: () => api.createTenant({ name: 'n', owner_email: 'o@x.y' }),
  addUserToTenant: () => api.addUserToTenant('t1', { email: 'u@x.y', role: 'operator' }),
  changeMembershipRole: () => api.changeMembershipRole('t1', 'm1', { role: 'viewer' }),
  revokeMembership: () => api.revokeMembership('t1', 'm1'),
  listAllUsers: () => api.listAllUsers(),
  getTenantAccounts: () => api.getTenantAccounts('t1'),
  updateAccountConcurrency: () => api.updateAccountConcurrency('t1', 'a1', 5),
  getAccountConcurrency: () => api.getAccountConcurrency('t1', 'a1'),
  updateProviderConcurrency: () => api.updateProviderConcurrency('t1', 'a1', {
    mode: 'legacy_total', version: 1, max_concurrent_calls: 5, change_reason: 'because',
  }),
  getAccountSettings: () => api.getAccountSettings('t1', 'a1'),
  updateAccountSettings: () => api.updateAccountSettings('t1', 'a1', { allow_recording: true }),
  getUsageCounts: () => api.getUsageCounts({ from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' }),
  getFeatureFlagCatalog: () => api.getFeatureFlagCatalog(),
  resolveFeatureFlags: () => api.resolveFeatureFlags('t1', 'a1'),
  putFeatureFlagOverride: () => api.putFeatureFlagOverride('k', { scope_type: 'global', value: true }),
  deleteFeatureFlagOverride: () => api.deleteFeatureFlagOverride('k', { scope_type: 'global' }),
  bulkFeatureFlagOverride: () => api.bulkFeatureFlagOverride('k', { tenant_ids: ['t1'], value: true }),
  changePassword: () => api.changePassword('old', 'newpassword'),
  listAdmins: () => api.listAdmins(),
  createAdmin: () => api.createAdmin({ email: 'a@b.c', password: 'password1', name: 'N' }),
  removeAdmin: () => api.removeAdmin('ad1'),
  reactivateAdmin: () => api.reactivateAdmin('ad1'),
  resetAdminPassword: () => api.resetAdminPassword('ad1', { admin_password: 'x', new_password: 'password2' }),
  listAuditLog: () => api.listAuditLog(),
  listTelephonyProviders: () => api.listTelephonyProviders(),
  listPhoneNumbers: () => api.listPhoneNumbers({ status: 'active' }),
  getPhoneNumberDetail: () => api.getPhoneNumberDetail('p1'),
  createPhoneNumber: () => api.createPhoneNumber({ phone_number: '+911', provider_id: 'pr', max_concurrent_calls: 1 }),
  updatePhoneNumber: () => api.updatePhoneNumber('p1', { label: 'x' }),
  retirePhoneNumber: () => api.retirePhoneNumber('p1'),
  reactivatePhoneNumber: () => api.reactivatePhoneNumber('p1'),
  deletePhoneNumber: () => api.deletePhoneNumber('p1'),
  assignPhoneNumber: () => api.assignPhoneNumber('p1', { tenant_id: 't1' }),
  unassignPhoneNumber: () => api.unassignPhoneNumber('p1', 't1'),
  getTenantPhoneNumbers: () => api.getTenantPhoneNumbers('t1'),
};

describe('api/super-admin.ts ↔ SA_ROUTES', () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async () => new Response('{}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });

  const exported = Object.entries(api)
    .filter(([name, v]) => typeof v === 'function' && !NOT_ENDPOINTS.has(name))
    .map(([name]) => name);

  it('has a call fixture for every exported endpoint function (a new function must be added here)', () => {
    expect(exported.filter((n) => !(n in CALLS))).toEqual([]);
    expect(Object.keys(CALLS).filter((n) => !exported.includes(n))).toEqual([]);
  });

  const hit = new Set<string>();

  it.each(Object.keys(CALLS))('%s calls a listed route with the listed method', async (name) => {
    mocks.fetch.mockClear();
    await CALLS[name]!();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0]! as [string, RequestInit | undefined];
    const path = new URL(url, 'http://x').pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const match = SA_ROUTES.find((r) => r.method === method && templateToRegex(r.path).test(path));
    expect(match, `${method} ${path} is not in SA_ROUTES`).toBeTruthy();
    hit.add(key(match!.method, match!.path));
  });

  it('every SA_ROUTES entry is reached by some function (no dead entries)', () => {
    const unreached = SA_ROUTES.filter((r) => !hit.has(key(r.method, r.path))).map((r) => `${r.method} ${r.path}`);
    expect(unreached).toEqual([]);
  });
});

// ── 2. SA_ROUTES ↔ the server's route table ───────────────────────────────────

// happy-dom rewrites `import.meta.url` to http, so resolve from the cwd: tests
// run from inside the package (`cd apps/super-admin && pnpm test`).
const ROUTES_DIR = join(process.cwd(), '..', 'server', 'src', 'api', 'routes');

function serverSuperAdminRoutes(): Set<string> {
  const found = new Set<string>();
  const files = readdirSync(ROUTES_DIR).filter((f) => /^super-admin.*\.routes\.ts$/.test(f));
  for (const f of files) {
    const src = readFileSync(join(ROUTES_DIR, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const re = /\b(?:app|authApp)\.(get|post|put|delete|patch)(?:<[\s\S]*?>)?\(\s*'([^']+)'/g;
    for (let m = re.exec(src); m; m = re.exec(src)) {
      found.add(key(m[1]!, `/super-admin${m[2]!}`));
    }
  }
  return found;
}

/**
 * Server super-admin routes the UI does not call. A NEW server route fails the
 * "no unlisted server routes" case until someone decides: wire it or list it.
 */
const SERVER_ONLY_ALLOWLIST: Record<string, string> = {
  'GET /super-admin/feature-flags/:p': 'single-flag read; the catalog (GET /feature-flags) already carries every flag and its override',
};

describe('SA_ROUTES ↔ server route table', () => {
  const server = serverSuperAdminRoutes();

  it('extraction sanity: finds the known routes, including the typed-generic and login forms', () => {
    expect(server.size).toBeGreaterThanOrEqual(30);
    expect(server.has(key('POST', '/super-admin/login'))).toBe(true);
    expect(server.has(key('DELETE', '/super-admin/phone-numbers/:id/assign/:tenantId'))).toBe(true);
    expect(server.has(key('GET', '/super-admin/usage'))).toBe(true);
  });

  it('every path the UI calls is registered on the server', () => {
    const missing = SA_ROUTES.filter((r) => !server.has(key(r.method, r.path))).map((r) => `${r.method} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it('every server super-admin route is either called by the UI or on the explicit allow-list', () => {
    const ui = new Set(SA_ROUTES.map((r) => key(r.method, r.path)));
    const unlisted = [...server].filter((k) => !ui.has(k) && !(k in SERVER_ONLY_ALLOWLIST));
    expect(unlisted).toEqual([]);
  });

  it('the allow-list holds no stale entries', () => {
    expect(Object.keys(SERVER_ONLY_ALLOWLIST).filter((k) => !server.has(k))).toEqual([]);
  });
});
