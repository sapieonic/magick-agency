import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * Plan §9 invariant, lane A's half: **`agent` at level 5 reaches only the agent
 * surfaces plus session, `/accounts/mine` and notification preferences.**
 *
 * NEW (magick-agency). Master pinned the same property as a permission-matrix
 * fact (`test/unit/rbac/roles.agent.test.ts`, ported against the contract); this
 * pins it at the point of CONSUMPTION, over the real route table:
 *
 *  1. Every lane-A route is enumerated from Fastify's own `onRoute` hook (handoff
 *     rule 10 — never by grep), with the super-admin tree registered.
 *  2. Each route is called with a valid Firebase session for a user whose ONLY
 *     membership is `agent` on the tenant/account the headers name. The real
 *     session middleware, tenant-context middleware and `requirePermission` run;
 *     Firebase and the repositories under them are stubbed.
 *  3. A route is REFUSED when the guard chain answers it — the RBAC 403
 *     ("Insufficient permissions"), or the super-admin JWT 401. Anything else
 *     (including a handler that fails on the stubbed I/O) means the agent got
 *     PAST the guards, i.e. reached the route.
 *  4. The reached set must equal {@link EXPECTED_AGENT_REACHABLE}, exactly — a
 *     route that newly admits an agent fails, and so does one that newly refuses
 *     the console's bootstrap reads.
 *
 * Every route must also be CLASSIFIED in {@link ROUTE_CLASS}, so a new route
 * cannot land without somebody deciding whether an agent may use it.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
  const reached = new Error('REACHED_HANDLER');
  return {
    reached,
    verifyIdToken: vi.fn(),
    agentUser: {
      id: '00000000-0000-4000-8000-0000000000a1',
      firebase_uid: 'fb-agent',
      email: 'agent@example.com',
      display_name: 'Agent',
      avatar_url: null,
      status: 'active',
      phone_number: '0000000000',
      email_unverified: false,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
  };
});

const TENANT = '00000000-0000-4000-8000-0000000000b1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

/** Any repository method a handler reaches past the guards throws the sentinel. */
function reachedProxy(known: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(known, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'then') return undefined;
      return () => { throw mocks.reached; };
    },
  });
}

vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: reachedProxy({
    findByFirebaseUid: async (uid: string) => (uid === 'fb-agent' ? mocks.agentUser : null),
  }),
}));
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: reachedProxy({
    findByUserAndTenant: async (userId: string, tenantId: string) =>
      userId === mocks.agentUser.id && tenantId === TENANT
        ? [{
            id: '00000000-0000-4000-8000-0000000000d1',
            user_id: mocks.agentUser.id,
            tenant_id: TENANT,
            account_id: ACCOUNT,
            role: 'agent',
            status: 'active',
            invited_by: null,
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          }]
        : [],
  }),
}));
vi.mock('../../../src/services/tenant-name-resolver.js', () => ({
  getCachedAccountRecord: async (id: string) => (id === ACCOUNT ? { id: ACCOUNT, tenant_id: TENANT, name: 'Acct' } : null),
  getCachedTenantRecord: async () => ({ id: TENANT, name: 'Tenant' }),
  resolveTenantAccountNames: async () => ({ tenantName: 'Tenant', accountName: 'Acct' }),
  invalidateTenantRecordCache: async () => {},
  invalidateAccountRecordCache: async () => {},
}));

import Fastify from 'fastify';
import { buildApp } from '../../../src/app.js';
import { platformPlugin, PLATFORM_ROUTE_PREFIXES } from '../../../src/api/platform.plugin.js';

/**
 * How each lane-A route is meant to be reached. `public` routes run no session
 * at all (the token, or the login, is the credential); `agent` routes are the
 * console bootstrap and self-service reads the invariant names; `floor` routes
 * carry a permission an agent does not hold; `super_admin` routes are the
 * separate JWT tree.
 */
type RouteClass = 'public' | 'agent' | 'floor' | 'super_admin';

/**
 * The exact set an `agent` gets past the guards on. `/feature-flags` is the
 * client flag map — `agency.flags.read`, floored at `agent` in the contract
 * because the console cannot render any flag-gated agent route without it
 * (`@magick-agency/contracts/rbac`, the `agency.flags.read` entry).
 */
const EXPECTED_AGENT_REACHABLE = [
  'GET /accounts/mine',
  'GET /auth/me',
  'GET /feature-flags',
  'GET /notifications/preferences',
  'POST /auth/session',
  'PUT /notifications/preferences',
].sort();

/** Unauthenticated by design; asserted separately (they never consult a session). */
const PUBLIC_ROUTES = new Set([
  'POST /auth/session',
  'GET /invites/:token',
  'POST /invites/:token/claim',
  'POST /super-admin/login',
]);

function classify(route: string): RouteClass {
  if (PUBLIC_ROUTES.has(route)) return 'public';
  if (route.split(' ')[1]!.startsWith('/super-admin')) return 'super_admin';
  if (EXPECTED_AGENT_REACHABLE.includes(route)) return 'agent';
  return 'floor';
}

let app: FastifyInstance;
const routes: Array<{ method: string; url: string }> = [];
/** Every route the platform plugin ALONE registers — the authoritative lane-A set. */
const pluginRoutes: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (token === 'agent-token') return { uid: 'fb-agent', email: 'agent@example.com', email_verified: true };
    throw new Error('bad token');
  });
  app = await buildApp({
    ctx: null,
    onRoute: (r: RouteOptions) => {
      const methods = Array.isArray(r.method) ? r.method : [r.method];
      for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') routes.push({ method: m, url: r.url });
    },
  });
  await app.ready();

  // Capture the registering plugin itself, so the lane-A set is what
  // `platformPlugin` registers, not a list kept beside it.
  const bare = Fastify({ logger: false });
  bare.addHook('onRoute', (r: RouteOptions) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') pluginRoutes.push({ method: m, url: r.url });
  });
  await bare.register(platformPlugin, { ctx: null });
  await bare.ready();
  await bare.close();
});

afterAll(async () => {
  await app.close();
});

const keyOf = (r: { method: string; url: string }) => `${r.method} ${r.url.replace(/\/$/, '') || '/'}`;

/**
 * Lane A's routes: everything the platform plugin registers, taken from the
 * REAL app's route table (so the real hook chain is what is exercised), keyed
 * by the routes the plugin registers on its own.
 */
function laneARoutes(): Array<{ method: string; url: string; key: string }> {
  const own = new Set(pluginRoutes.map(keyOf));
  return routes.map((r) => ({ ...r, key: keyOf(r) })).filter((r) => own.has(r.key));
}

function concrete(url: string): string {
  return url
    .replace(/:tenantId|:id(?=\/|$)/g, TENANT)
    .replace(/:accountId/g, ACCOUNT)
    .replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-0000000000e1');
}

async function callAsAgent(method: string, url: string) {
  return app.inject({
    method: method as 'GET',
    url: concrete(url),
    headers: {
      authorization: 'Bearer agent-token',
      'x-tenant-id': TENANT,
      'x-account-id': ACCOUNT,
      ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
    },
    payload: method === 'GET' ? undefined : JSON.stringify({}),
  });
}

function refusedByGuards(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode === 401) return true; // super-admin JWT (an agent's Firebase token is not one)
  if (res.statusCode !== 403) return false;
  try {
    const body = JSON.parse(res.body) as { message?: string };
    return typeof body.message === 'string' && body.message.startsWith('Insufficient permissions');
  } catch {
    return false;
  }
}

describe('lane A route table — the agent invariant (plan §9)', () => {
  it('enumerates the platform routes from onRoute, super-admin tree included', () => {
    const keys = laneARoutes().map((r) => r.key);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).toEqual(expect.arrayContaining(['POST /auth/session', 'GET /accounts/mine', 'POST /super-admin/login']));
    // Every route the plugin registers is in the real app, under one of the
    // plugin's exported prefixes, and every prefix carries at least one route.
    expect(new Set(keys)).toEqual(new Set(pluginRoutes.map(keyOf)));
    const prefixes = Object.values(PLATFORM_ROUTE_PREFIXES);
    for (const r of pluginRoutes) {
      expect(prefixes.some((p) => r.url === p || r.url.startsWith(`${p}/`)), r.url).toBe(true);
    }
    for (const p of prefixes) {
      expect(pluginRoutes.some((r) => r.url === p || r.url.startsWith(`${p}/`)), p).toBe(true);
    }
  });

  it('an agent gets past the guards on exactly the agent surfaces plus session, /accounts/mine and preferences', async () => {
    const reached: string[] = [];
    for (const r of laneARoutes()) {
      if (PUBLIC_ROUTES.has(r.key) && r.key !== 'POST /auth/session') continue;
      const res = await callAsAgent(r.method, r.url);
      if (!refusedByGuards(res)) reached.push(r.key);
    }
    expect(reached.sort()).toEqual(EXPECTED_AGENT_REACHABLE);
  });

  it('every route that is neither public nor an agent surface refuses the agent at the guard', async () => {
    for (const r of laneARoutes()) {
      const cls = classify(r.key);
      if (cls === 'public' || cls === 'agent') continue;
      const res = await callAsAgent(r.method, r.url);
      expect(refusedByGuards(res), `${r.key} answered ${res.statusCode} ${res.body}`).toBe(true);
    }
  });

  it('the public routes are the only ones that need no session at all', async () => {
    const unauthenticated: string[] = [];
    for (const r of laneARoutes()) {
      const res = await app.inject({ method: r.method as 'GET', url: concrete(r.url), payload: r.method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) unauthenticated.push(r.key);
    }
    expect(unauthenticated.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });
});
