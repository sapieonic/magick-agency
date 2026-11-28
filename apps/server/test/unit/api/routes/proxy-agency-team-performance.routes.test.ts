import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Team performance's route with every dependency faked through `deps` (the SQL and the figures are
 * held on Postgres in `test/integration/api/team-performance.test.ts`): what the route itself
 * decides (docs/team-performance.md §4).
 *
 *  - The guards in Compare's order: RBAC (an agent, the RBAC 403), the flag (`403
 *    feature_disabled`, the dialer gate's body), the account scope, the query's shape (the generic
 *    agency 400, a malformed `campaign_id` too), the campaign, the zone, the window. Each refusal's
 *    body byte for byte, and nothing is read before the guard that refuses.
 *  - A zone is looked up in Postgres only once it passes the cheap rules (`isRequestZone`).
 *  - The read's refusals: `team_busy` with `Retry-After`; `team_timed_out` through the error
 *    mask's reviewed opt-out; never cached by a browser.
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import {
  TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS,
  type AgencyTeamPerformanceErrorResponse,
} from '@magick-agency/contracts/api/agency/team-performance';
import { proxyAgencyTeamPerformanceRoutes, type TeamPerformanceRouteDeps } from '../../../../src/api/routes/proxy-agency-team-performance.routes.js';
import { TeamRefusal } from '../../../../src/agency/team-performance/read.js';
import { TEAM_ERROR_MESSAGES } from '../../../../src/agency/team-performance/validate.js';

/** A refusal body as the contract declares it (`AgencyTeamPerformanceErrorResponse`), as the wire sends it. */
const refusal = (body: AgencyTeamPerformanceErrorResponse): string => JSON.stringify(body);

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const CAMPAIGN = '55555555-5555-4555-8555-555555555555';

let app: FastifyInstance;
let log: string[];
let role: string;
let accountId: string | null;
let enabled: boolean;
let readFails: Error | null;
let preserved: unknown;
let read: ReturnType<typeof vi.fn>;
let databaseZone: ReturnType<typeof vi.fn<(zone: string) => Promise<string | null>>>;

beforeEach(async () => {
  log = [];
  role = 'account_admin';
  accountId = ACCOUNT;
  enabled = true;
  readFails = null;
  preserved = undefined;
  databaseZone = vi.fn(async (zone: string) => { log.push('zone'); return zone; });
  read = vi.fn(async (q: Record<string, unknown>) => {
    log.push('read');
    if (readFails) throw readFails;
    return { echoed: q };
  });
  const deps: Partial<TeamPerformanceRouteDeps> = {
    reads: { read, clear: () => undefined } as never,
    enabled: async () => { log.push('flag'); return enabled; },
    campaignInAccount: async (_t, _a, id) => { log.push('campaign'); return id === CAMPAIGN; },
    databaseZone,
    today: () => '2026-11-20',
  };
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = accountId;
    r['user'] = { id: '99999999-9999-4999-8999-999999999999' };
    r['membership'] = { role, account_id: ACCOUNT, status: 'active' };
  });
  app.addHook('onSend', async (request) => { preserved = request.preserveReviewedUpstreamError; });
  await app.register(proxyAgencyTeamPerformanceRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const get = (query: Record<string, string>) => app.inject({ method: 'GET', url: `/proxy/agency/team-performance?${new URLSearchParams(query)}` });
const OK = { from: '2026-11-14', to: '2026-11-20', timezone: 'Asia/Kolkata' };

describe('the guards, in order', () => {
  it('an agent gets the RBAC 403 before the flag is asked', async () => {
    role = 'agent';
    const res = await get(OK);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden', message: 'Insufficient permissions. Required: agency.supervise' });
    expect(log).toEqual([]);
  });

  it('the flag off: 403 feature_disabled, the dialer gate\'s body, nothing read', async () => {
    enabled = false;
    const res = await get(OK);
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe(JSON.stringify({ error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Team performance is not enabled for this account.' }));
    expect(log).toEqual(['flag']);
  });

  it('no account context: 400 account_scope_required', async () => {
    accountId = null;
    const res = await get(OK);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'account_scope_required' });
    expect(log).toEqual(['flag']);
  });

  it('a query that fails its shape is the generic agency 400: a missing date, a malformed campaign_id', async () => {
    for (const q of [{ to: OK.to, timezone: OK.timezone }, { ...OK, campaign_id: 'not-a-uuid' }]) {
      const res = await get(q);
      expect(res.statusCode, JSON.stringify(q)).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
    }
    expect(log).toEqual(['flag', 'flag']);
  });

  it('another account\'s campaign: 404 team_campaign_not_found, byte for byte, before the zone', async () => {
    const res = await get({ ...OK, campaign_id: '66666666-6666-4666-8666-666666666666' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe(refusal({ error: 'Not Found', code: 'team_campaign_not_found', message: TEAM_ERROR_MESSAGES.team_campaign_not_found }));
    expect(log).toEqual(['flag', 'campaign']);
  });

  it('a zone that fails the cheap rules is refused without asking Postgres; one Postgres knows no name for, after', async () => {
    for (const zone of [null, '', 'IST', 'Mars/Olympus']) {
      const res = await get(zone === null ? { from: OK.from, to: OK.to } : { ...OK, timezone: zone });
      expect(res.statusCode, String(zone)).toBe(400);
      expect(res.body).toBe(refusal({ error: 'Bad Request', code: 'team_timezone_invalid', message: TEAM_ERROR_MESSAGES.team_timezone_invalid }));
    }
    expect(databaseZone).not.toHaveBeenCalled();
    databaseZone.mockResolvedValueOnce(null);
    expect((await get(OK)).json()).toMatchObject({ code: 'team_timezone_invalid' });
    expect(databaseZone).toHaveBeenCalledWith('Asia/Kolkata');
    expect(read).not.toHaveBeenCalled();
  });

  it('the window: past today, too long, backwards, malformed: 400 team_window_invalid after the zone', async () => {
    for (const w of [{ from: '2026-11-20', to: '2026-11-21' }, { from: '2026-10-01', to: '2026-11-20' }, { from: '2026-11-20', to: '2026-11-19' }, { from: '2026-11-x', to: '2026-11-20' }]) {
      const res = await get({ ...OK, ...w });
      expect(res.statusCode, JSON.stringify(w)).toBe(400);
      expect(res.body).toBe(refusal({ error: 'Bad Request', code: 'team_window_invalid', message: TEAM_ERROR_MESSAGES.team_window_invalid }));
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('passing every guard reads once with the resolved scope, never cached by a browser', async () => {
    const res = await get({ ...OK, campaign_id: CAMPAIGN.toUpperCase() });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(log).toEqual(['flag', 'campaign', 'zone', 'read']);
    expect(read).toHaveBeenCalledWith({
      tenantId: TENANT, accountId: ACCOUNT, campaignId: CAMPAIGN, from: OK.from, to: OK.to, timezone: 'Asia/Kolkata', databaseTimezone: 'Asia/Kolkata',
    }, expect.any(AbortSignal));
    // All campaigns: no campaign probe.
    log = [];
    await get(OK);
    expect(log).toEqual(['flag', 'zone', 'read']);
    expect(read.mock.calls[1]![0]).toMatchObject({ campaignId: null });
  });
});

describe('the read\'s refusals', () => {
  it('team_busy: 429, Retry-After, the body byte for byte', async () => {
    readFails = new TeamRefusal('team_busy');
    const res = await get(OK);
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe(String(TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS));
    expect(res.body).toBe(refusal({
      error: 'Too Many Requests', code: 'team_busy', message: TEAM_ERROR_MESSAGES.team_busy, retry_after_seconds: TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS,
    }));
    expect(preserved).toBeUndefined();
  });

  it('team_timed_out: 503 through the reviewed opt-out, the body byte for byte, no Retry-After', async () => {
    readFails = new TeamRefusal('team_timed_out');
    const res = await get(OK);
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body).toBe(refusal({ error: 'Service Unavailable', code: 'team_timed_out', message: 'Too much to read at once. Try a shorter period.' }));
    expect(preserved).toBe(true);
  });

  it('any other failure propagates (the error mask answers it)', async () => {
    readFails = new Error('boom');
    expect((await get(OK)).statusCode).toBe(500);
  });
});
