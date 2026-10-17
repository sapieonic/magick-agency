import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';
import { insertAgencyCampaign } from './agency-factories.js';

/**
 * ─── `GET /api/v1/agency-campaigns/summaries`, against a real Postgres ────────
 *
 * The staffing plugin's `my-*` routes name an agent's campaigns with this one read
 * instead of one `GET /:id` per assignment. It must keep `requireOwned`'s rule —
 * tenant AND account — for every id in the set, in SQL
 * (`AgencyCampaignRepository.findOwnedSummaries`), which a mocked pool cannot show:
 * a campaign in a sibling account or another tenant must be absent, exactly as
 * `GET /:id` answers it 404. The feature gate and the account-header requirement
 * are the plugin's, asserted here through the real route.
 */

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const BASE = '/api/v1/agency-campaigns';
const OWNER = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };

describe('GET /api/v1/agency-campaigns/summaries (integration)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    app = Fastify({ logger: false });
    // The deps are not read by this route; registered through a closure as `core-handlers.ts` does.
    await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), { prefix: BASE });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(closeTestPool);

  async function summaries(ids: string[], headers: Record<string, string> = OWNER) {
    return app.inject({ method: 'GET', url: `${BASE}/summaries?ids=${ids.join(',')}`, headers });
  }

  it('names every owned campaign in the set, with its status', async () => {
    const a = await insertAgencyCampaign({ name: 'Q3 Renewals', status: 'running' });
    const b = await insertAgencyCampaign({ name: 'Collections', status: 'paused' });

    const res = await summaries([a.id as string, b.id as string]);

    expect(res.statusCode).toBe(200);
    const byId = new Map((res.json().campaigns as Array<{ id: string }>).map((c) => [c.id, c]));
    expect(byId.get(a.id as string)).toEqual({ id: a.id, name: 'Q3 Renewals', status: 'running' });
    expect(byId.get(b.id as string)).toEqual({ id: b.id, name: 'Collections', status: 'paused' });
    expect(byId.size).toBe(2);
  });

  it('omits a campaign in a SIBLING account of the same tenant — requireOwned compares the account too', async () => {
    const mine = await insertAgencyCampaign({ name: 'Mine' });
    const sibling = await insertAgencyCampaign({ name: 'Sibling', account_id: OTHER_ACCOUNT });

    const res = await summaries([mine.id as string, sibling.id as string]);

    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns).toEqual([{ id: mine.id, name: 'Mine', status: 'draft' }]);
  });

  it('omits a campaign in ANOTHER TENANT, even under the same account id', async () => {
    const foreign = await insertAgencyCampaign({ name: 'Foreign', tenant_id: OTHER_TENANT });

    const res = await summaries([foreign.id as string]);

    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns).toEqual([]);
  });

  it('omits an unknown id and a non-uuid one, and never answers 500 for either', async () => {
    const mine = await insertAgencyCampaign({ name: 'Mine' });

    const res = await summaries([randomUUID(), 'not-a-uuid', mine.id as string]);

    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns).toEqual([{ id: mine.id, name: 'Mine', status: 'draft' }]);
  });

  it('answers an empty set with an empty list, without a statement', async () => {
    const spy = vi.spyOn(getTestPool(), 'query');
    const res = await app.inject({ method: 'GET', url: `${BASE}/summaries`, headers: OWNER });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaigns: [] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('is behind the dialer flag like every other read (403 feature_disabled)', async () => {
    const mine = await insertAgencyCampaign();
    flags.isEnabled.mockResolvedValue(false);

    const res = await summaries([mine.id as string]);

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
  });

  it('refuses a request with no account context (the plugin\'s auth middleware)', async () => {
    const mine = await insertAgencyCampaign();

    const res = await summaries([mine.id as string], { 'x-mgkvc-tenant': DEFAULTS.tenantId });

    expect(res.statusCode).toBe(400);
  });

  it('refuses more than 100 ids rather than building an unbounded statement', async () => {
    const res = await summaries(Array.from({ length: 101 }, () => randomUUID()));

    expect(res.statusCode).toBe(400);
    expect(res.json().details.ids).toMatch(/at most 100/);
  });

  it('is not shadowed by GET /:id, and GET /:id still answers a real campaign', async () => {
    const mine = await insertAgencyCampaign({ name: 'Mine' });

    const one = await app.inject({ method: 'GET', url: `${BASE}/${mine.id as string}`, headers: OWNER });

    expect(one.statusCode).toBe(200);
    expect(one.json().name).toBe('Mine');
  });
});
