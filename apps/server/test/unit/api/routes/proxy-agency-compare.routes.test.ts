import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Compare agents' routes with every dependency faked through `deps` (the SQL, the guards and the
 * figures are held on Postgres in `test/integration/api/compare-agents.test.ts`): what the routes
 * themselves decide.
 *
 *  - The options read never holds two pooled connections: the campaign's default view is read only
 *    once the cohort's snapshot has ended (the snapshot holds one connection until then, and the
 *    process-wide limit counts one per read).
 *  - An edit of a saved view that does not send `is_campaign_default` asks the repository to keep
 *    the row's value as it stands in the update's transaction (null), never the value the route
 *    read before it: another supervisor's new default, made meanwhile, is not undone by a rename
 *    (the repository's side is held on Postgres in `compare-view-repository.test.ts`).
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { proxyAgencyCompareRoutes } from '../../../../src/api/routes/proxy-agency-compare.routes.js';
import type { CompareRouteDeps } from '../../../../src/api/routes/proxy-agency-compare/shared.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';
const VIEW = '66666666-6666-4666-8666-666666666666';

let app: FastifyInstance;
let log: string[];
let finishCohort: () => void;
let updates: Array<Record<string, unknown>>;

function storedView() {
  return {
    id: VIEW, tenant_id: TENANT, account_id: ACCOUNT, owner_user_id: ME, name: 'Mornings', lens: 'sales',
    metrics: [{ kind: 'builtin', key: 'calls_handled' }], trend: null, campaign_id: CAMPAIGN, shared: true,
    is_campaign_default: true, created_at: new Date('2026-11-01T00:00:00Z'), updated_at: new Date('2026-11-01T00:00:00Z'),
  };
}

beforeEach(async () => {
  log = [];
  updates = [];
  let release: () => void = () => undefined;
  const cohortDone = new Promise<void>((res) => { release = res; });
  finishCohort = release;
  const deps: Partial<CompareRouteDeps> = {
    reads: {
      cohort: vi.fn(async () => {
        log.push('cohort snapshot begins');
        await cohortDone;
        log.push('cohort snapshot ends');
        return { agents: [] };
      }),
      clear: () => undefined,
    } as never,
    views: {
      findCampaignDefault: vi.fn(async () => { log.push('default view read'); return null; }),
      // The row as the route reads it before the edit's transaction: the campaign's default then.
      findOwned: vi.fn(async () => storedView()),
      update: vi.fn(async (_scope: unknown, _id: string, content: Record<string, unknown>) => {
        updates.push(content);
        return { ...storedView(), ...content, is_campaign_default: content['is_campaign_default'] ?? false };
      }),
    } as never,
    compareEnabled: async () => true,
    campaign: async () => ({ id: CAMPAIGN, name: 'Collections', codes: [] }),
    names: async () => new Map(),
    databaseZone: async (zone) => zone,
    today: () => '2026-11-20',
    now: () => new Date('2026-11-20T06:00:00Z'),
  };
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: ME };
    r['membership'] = { role: 'account_admin', account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyCompareRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

describe('GET /compare/options', () => {
  it('reads the campaign\'s default view only after the cohort\'s snapshot has ended', async () => {
    const pending = app.inject({
      method: 'GET',
      url: `/proxy/agency/compare/options?campaign_id=${CAMPAIGN}&from=2026-11-18&to=2026-11-19&timezone=Asia%2FKolkata`,
    });
    await vi.waitFor(() => expect(log).toContain('cohort snapshot begins'));
    await new Promise((r) => setTimeout(r, 20));
    // The snapshot still holds its connection: nothing else is read meanwhile.
    expect(log).toEqual(['cohort snapshot begins']);
    finishCohort();
    const res = await pending;
    expect(res.statusCode, res.body).toBe(200);
    expect(log).toEqual(['cohort snapshot begins', 'cohort snapshot ends', 'default view read']);
  });
});

describe('PATCH /compare/views/:id', () => {
  const patch = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: `/proxy/agency/compare/views/${VIEW}`, payload });

  it('a rename that does not send is_campaign_default asks to keep the row\'s value (null), not the value read before', async () => {
    const res = await patch({ name: 'Renamed' });
    expect(res.statusCode, res.body).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ name: 'Renamed', is_campaign_default: null });
  });

  it('a sent value is passed as sent', async () => {
    expect((await patch({ is_campaign_default: false })).statusCode).toBe(200);
    expect((await patch({ is_campaign_default: true })).statusCode).toBe(200);
    expect(updates.map((u) => u['is_campaign_default'])).toEqual([false, true]);
  });
});
