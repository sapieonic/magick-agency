import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * `GET /api/v1/agency-campaigns/:id/stats` shares its campaign's two SQL reads between the
 * requests for it (`agency/campaign-stats-reads.ts`). Through the real route plugin:
 *  - concurrent requests for one campaign run `stats()` and `healthInputs()` once, while every
 *    per-request part of the payload (the campaign row and its status, DNC, concurrency, the
 *    account limit, liveness) is still read once PER REQUEST;
 *  - `ownedCampaign` still runs for every request, before anything shared is served: a caller
 *    from another tenant gets the 404 and a caller with the dialer flag off the 403, with the
 *    campaign's read warm;
 *  - a `campaign_changed` event drops the read, and closing the app stops listening;
 *  - each answer says whether its read ran for it (`x-mgkvc-stats-read`), and the in-process
 *    `x-mgkvc-stats-fresh` header reads past the shared read without disturbing it.
 * The cache itself: `campaign-stats-reads.test.ts`.
 */

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// A TTL far longer than any test, so a second read in a test can only come from sharing ending
// for a reason the test names.
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, agency: { campaignStatsCacheMs: 60_000 }, telephony: {} },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: (req: any) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: any) => req.headers['x-mgkvc-account'] ?? 'a1',
  getOriginator: () => null,
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns, attempts, accountSettings } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn(), stats: vi.fn(), healthInputs: vi.fn(), countRunningForAccount: vi.fn() },
  attempts: { countLiveForAccount: vi.fn() },
  accountSettings: { getMaxConcurrentCalls: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAttemptRepository: attempts,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: accountSettings,
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';
import { resetPacingInvalidationBusForTests } from '../../../src/agency/pacing/invalidation-bus.js';

const CAMPAIGN_ID = '11111111-2222-4333-8444-555555555555';
const URL = `/api/v1/agency-campaigns/${CAMPAIGN_ID}/stats`;
const OWNER = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

const CAMPAIGN_ROW = {
  id: CAMPAIGN_ID, tenant_id: 't1', account_id: 'a1',
  status: 'running', pause_reason: null, paused_at: null,
  pause_abandonment_rate_pct: null, abandonment_ceiling_pct: 3,
};

const SESSION = '99999999-8888-4777-8666-555555555555';
const STATS = {
  contacts_total: 1234, contacts_pending: 0, retries_pending: 0, agents_live: 1, attempts_live: 2,
  agents_by_state: { offline: 0, available: 1, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
  agents: [{ session_id: SESSION, agent_user_id: 'u1', state: 'available' }],
};

const HEALTH_INPUTS = {
  pendingByTimezone: [], nextRetryAt: null, lastDialAt: null,
  recent: { attempts: 0, failed: 0 }, onBreakByReason: {},
};

const deps = {
  runtime: {
    dnc: { appliedVersion: vi.fn() },
    stations: { connectedBySession: vi.fn(), inboundCapabilityBySession: vi.fn() },
  },
  callManager: { accountConcurrencyGuard: { getDistributedAccountCount: vi.fn() } },
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, deps as never), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

let bus: ReturnType<typeof resetPacingInvalidationBusForTests>;

beforeEach(() => {
  vi.clearAllMocks();
  bus = resetPacingInvalidationBusForTests();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  campaigns.stats.mockResolvedValue(STATS);
  campaigns.healthInputs.mockResolvedValue(HEALTH_INPUTS);
  campaigns.countRunningForAccount.mockResolvedValue(1);
  attempts.countLiveForAccount.mockResolvedValue(2);
  accountSettings.getMaxConcurrentCalls.mockResolvedValue(10);
  deps.runtime.dnc.appliedVersion.mockResolvedValue(7);
  deps.runtime.stations.connectedBySession.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, true])));
  deps.runtime.stations.inboundCapabilityBySession.mockImplementation((ids: string[]) => new Map(ids.map((id) => [id, true])));
  deps.callManager.accountConcurrencyGuard.getDistributedAccountCount.mockResolvedValue({ status: 'available', count: 3 });
});

describe('GET /agency-campaigns/:id/stats · one read for every viewer', () => {
  it('runs the campaign reads once for concurrent requests, and everything per-request once per request', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    campaigns.stats.mockImplementation(async () => { await gate; return STATS; });
    const app = await buildApp();
    try {
      const pending = Array.from({ length: 6 }, () => app.inject({ method: 'GET', url: URL, headers: OWNER }));
      // Let every request through its preHandler and into the shared read before it settles.
      await vi.waitFor(() => expect(campaigns.findById).toHaveBeenCalledTimes(6));
      await new Promise((r) => setImmediate(r));
      release();
      const responses = await Promise.all(pending);

      for (const res of responses) {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          campaign_id: CAMPAIGN_ID, status: 'running', contacts_total: 1234,
          concurrency_in_use: 3, concurrency_limit: 10,
          agents: [{ session_id: SESSION, connected: true, can_take_inbound: true }],
        });
      }
      // The SQL half: once.
      expect(campaigns.stats).toHaveBeenCalledTimes(1);
      expect(campaigns.healthInputs).toHaveBeenCalledTimes(1);
      // Authorisation and every per-request read: once per request.
      expect(campaigns.findById).toHaveBeenCalledTimes(6);
      expect(flags.isEnabled).toHaveBeenCalledTimes(6);
      expect(deps.runtime.dnc.appliedVersion).toHaveBeenCalledTimes(6);
      expect(deps.callManager.accountConcurrencyGuard.getDistributedAccountCount).toHaveBeenCalledTimes(6);
      expect(accountSettings.getMaxConcurrentCalls).toHaveBeenCalledTimes(6);
      expect(deps.runtime.stations.connectedBySession).toHaveBeenCalledTimes(6);
      expect(deps.runtime.stations.inboundCapabilityBySession).toHaveBeenCalledTimes(6);
      expect(attempts.countLiveForAccount).toHaveBeenCalledTimes(6);
    } finally {
      await app.close();
    }
  });

  it('serves a settled read to a later request, with that request\'s own campaign row', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: URL, headers: OWNER })).json().status).toBe('running');
      // The row (and its status) is the guard's read, per request: never part of what is shared.
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'paused' });
      const later = await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(later.statusCode).toBe(200);
      expect(later.json()).toMatchObject({ status: 'paused', contacts_total: 1234 });
      expect(campaigns.stats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('still refuses, before anything shared is served, a caller who may not see the campaign', async () => {
    const app = await buildApp();
    try {
      // Warm the campaign's read as its owner.
      expect((await app.inject({ method: 'GET', url: URL, headers: OWNER })).statusCode).toBe(200);

      const otherTenant = await app.inject({ method: 'GET', url: URL, headers: { 'x-mgkvc-tenant': 't2', 'x-mgkvc-account': 'a1' } });
      expect(otherTenant.statusCode).toBe(404);
      expect(otherTenant.body).not.toContain('1234');

      const otherAccount = await app.inject({ method: 'GET', url: URL, headers: { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a2' } });
      expect(otherAccount.statusCode).toBe(404);
      expect(otherAccount.body).not.toContain('1234');

      flags.isEnabled.mockResolvedValue(false);
      const flagOff = await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(flagOff.statusCode).toBe(403);
      expect(flagOff.body).not.toContain('1234');

      expect(campaigns.stats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('reads again after campaign_changed for the campaign, and stops listening once the app closes', async () => {
    const before = bus.subscriberCount;
    const app = await buildApp();
    expect(bus.subscriberCount).toBe(before + 1);
    try {
      await app.inject({ method: 'GET', url: URL, headers: OWNER });
      await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(campaigns.stats).toHaveBeenCalledTimes(1);

      bus.publish({ type: 'campaign_changed', campaignId: CAMPAIGN_ID });
      await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(campaigns.stats).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
    expect(bus.subscriberCount).toBe(before);
  });

  it('does not share between two apps: each registration holds its own reads', async () => {
    const one = await buildApp();
    const two = await buildApp();
    try {
      await one.inject({ method: 'GET', url: URL, headers: OWNER });
      await two.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(campaigns.stats).toHaveBeenCalledTimes(2);
    } finally {
      await one.close();
      await two.close();
    }
  });

  it('says whether each answer was read for its request, and reads past the shared read for the fresh header only', async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(first.headers['x-mgkvc-stats-read']).toBe('scanned');
      const second = await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(second.headers['x-mgkvc-stats-read']).toBe('shared');
      expect(campaigns.stats).toHaveBeenCalledTimes(1);

      // Any other value is not a request for a read of one's own.
      const other = await app.inject({ method: 'GET', url: URL, headers: { ...OWNER, 'x-mgkvc-stats-fresh': 'yes' } });
      expect(other.headers['x-mgkvc-stats-read']).toBe('shared');
      expect(campaigns.stats).toHaveBeenCalledTimes(1);

      campaigns.stats.mockResolvedValue({ ...STATS, contacts_total: 1300 });
      const fresh = await app.inject({ method: 'GET', url: URL, headers: { ...OWNER, 'x-mgkvc-stats-fresh': '1' } });
      expect(fresh.statusCode).toBe(200);
      expect(fresh.headers['x-mgkvc-stats-read']).toBe('scanned');
      expect(fresh.json().contacts_total).toBe(1300);
      expect(campaigns.stats).toHaveBeenCalledTimes(2);

      // The shared read is still the one the others are served.
      const after = await app.inject({ method: 'GET', url: URL, headers: OWNER });
      expect(after.headers['x-mgkvc-stats-read']).toBe('shared');
      expect(after.json().contacts_total).toBe(1234);

      // A fresh read is still behind the guard.
      const otherTenant = await app.inject({ method: 'GET', url: URL, headers: { 'x-mgkvc-tenant': 't2', 'x-mgkvc-account': 'a1', 'x-mgkvc-stats-fresh': '1' } });
      expect(otherTenant.statusCode).toBe(404);
      expect(campaigns.stats).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
});
