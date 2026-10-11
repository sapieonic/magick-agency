import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// `GET /api/v1/agency-campaigns`: the list, and its `status` filter.
//
// The console's campaigns home reads every started-and-not-finished campaign
// with `?status=running,stopping,paused`, however old, while the rest of the
// history stays a page at a time. Pinned here: the filter reaches the
// repository, an absent or blank one is "every status", and an unknown value is
// a 400 rather than an empty list that would read as "nothing is running".
// The SQL itself is covered against real Postgres in
// `test/integration/agency/repository-sql-coverage.test.ts`.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
  },
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

const { campaigns } = vi.hoisted(() => ({ campaigns: { list: vi.fn() } }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));

import { agencyCampaignRoutes, parseStatusFilter } from '../../../src/api/routes/agency-campaigns.routes.js';

/** The plugin's dependencies serve the stats route only; the list never touches them. */
const DEPS = {} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.list.mockResolvedValue({ rows: [], total: 0 });
});

describe('GET /api/v1/agency-campaigns — status filter', () => {
  it('passes the statuses to the repository, with the page bounds', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns?status=running,stopping,paused&limit=100&offset=0',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(campaigns.list).toHaveBeenCalledWith('t1', 'a1', 100, 0, ['running', 'stopping', 'paused']);
    expect(res.json()).toEqual({ campaigns: [], total: 0, limit: 100, offset: 0 });
  });

  it('reads every status when the filter is absent', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns', headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(campaigns.list).toHaveBeenCalledWith('t1', 'a1', 50, 0, undefined);
  });

  it('answers 400 for an unknown status, and never reads the list', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns?status=running,runing',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.status).toMatch(/draft, running, paused, stopping, completed, stopped/);
    expect(campaigns.list).not.toHaveBeenCalled();
  });
});

describe('parseStatusFilter', () => {
  it('trims, drops empty parts and repeats', () => {
    expect(parseStatusFilter(' paused , ,paused,running')).toEqual(['paused', 'running']);
  });

  it('treats absent, blank and comma-only as no filter', () => {
    expect(parseStatusFilter(undefined)).toBeUndefined();
    expect(parseStatusFilter('')).toBeUndefined();
    expect(parseStatusFilter(',')).toBeUndefined();
  });

  it('refuses a repeated query key and an inherited property name', () => {
    expect(parseStatusFilter(['running', 'paused'])).toBe('invalid');
    expect(parseStatusFilter('toString')).toBe('invalid');
  });
});
