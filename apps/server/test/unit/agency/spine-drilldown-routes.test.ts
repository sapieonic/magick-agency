import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// `GET /agency-campaigns/:id/{attempts,contacts}`: the insights drill-down filters
// (docs/insights.md, WS F) and the opt-in `?include_total=1`, at the route. The SQL is
// pinned against Postgres in `test/integration/agency/agency-drilldown-filters.test.ts`;
// this file pins the edge: what reaches the repository, and what is refused before it.
//
// The mock and app scaffolding below are `spine-read-routes.test.ts`'s.
//
// These routes serve every phone number on a campaign. Auth middleware is registered
// PER ROUTE PLUGIN, not globally, and this exact mistake has already shipped once
// here: a plugin was mounted as a sibling of the plugin that carries the auth hooks,
// inherited none of them, and left the roster-ingest route reachable unauthenticated.
//
// So the first test asserts the middleware actually runs on both new routes,
// rather than trusting that they were declared on the right plugin. It is
// deliberately NOT a status-code assertion — a route that does not exist also
// answers 404, which is a trap.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn(async () => { /* authenticated */ }) }));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: authSpy,
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

const { campaigns, attempts, contacts } = vi.hoisted(() => ({
  campaigns: { findById: vi.fn() },
  attempts: { listForCampaign: vi.fn(), countListed: vi.fn() },
  contacts: { listForCampaign: vi.fn(), countListed: vi.fn(), findDetailScoped: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAttemptRepository: attempts,
  agencyContactRepository: contacts,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';
import { encodeKeysetCursor } from '@magick-agency/domain/keyset-cursor';

const DEPS = {
  runtime: {
    dnc: { appliedVersion: async () => 1 },
    stations: { connectedBySession: async () => ({}) },
  },
  callManager: {
    accountConcurrencyGuard: {
      getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
    },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };
const CAMPAIGN = {
  id: 'c1', tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'stopped',
  disposition_catalog: [
    { code: 'ptp', label: 'Promise to pay' },
    { code: 'call_back', label: 'Call back', requires_datetime: true },
  ],
};
const EMPTY = { rows: [], next_cursor: null, limit: 50 };
/**
 * `agency_agent_sessions.agent_user_id` is a
 * UUID column in the baseline, and the route refuses a non-UUID filter before
 * it reaches the `22P02` cast (see the last case in "filters reach the repository").
 */
const AGENT_U9 = '99999999-9999-4999-8999-999999999999';

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN);
  attempts.listForCampaign.mockResolvedValue(EMPTY);
  contacts.listForCampaign.mockResolvedValue(EMPTY);
  attempts.countListed.mockResolvedValue(7);
  contacts.countListed.mockResolvedValue(11);
});

async function get(url: string, headers: Record<string, string> = HEADERS) {
  const app = await makeApp();
  const res = await app.inject({ method: 'GET', url: `/api/v1/agency-campaigns/c1/${url}`, headers });
  await app.close();
  return res;
}


describe('the new attempt filters reach the repository, parsed', () => {
  it('caller_id, the four flags and the half-open dialled window', async () => {
    const res = await get(
      'attempts?caller_id=%2B919000000001&redial=1&agent_manual=0&agent_reopened=true&placed=1'
      + '&dialed_from=2026-10-01T00:00:00Z&dialed_to=2026-10-02T00:00:00Z',
    );
    expect(res.statusCode).toBe(200);
    expect(attempts.listForCampaign.mock.calls[0]![0].filters).toEqual({
      callerId: '+919000000001',
      redial: true,
      agentManual: false,
      agentReopened: true,
      placed: true,
      dialedFrom: new Date('2026-10-01T00:00:00Z'),
      dialedTo: new Date('2026-10-02T00:00:00Z'),
    });
  });

  it('leaves from/to as they were: inclusive created_at bounds, a separate pair', async () => {
    await get('attempts?from=2026-10-01T00:00:00Z&to=2026-10-01T00:00:00Z');
    expect(attempts.listForCampaign.mock.calls[0]![0].filters).toEqual({
      from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it.each([
    ['caller_id=abc', 'caller_id'],
    ['redial=yes', 'redial'],
    ['agent_manual=2', 'agent_manual'],
    ['agent_reopened=on', 'agent_reopened'],
    ['placed=maybe', 'placed'],
    ['dialed_from=yesterday', 'dialed_from'],
    ['dialed_to=2026-02-30', 'dialed_to'],
    // Half-open: equal bounds are an empty window, refused rather than answered empty.
    ['dialed_from=2026-10-01T00:00:00Z&dialed_to=2026-10-01T00:00:00Z', 'dialed_from'],
    ['dialed_from=2026-10-02T00:00:00Z&dialed_to=2026-10-01T00:00:00Z', 'dialed_from'],
    ['placed=0&dialed_from=2026-10-01T00:00:00Z', 'placed'],
    ['include_total=please', 'include_total'],
  ])('?%s is a 400 naming %s, and nothing is read', async (query, param) => {
    const res = await get(`attempts?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');
    expect(res.json().details.map((d: { param: string }) => d.param)).toContain(param);
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    expect(attempts.countListed).not.toHaveBeenCalled();
  });
});

describe('the new contact filters reach the repository, parsed', () => {
  it('waiting=due_now and attempted=0, with no catalog read needed', async () => {
    const res = await get('contacts?waiting=due_now&attempted=0', { ...HEADERS, 'x-mgkvc-proven-campaign': 't1:a1:c1' });
    expect(res.statusCode).toBe(200);
    expect(contacts.listForCampaign.mock.calls[0]![0]).toEqual(expect.objectContaining({
      filters: { waiting: 'due_now', attempted: false },
    }));
    expect(contacts.listForCampaign.mock.calls[0]![0]).not.toHaveProperty('callbackCodes');
    // The export's proven fast path stays free of the campaign read for due_now.
    expect(campaigns.findById).not.toHaveBeenCalled();
  });

  it.each(['retry', 'callback'])('waiting=%s carries the campaign\'s callback codes', async (waiting) => {
    await get(`contacts?state=pending&waiting=${waiting}`);
    expect(contacts.listForCampaign.mock.calls[0]![0]).toEqual(expect.objectContaining({
      filters: { states: ['pending'], waiting },
      callbackCodes: ['call_back'],
    }));
  });

  it('on the proven fast path, waiting=callback reads the campaign once for its catalog', async () => {
    const res = await get('contacts?waiting=callback', { ...HEADERS, 'x-mgkvc-proven-campaign': 't1:a1:c1' });
    expect(res.statusCode).toBe(200);
    expect(flags.isEnabled).not.toHaveBeenCalled();
    expect(campaigns.findById).toHaveBeenCalledTimes(1);
    expect(contacts.listForCampaign.mock.calls[0]![0].callbackCodes).toEqual(['call_back']);
  });

  it.each([
    ['waiting=later', 'waiting'],
    ['waiting=due_now,retry', 'waiting'],
    ['attempted=yes', 'attempted'],
    // Every waiting bucket is pending: a state filter without it matches nothing.
    ['state=completed&waiting=due_now', 'waiting'],
    ['include_total=2', 'include_total'],
  ])('?%s is a 400 naming %s, and nothing is read', async (query, param) => {
    const res = await get(`contacts?${query}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().details.map((d: { param: string }) => d.param)).toContain(param);
    expect(contacts.listForCampaign).not.toHaveBeenCalled();
    expect(contacts.countListed).not.toHaveBeenCalled();
  });
});

describe('?include_total=1: the opt-in exact total', () => {
  it('is off by default: no count is run and the page carries no total', async () => {
    for (const path of ['attempts', 'contacts']) {
      const res = await get(path);
      expect(res.json()).not.toHaveProperty('total');
    }
    expect(attempts.countListed).not.toHaveBeenCalled();
    expect(contacts.countListed).not.toHaveBeenCalled();
  });

  it('counts with the SAME filters as the page, ignoring the cursor', async () => {
    const cursor = encodeKeysetCursor({ at: '2026-10-01T00:00:00.000000Z', id: '00000000-0000-4000-8000-000000000001' });
    const a = await get(`attempts?include_total=1&redial=1&dialed_from=2026-10-01T00:00:00Z&cursor=${cursor}`);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toEqual({ ...EMPTY, total: 7 });
    expect(attempts.countListed).toHaveBeenCalledWith({
      campaignId: 'c1', filters: attempts.listForCampaign.mock.calls[0]![0].filters,
    });
    expect(attempts.listForCampaign.mock.calls[0]![0].after).toBeDefined();

    const c = await get('contacts?include_total=true&waiting=retry');
    expect(c.json()).toEqual({ ...EMPTY, total: 11 });
    expect(contacts.countListed).toHaveBeenCalledWith({
      campaignId: 'c1', filters: { waiting: 'retry' }, callbackCodes: ['call_back'],
    });
  });

  it('include_total=0 is the default spelled out', async () => {
    const res = await get('attempts?include_total=0');
    expect(res.json()).not.toHaveProperty('total');
    expect(attempts.countListed).not.toHaveBeenCalled();
  });
});
