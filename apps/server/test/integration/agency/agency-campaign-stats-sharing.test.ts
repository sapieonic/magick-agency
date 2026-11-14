import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgencyContacts } from './agency-factories.js';

/*
 * `GET /api/v1/agency-campaigns/:id/stats` on real Postgres, with its campaign reads shared
 * between requests (`agency/campaign-stats-reads.ts`, `AGENCY_CAMPAIGN_STATS_CACHE_MS`):
 *  - concurrent viewers of one campaign cost ONE `stats()` and ONE `healthInputs()`, and every
 *    one of them gets the database's numbers;
 *  - the writes a supervisor re-reads after reach the next read: a campaign row write (the real
 *    repository's `campaign_changed`) and contacts arriving (`contacts_changed`, as the roster
 *    ingest publishes it);
 *  - a write that announces nothing is seen once the shared read has expired, and at once with
 *    `0`, which still shares a read in flight.
 * The cache's own rules: `test/unit/agency/campaign-stats-reads.test.ts`; through the route with
 * a mocked repository (authorisation first, per-request strip):
 * `test/unit/agency/campaign-stats-route-sharing.test.ts`.
 */

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { publishPacingInvalidation } = await import('../../../src/agency/pacing/invalidation-bus.js');
const { TtlCache } = await import('@magick-agency/db/utils/ttl-cache');

const HEADERS = { 'x-mgkvc-tenant': DEFAULTS.tenantId, 'x-mgkvc-account': DEFAULTS.accountId };

function deps(statsCacheMs: number): AgencyCampaignRouteDeps {
  return {
    runtime: {
      dnc: { appliedVersion: async () => 7 },
      stations: {
        connectedBySession: async (ids: readonly string[]) => new Map(ids.map((id) => [id, true])),
        inboundCapabilityBySession: (ids: readonly string[]) => new Map(ids.map((id) => [id, true])),
      },
    },
    callManager: {
      accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'available' as const, count: 0 }) },
    },
    statsCacheMs,
  };
}

const apps: FastifyInstance[] = [];
async function buildApp(statsCacheMs: number): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  // Wrapped in a closure, as `core-handlers.ts` registers it.
  await app.register(async (scope) => agencyCampaignRoutes(scope, deps(statsCacheMs)), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  apps.push(app);
  return app;
}

async function getStats(app: FastifyInstance, campaignId: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/agency-campaigns/${campaignId}/stats`, headers: HEADERS });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
}

/** The contact counters straight from the table. */
async function contactTruth(campaignId: string) {
  const { rows } = await getTestPool().query<{ contacts_total: number; contacts_pending: number; contacts_completed: number }>(
    `SELECT count(*)::int AS contacts_total,
            count(*) FILTER (WHERE state = 'pending')::int AS contacts_pending,
            count(*) FILTER (WHERE state = 'completed')::int AS contacts_completed
       FROM agency_contacts WHERE campaign_id = $1`,
    [campaignId],
  );
  return rows[0]!;
}

describe('GET /api/v1/agency-campaigns/:id/stats · one read for every viewer (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0)) await app.close();
  });

  afterAll(closeTestPool);

  it('ten supervisors asking at once cost one read of each kind, and all see the database', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgencyContacts(campaign.id, 12);
    await insertAgencyContact(campaign.id, { source_row_number: 100, state: 'completed' });
    const stats = vi.spyOn(agencyCampaignRepository, 'stats');
    const health = vi.spyOn(agencyCampaignRepository, 'healthInputs');
    const app = await buildApp(2_000);

    const bodies = await Promise.all(Array.from({ length: 10 }, () => getStats(app, campaign.id)));

    expect(stats).toHaveBeenCalledTimes(1);
    expect(health).toHaveBeenCalledTimes(1);
    for (const body of bodies) {
      expect(body).toMatchObject({ campaign_id: campaign.id, status: 'running', ...(await contactTruth(campaign.id)) });
      expect(body).toEqual(bodies[0]);
    }
  });

  it("a write to the campaign row reaches the next read: the abandonment ceiling `stats()` reads", async () => {
    const campaign = await insertAgencyCampaign({ status: 'running', abandonment_ceiling_pct: 3 });
    const stats = vi.spyOn(agencyCampaignRepository, 'stats');
    const app = await buildApp(60_000);

    expect(Number((await getStats(app, campaign.id)).abandonment_ceiling_pct)).toBe(3);
    expect(Number((await getStats(app, campaign.id)).abandonment_ceiling_pct)).toBe(3);
    expect(stats).toHaveBeenCalledTimes(1);

    // The settings save's write, through the real repository (it publishes `campaign_changed`).
    await agencyCampaignRepository.update(campaign.id, { abandonment_ceiling_pct: 5 });

    expect(Number((await getStats(app, campaign.id)).abandonment_ceiling_pct)).toBe(5);
    expect(stats).toHaveBeenCalledTimes(2);
  });

  it('a lifecycle transition reaches the next read, both the status and the counters behind it', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgencyContacts(campaign.id, 3);
    const app = await buildApp(60_000);
    expect(await getStats(app, campaign.id)).toMatchObject({ status: 'running', contacts_pending: 3 });

    // A contact settles (nothing announces it), then a supervisor pauses (the row write does).
    await getTestPool().query(
      `UPDATE agency_contacts SET state = 'completed' WHERE campaign_id = $1 AND source_row_number = 1`, [campaign.id],
    );
    await agencyCampaignRepository.transitionStatus(campaign.id, ['running'], 'paused');

    expect(await getStats(app, campaign.id)).toMatchObject({ status: 'paused', contacts_pending: 2, contacts_completed: 1 });
  });

  it('contacts arriving (contacts_changed, as each roster chunk publishes it) reach the next read', async () => {
    const campaign = await insertAgencyCampaign({ status: 'draft' });
    const app = await buildApp(60_000);
    expect((await getStats(app, campaign.id)).contacts_total).toBe(0);

    await insertAgencyContacts(campaign.id, 4);
    publishPacingInvalidation({ type: 'contacts_changed', campaignId: campaign.id });

    expect((await getStats(app, campaign.id)).contacts_total).toBe(4);
  });

  it('a write that announces nothing is served from the shared read until it expires, then seen', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgencyContacts(campaign.id, 2);
    const app = await buildApp(300);
    expect((await getStats(app, campaign.id)).contacts_total).toBe(2);

    await insertAgencyContact(campaign.id, { source_row_number: 3 });
    // Within the TTL: the shared read (the trade the cache makes, bounded by its TTL).
    expect((await getStats(app, campaign.id)).contacts_total).toBe(2);

    await new Promise((r) => setTimeout(r, 350));
    expect((await getStats(app, campaign.id)).contacts_total).toBe(3);
  });

  it('with 0, a read that starts after a write always sees it, and concurrent viewers still share one read', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgencyContacts(campaign.id, 2);
    const app = await buildApp(0);
    expect((await getStats(app, campaign.id)).contacts_total).toBe(2);
    await insertAgencyContact(campaign.id, { source_row_number: 3 });
    expect((await getStats(app, campaign.id)).contacts_total).toBe(3);

    // Hold the read open until every viewer has asked, so they provably overlap.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = agencyCampaignRepository.stats.bind(agencyCampaignRepository);
    const stats = vi.spyOn(agencyCampaignRepository, 'stats').mockImplementation(async (id) => {
      await gate;
      return original(id);
    });
    const asked = vi.spyOn(TtlCache.prototype, 'getOrLoad');
    const pending = Array.from({ length: 5 }, () => getStats(app, campaign.id));
    // Every request past its guard and into the shared read before the read may finish.
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(5));
    release();
    for (const body of await Promise.all(pending)) expect(body.contacts_total).toBe(3);
    expect(stats).toHaveBeenCalledTimes(1);
  });
});
