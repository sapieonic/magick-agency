import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';

/**
 * Plan §9 invariant, the agency API's half: **`agent` at level 5 reaches only the agent
 * surfaces** (lane A's `platform-agent-reach.test.ts` pins the platform half: session,
 * `/accounts/mine`, preferences, the flag map).
 *
 * NEW (magick-agency, Phase 8). Same method as lane A's suite, over the routes
 * `agencyPlugin` registers:
 *  1. every agency route is enumerated from Fastify's `onRoute` hook on the REAL app;
 *  2. each is called with a valid Firebase session for a user whose ONLY membership is
 *     `agent` on the tenant/account the headers name — the real session, tenant-context
 *     and `requirePermission` run; Firebase and the repositories under them are stubbed;
 *  3. a route is REFUSED when the guard chain answers it (the RBAC 403 "Insufficient
 *     permissions"); anything else means the agent got PAST the guards;
 *  4. the reached set must equal {@link EXPECTED_AGENT_REACHABLE} exactly.
 *
 * The agent's surfaces are the `my-*` reads now; the session/attempt actions join them when
 * the runtime routes land (after Phase 6), and this list grows by exactly those.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'test-super-admin-secret-at-least-16';
  return {
    reached: new Error('REACHED_HANDLER'),
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
// The profile surface checks `agency.analytics` (the account's `analyze_calls`) BEFORE its
// permission, as master's capability ran before its permission. Granted here so the
// question this suite asks — does the PERMISSION let an agent through — is the one answered.
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: reachedProxy({
    findByTenantAndAccount: async () => ({ allow_recording: true, analyze_calls: true }),
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
import { agencyPlugin, AGENCY_ROUTE_PREFIXES } from '../../../src/api/agency.plugin.js';

const EXPECTED_AGENT_REACHABLE = [
  'GET /proxy/agency/my-assignment',
  'GET /proxy/agency/my-assignments',
  'GET /proxy/agency/my-attempts',
  'GET /proxy/agency/my-campaigns',
  'GET /proxy/agency/my-stats',
  // The agent's own station actions (Phase 8, after Phase 6): `agency.station.connect`,
  // `agency.attempts.handle|dispose` and `agency.dnc.write` all floor at `agent`. Core then
  // enforces the reservation (`not_your_attempt`). `force-available` is NOT here: it is
  // `agency.supervise` (account_admin).
  'POST /proxy/agency/attempts/:id/disposition',
  'POST /proxy/agency/attempts/:id/dnc',
  'POST /proxy/agency/attempts/:id/hangup',
  'POST /proxy/agency/attempts/:id/notes',
  'POST /proxy/agency/sessions',
  'POST /proxy/agency/sessions/:id/available',
  'POST /proxy/agency/sessions/:id/break',
  'POST /proxy/agency/sessions/:id/break/cancel',
  'POST /proxy/agency/sessions/:id/leave',
  'POST /proxy/agency/sessions/:id/station-token',
].sort();

/**
 * WebSocket routes are not HTTP surfaces: a browser `WebSocket` cannot send the Firebase
 * bearer, so the station socket is authenticated by the single-use station token minted at
 * the authenticated `POST /sessions` / `/station-token` (core `station-token.ts`; refusals in
 * `agency-station-route.test.ts` and the station route suite). It is excluded from the two
 * HTTP sweeps below and pinned here instead.
 */
const WEBSOCKET_ROUTES = ['GET /proxy/agency/station/:sessionId'];

let app: FastifyInstance;
const routes: Array<{ method: string; url: string }> = [];
const pluginRoutes: Array<{ method: string; url: string }> = [];
const wsRoutes: string[] = [];

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

  // The agency set is what `agencyPlugin` registers on its own, not a list kept beside it.
  const bare = Fastify({ logger: false });
  bare.addHook('onRoute', (r: RouteOptions) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') pluginRoutes.push({ method: m, url: r.url });
    if ((r as { websocket?: boolean }).websocket === true) wsRoutes.push(`GET ${r.url}`);
  });
  await bare.register(agencyPlugin, { ctx: null });
  await bare.ready();
  await bare.close();
});

afterAll(async () => {
  await app.close();
});

const keyOf = (r: { method: string; url: string }) => `${r.method} ${r.url.replace(/\/$/, '') || '/'}`;

function agencyRoutes(): Array<{ method: string; url: string; key: string }> {
  const own = new Set(pluginRoutes.map(keyOf));
  return [...new Map(routes.map((r) => [keyOf(r), { ...r, key: keyOf(r) }])).values()]
    .filter((r) => own.has(r.key) && !wsRoutes.includes(r.key));
}

const UUID_PARAM = '00000000-0000-4000-8000-0000000000e1';
const concrete = (url: string) => url.replace(/:[A-Za-z]+/g, UUID_PARAM);

async function callAsAgent(method: string, url: string) {
  return app.inject({
    method: method as 'GET',
    url: concrete(url),
    headers: {
      authorization: 'Bearer agent-token',
      'x-tenant-id': TENANT,
      'x-account-id': ACCOUNT,
      ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
    },
    payload: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
  });
}

function refusedByGuards(res: { statusCode: number; body: string }): boolean {
  if (res.statusCode !== 403) return false;
  try {
    const body = JSON.parse(res.body) as { message?: string };
    return typeof body.message === 'string' && body.message.startsWith('Insufficient permissions');
  } catch {
    return false;
  }
}

describe('agency route table — the agent invariant (plan §9)', () => {
  it('enumerates the agency routes from onRoute, every one under an agency prefix', () => {
    const rs = agencyRoutes();
    expect(rs.length).toBeGreaterThan(40);
    expect([...new Set(wsRoutes)]).toEqual(WEBSOCKET_ROUTES);
    expect(new Set(rs.map((r) => r.key))).toEqual(new Set(pluginRoutes.map(keyOf).filter((k) => !wsRoutes.includes(k))));
    const prefixes = Object.values(AGENCY_ROUTE_PREFIXES);
    for (const r of rs) {
      expect(prefixes.some((p) => r.url === p || r.url.startsWith(`${p}/`)), r.url).toBe(true);
    }
  });

  it('an agent gets past the guards on exactly the agent surfaces', async () => {
    const reached: string[] = [];
    for (const r of agencyRoutes()) {
      const res = await callAsAgent(r.method, r.url);
      if (!refusedByGuards(res)) reached.push(r.key);
    }
    expect(reached.sort()).toEqual(EXPECTED_AGENT_REACHABLE);
  });

  it('every agency route needs a session: no route answers an unauthenticated caller', async () => {
    const open: string[] = [];
    for (const r of agencyRoutes()) {
      const res = await app.inject({
        method: r.method as 'GET',
        url: concrete(r.url),
        headers: { 'x-tenant-id': TENANT, 'x-account-id': ACCOUNT },
      });
      if (res.statusCode !== 401) open.push(`${r.key} → ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});
