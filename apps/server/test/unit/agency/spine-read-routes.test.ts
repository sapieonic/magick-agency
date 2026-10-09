import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/spine-read-routes.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here. MODIFIED: the agent filter in "passes outcome, agent and date filters through" is a UUID
 * (`AGENT_U9`). NEW: "a non-UUID agent_user_id is a 400, not a 500 from Postgres 22P02".
 */

// ---------------------------------------------------------------------------
// MAG-159 — `GET /agency-campaigns/:id/{attempts,contacts}`.
//
// ── The assertion this file exists for ─────────────────────────────────────
//
// These routes serve every phone number on a campaign. Core registers auth
// middleware PER ROUTE PLUGIN, not globally (root CLAUDE.md), and this exact
// mistake has already shipped once here: `agencyInternalRoutes` was mounted as
// a sibling of `internalRoutes`, inherited none of its hooks, and left the
// roster-ingest route reachable unauthenticated.
//
// So the first test asserts the middleware actually runs on both new routes,
// rather than trusting that they were declared on the right plugin. It is
// deliberately NOT a status-code assertion — a route that does not exist also
// answers 404, which is the MAG-106 trap.
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
  attempts: { listForCampaign: vi.fn() },
  contacts: { listForCampaign: vi.fn(), findDetailScoped: vi.fn() },
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
const CAMPAIGN = { id: 'c1', tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'stopped' };
const EMPTY = { rows: [], next_cursor: null, limit: 50 };
/**
 * PORT NOTE (magick-agency): core's `'u9'`. `agency_agent_sessions.agent_user_id` is a
 * UUID column in agency's baseline, and the route now refuses a non-UUID filter before
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
});

describe('the routes are behind core auth', () => {
  it('runs authMiddleware on both list routes', async () => {
    const app = await makeApp();
    await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts', headers: HEADERS });
    expect(authSpy).toHaveBeenCalledTimes(1);
    await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/c1/contacts', headers: HEADERS });
    expect(authSpy).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it('a campaign in another tenant is 404, indistinguishable from one that does not exist', async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN, tenant_id: 'someone-else' });
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts', headers: HEADERS });
    expect(res.statusCode).toBe(404);
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('is behind the dialer feature flag', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const app = await makeApp();
    for (const path of ['attempts', 'contacts']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/agency-campaigns/c1/${path}`, headers: HEADERS });
      expect(res.statusCode).toBe(403);
    }
    await app.close();
  });
});

describe('a terminal campaign is the primary case', () => {
  it('serves both views on a stopped campaign — nothing is gated on it being live', async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN, status: 'stopped' });
    const app = await makeApp();
    const a = await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts', headers: HEADERS });
    const c = await app.inject({ method: 'GET', url: '/api/v1/agency-campaigns/c1/contacts', headers: HEADERS });
    expect(a.statusCode).toBe(200);
    expect(c.statusCode).toBe(200);
    await app.close();
  });
});

describe('filters reach the repository', () => {
  it('passes outcome, agent and date filters through', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/c1/attempts'
        + `?outcome=abandoned,no_answer&agent_user_id=${AGENT_U9}&from=2026-08-01T00:00:00Z&limit=10`,
      headers: HEADERS,
    });
    expect(attempts.listForCampaign).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: 'c1',
      limit: 10,
      filters: expect.objectContaining({
        outcomes: ['abandoned', 'no_answer'],
        agentUserId: AGENT_U9,
      }),
    }));
    await app.close();
  });

  it('passes suppressed_reason through on contacts — the rows a compliance question is about', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/c1/contacts?state=suppressed&suppressed_reason=dnc',
      headers: HEADERS,
    });
    expect(contacts.listForCampaign).toHaveBeenCalledWith(expect.objectContaining({
      filters: { states: ['suppressed'], suppressedReasons: ['dnc'] },
    }));
    await app.close();
  });

  it('a non-UUID contact_id is a 400, not a 500 from Postgres 22P02', async () => {
    // The console builds this URL itself, so a stale or hand-edited one is an
    // ordinary request. Unvalidated it reaches `$n::uuid` and the database
    // error text is echoed to the caller under a 500 — a bad request that
    // reads as a broken service. The PATH param was guarded from the start;
    // this is the query filter, which is the entry point the drill-down uses.
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/c1/attempts?contact_id=not-a-uuid',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details[0].param).toBe('contact_id');
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  // PORT NOTE (magick-agency): NEW, no source twin. Core's column was VARCHAR, so a
  // non-UUID agent filter matched nothing (an empty page); agency's is UUID, so the same
  // value is a `22P02` and a 500. Refused like the contact_id filter above.
  it('a non-UUID agent_user_id is a 400, not a 500 from Postgres 22P02', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/c1/attempts?agent_user_id=u9',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation failed',
      details: [{ param: 'agent_user_id', message: 'must be an agent id' }],
    });
    expect(attempts.listForCampaign).not.toHaveBeenCalled();

    // A cleared field (`?agent_user_id=`) still means "no filter", as `singleParam` says.
    const cleared = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts?agent_user_id=', headers: HEADERS,
    });
    expect(cleared.statusCode).toBe(200);
    expect(attempts.listForCampaign.mock.calls[0]![0].filters).not.toHaveProperty('agentUserId');
    await app.close();
  });

  it('a phone filter with no digits is a 400 — NOT the whole campaign', async () => {
    // The defect this replaces: `parsePhoneFilter` returned `undefined` for a
    // digit-less term, the route omitted the filter entirely, and the caller
    // was handed every row on the campaign while the console still displayed
    // the chip. Assert the refusal AND that no query was issued, because a
    // query issued without the predicate is exactly the wrong answer.
    const app = await makeApp();
    for (const phone of ['Priya', '%', '()-']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/agency-campaigns/c1/attempts?phone=${encodeURIComponent(phone)}`,
        headers: HEADERS,
      });
      expect(res.statusCode, `phone=${phone}`).toBe(400);
      expect(res.json().details[0].param).toBe('phone');
    }
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('the same refusal on the roster', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/contacts?phone=abc', headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(contacts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it('an empty phone box is still no filter, not a refusal', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/contacts?phone=', headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.listForCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ filters: {} }),
    );
    await app.close();
  });

  it('a bad filter is a 400 naming it, never an empty 200', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/c1/attempts?outcome=nope',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details[0].param).toBe('outcome');
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('cursor handling', () => {
  it('decodes a cursor into the keyset position', async () => {
    const cursor = encodeKeysetCursor({
      at: '2026-08-17T14:03:11.123456Z', id: '3f2a1b0c-1111-4222-8333-444455556666',
    });
    const app = await makeApp();
    await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/c1/attempts?cursor=${cursor}`,
      headers: HEADERS,
    });
    expect(attempts.listForCampaign).toHaveBeenCalledWith(expect.objectContaining({
      after: { at: '2026-08-17T14:03:11.123456Z', id: '3f2a1b0c-1111-4222-8333-444455556666' },
    }));
    await app.close();
  });

  it('a malformed cursor is 400 — NOT a silent reset to page one', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/attempts?cursor=garbage', headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('malformed_cursor');
    // The silent-reset failure would look like duplicate rows to a supervisor.
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * Well-SHAPED but not a real instant. Each of these matches the cursor's
   * timestamp pattern and survives `new Date` (which rolls an overflowing day
   * forward rather than refusing it), so each used to reach the repository and
   * die inside the `::timestamptz` cast — `22008 date/time field value out of
   * range`, which nothing maps to a status. A bad request that reads as a
   * broken service, on a route reached from a link. Verified against Postgres
   * 16 before it was fixed here.
   */
  it.each([
    ['2026-02-30T00:00:00.000000Z', 'February 30th'],
    ['2026-04-31T00:00:00.000000Z', 'April 31st'],
    ['0000-08-17T14:03:11.123456Z', 'year zero'],
  ])('a cursor naming %s (%s) is 400, not a 500 from the database', async (at) => {
    const forged = Buffer.from(
      JSON.stringify({ at, id: '3f2a1b0c-1111-4222-8333-444455556666' }),
      'utf8',
    ).toString('base64url');

    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/c1/attempts?cursor=${forged}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('malformed_cursor');
    expect(attempts.listForCampaign).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the contact drill-down', () => {
  const CONTACT_ID = '11111111-2222-4333-8444-555566667777';

  it('scopes the lookup by BOTH campaign and contact', async () => {
    contacts.findDetailScoped.mockResolvedValue({ id: CONTACT_ID, context: { name: 'A' } });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/c1/contacts/${CONTACT_ID}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(contacts.findDetailScoped).toHaveBeenCalledWith('c1', CONTACT_ID);
    await app.close();
  });

  it('a contact from another campaign is 404, not a cross-campaign read', async () => {
    contacts.findDetailScoped.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/c1/contacts/${CONTACT_ID}`, headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('a non-UUID contact id is 404, not a 500 from Postgres 22P02', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/c1/contacts/not-a-uuid', headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(contacts.findDetailScoped).not.toHaveBeenCalled();
    await app.close();
  });
});
