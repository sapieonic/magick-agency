import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * ─── THE CAMPAIGN CALL LOG'S PUBLIC JSON ROUTE (CL11, docs/call-log.md) ──────
 *
 * `GET /proxy/agency/campaigns/:id/call-log` over the internal read the export drains. What
 * this layer owns, asserted here with the internal handler mocked:
 *
 *  * `type` is the public word for the internal `source`, validated before the handler is
 *    called; `all` (and absent) forwards no source;
 *  * rows leave as the contract's union on `type`: a dialler row is the attempt row, a
 *    soft-phone row has only the soft phone's fields, and both carry `agent_name`;
 *  * `counts` passes through when asked for and is absent otherwise;
 *  * an unknown query key is a 400, never a silently unfiltered list.
 *
 * The SQL, the keyset across both types and the counts' arithmetic are proved on real
 * Postgres in `test/integration/api/agency-softphone-campaign-results.test.ts`.
 */

const TENANT = 'tenant-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  findDisplayNames: vi.fn(),
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFileBuffer: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.findDisplayNames },
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import {
  callLogSourceForType,
  isCallLogStatus,
  isCallLogTypeFilter,
  inboundJourney,
  splitCallLogOutcomes,
  toCallLogWireRow,
  type CampaignDiallerLogRow,
  type CampaignInboundLogRow,
  type CampaignSoftphoneLogRow,
} from '../../../src/agency/campaign-call-log.js';
import { ATTEMPT_QUERY_PARAMS } from '../../../src/agency/agency-spine.js';

const PREFIX = '/proxy/agency';
const CAMPAIGN = 'campaign-1';
const URL = `${PREFIX}/campaigns/${CAMPAIGN}/call-log`;
const RAVI = 'ac1f9d2e-1111-4222-8333-444455556666';
const PRIYA = 'bd2f9d2e-1111-4222-8333-444455556666';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    (request as { tenantId?: string }).tenantId = TENANT;
    (request as { accountId?: string }).accountId = 'account-1';
    (request as { user?: { id: string } }).user = { id: 'user-1' };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

const DIALLER: CampaignDiallerLogRow = {
  source: 'dialler',
  id: 'attempt-1', campaign_id: CAMPAIGN, contact_id: 'contact-1', attempt_number: 2,
  phone_e164: '+919876500001', caller_id: '+919000000001', agent_user_id: RAVI,
  reserved_agent_id: 'session-1', state: 'ended', outcome: 'connected',
  disposition_code: 'not_interested', auto_disposition_code: null, notes: 'call back after 6pm',
  callback_at: null, promise_date: null, promise_amount: null,
  dispositioned_by_user_id: RAVI, dispositioned_at: '2026-11-22T10:00:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'call-9', dialed_at: '2026-11-22T09:59:00.000Z', answered_at: '2026-11-22T09:59:10.000Z',
  bridged_at: '2026-11-22T09:59:12.000Z', ended_at: '2026-11-22T09:59:59.000Z',
  talk_seconds: 47, wrapup_seconds: 20, redial_of_attempt_id: null, redial_number: 0,
  created_at: '2026-11-22T09:58:00.000Z',
};

const SOFT: CampaignSoftphoneLogRow = {
  source: 'soft_phone',
  id: 'manual-1', campaign_id: CAMPAIGN, contact_id: null, attempt_number: null,
  phone_e164: '+919876500009', caller_id: '+919000000002', agent_user_id: PRIYA,
  reserved_agent_id: null, state: 'ended', outcome: 'connected',
  disposition_code: 'wrong_number', auto_disposition_code: null, notes: null, callback_at: null,
  promise_date: null, promise_amount: null,
  dispositioned_by_user_id: PRIYA, dispositioned_at: '2026-11-22T09:41:00.000Z', dispositioned_on_behalf: false,
  webrtc_call_id: 'call-10', dialed_at: '2026-11-22T09:40:01.000Z', answered_at: '2026-11-22T09:40:08.000Z',
  bridged_at: '2026-11-22T09:40:08.000Z', ended_at: '2026-11-22T09:40:29.000Z',
  talk_seconds: 21, wrapup_seconds: null, redial_of_attempt_id: null, redial_number: null,
  dnc_overridden: false, hours_overridden: true, requires_disposition: false,
  settled_at: '2026-11-22T09:41:00.000Z', callback_of: null, created_at: '2026-11-22T09:40:00.000Z',
};

/** A missed inbound call (nobody free, then a voicemail), assigned to Priya and rung back by `manual-1`. */
const MISSED: CampaignInboundLogRow = {
  source: 'inbound',
  id: 'inbound-1', campaign_id: CAMPAIGN, contact_id: null, attempt_number: null,
  phone_e164: '+919876507730', caller_id: '+919000000001', agent_user_id: null,
  reserved_agent_id: null, state: 'ended', outcome: 'voicemail',
  disposition_code: null, auto_disposition_code: null, notes: null, callback_at: null,
  promise_date: null, promise_amount: null,
  dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
  webrtc_call_id: 'call-11', dialed_at: null, answered_at: '2026-11-22T09:12:01.000Z',
  bridged_at: null, ended_at: '2026-11-22T09:13:40.000Z',
  talk_seconds: null, wrapup_seconds: null, redial_of_attempt_id: null, redial_number: null,
  dnc_overridden: false, hours_overridden: false, requires_disposition: false,
  settled_at: '2026-11-22T09:13:40.000Z',
  inbound: {
    campaign_source: 'contact', route_name: 'Sales line', wait_seconds: 100, queued: true, via_sticky_agent: false,
    voicemail_seconds: 22,
    follow_up: { status: 'open', reason: 'overflow', closed_cause: null, assignee_user_id: PRIYA, handled_reason: null, handled_at: null },
    called_back: { call_id: 'manual-1', at: '2026-11-22T09:40:00.000Z' },
  },
  created_at: '2026-11-22T09:12:00.000Z',
};

/** An inbound call Ravi, the caller's own agent, answered after 18 seconds. */
const ANSWERED: CampaignInboundLogRow = {
  ...MISSED,
  id: 'inbound-2', contact_id: 'contact-7', agent_user_id: RAVI, outcome: 'answered',
  disposition_code: 'will_pay', bridged_at: '2026-11-22T09:42:19.000Z', answered_at: '2026-11-22T09:42:01.000Z',
  ended_at: '2026-11-22T09:46:31.000Z', talk_seconds: 252,
  inbound: {
    campaign_source: 'contact', route_name: 'Sales line', wait_seconds: 18, queued: true, via_sticky_agent: true,
    voicemail_seconds: null, follow_up: null, called_back: null,
  },
  created_at: '2026-11-22T09:42:01.000Z',
};

function core(body: Record<string, unknown>, status = 200) {
  return { status, body, headers: new Headers() };
}
const page = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  core({ rows, next_cursor: null, limit: 50, ...extra });

/** The query the internal handler was called with. */
const coreQuery = () => (mocks.proxyToCore.mock.calls.at(-1)![0] as { path: string; query?: Record<string, string> });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findDisplayNames.mockResolvedValue(new Map([[RAVI, 'Ravi Menon'], [PRIYA, 'Priya Nair']]));
});

describe('GET /campaigns/:id/call-log', () => {
  it('serves both types as the contract\'s rows, each named for its type and its agent', async () => {
    mocks.proxyToCore.mockResolvedValue(page([DIALLER, SOFT], { next_cursor: 'c2' }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next_cursor).toBe('c2');
    expect(body.limit).toBe(50);
    expect(body).not.toHaveProperty('counts');

    const [dialler, soft] = body.rows;
    // A dialler row is the attempt row, marked: nothing dropped, `source` gone.
    const { source: _d, ...attempt } = DIALLER;
    expect(dialler).toEqual({ type: 'dialler', ...attempt, agent_name: 'Ravi Menon' });
    // A soft-phone row carries the soft phone's fields and none of the attempt-only NULLs.
    expect(soft).toMatchObject({
      type: 'soft_phone', id: 'manual-1', contact_id: null, phone_e164: '+919876500009',
      agent_user_id: PRIYA, agent_name: 'Priya Nair', disposition_code: 'wrong_number',
      hours_overridden: true, dnc_overridden: false, requires_disposition: false, talk_seconds: 21,
    });
    for (const key of ['source', 'attempt_number', 'reserved_agent_id', 'auto_disposition_code', 'wrapup_seconds', 'redial_of_attempt_id', 'redial_number']) {
      expect(soft, key).not.toHaveProperty(key);
    }
    // One lookup for the page.
    expect(mocks.findDisplayNames).toHaveBeenCalledTimes(1);
    expect(coreQuery().path).toBe(`/agency-campaigns/${CAMPAIGN}/call-log`);
    await app.close();
  });

  it('serves an inbound row with its own facts on the row, and names who a missed call is assigned to', async () => {
    mocks.proxyToCore.mockResolvedValue(page([ANSWERED, MISSED]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const [answered, missed] = res.json().rows;
    expect(answered).toMatchObject({
      type: 'inbound', id: 'inbound-2', campaign_source: 'contact', contact_id: 'contact-7',
      phone_e164: '+919876507730', caller_id: '+919000000001', route_name: 'Sales line',
      agent_user_id: RAVI, agent_name: 'Ravi Menon', outcome: 'answered', disposition_code: 'will_pay',
      wait_seconds: 18, queued: true, via_sticky_agent: true, talk_seconds: 252,
      voicemail_seconds: null, follow_up: null, called_back: null,
    });
    expect(missed).toMatchObject({
      type: 'inbound', id: 'inbound-1', agent_user_id: null, agent_name: null, outcome: 'voicemail',
      wait_seconds: 100, voicemail_seconds: 22,
      follow_up: { status: 'open', reason: 'overflow', assignee_user_id: PRIYA, assignee_name: 'Priya Nair' },
      called_back: { call_id: 'manual-1', at: '2026-11-22T09:40:00.000Z' },
    });
    // The attempt-only NULLs and the internal `inbound` envelope are not on the wire.
    for (const key of ['source', 'inbound', 'attempt_number', 'reserved_agent_id', 'auto_disposition_code', 'wrapup_seconds', 'dialed_at', 'redial_number', 'dnc_overridden']) {
      expect(missed, key).not.toHaveProperty(key);
    }
    await app.close();
  });

  it('carries a call back\'s link to the missed call on the soft-phone row', async () => {
    const callbackOf = { inbound_call_id: 'inbound-1', arrived_at: '2026-11-22T09:12:00.000Z' };
    mocks.proxyToCore.mockResolvedValue(page([{ ...SOFT, callback_of: callbackOf }, SOFT]));
    const app = await buildApp();
    const rows = (await app.inject({ method: 'GET', url: URL })).json().rows;
    expect(rows[0].callback_of).toEqual(callbackOf);
    expect(rows[1].callback_of).toBeNull();
    await app.close();
  });

  it('turns type into the internal source, and all into none', async () => {
    mocks.proxyToCore.mockResolvedValue(page([]));
    const app = await buildApp();
    for (const [type, source] of [
      ['dialler', 'dialler'], ['soft_phone', 'soft_phone'], ['inbound', 'inbound'], ['to_follow_up', 'to_follow_up'], ['all', undefined],
    ] as const) {
      await app.inject({ method: 'GET', url: `${URL}?type=${type}` });
      expect(coreQuery().query?.['source'], type).toBe(source);
      expect(coreQuery().query, type).not.toHaveProperty('type');
    }
    await app.inject({ method: 'GET', url: URL });
    expect(coreQuery().query).not.toHaveProperty('source');
    await app.close();
  });

  it('refuses a type it does not know before reading anything', async () => {
    const app = await buildApp();
    for (const type of ['softphone', 'missed', 'ALL']) {
      const res = await app.inject({ method: 'GET', url: `${URL}?type=${type}` });
      expect(res.statusCode, type).toBe(400);
      expect(res.json()).toEqual({
        error: 'Validation failed',
        details: [{ param: 'type', message: 'must be one of: all, dialler, soft_phone, inbound, to_follow_up' }],
      });
    }
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards every attempt filter, the paging, include_counts and status by name', async () => {
    mocks.proxyToCore.mockResolvedValue(page([]));
    const app = await buildApp();
    const filters = Object.fromEntries(ATTEMPT_QUERY_PARAMS.map((key) => [key, `v-${key}`]));
    const qs = new URLSearchParams({ ...filters, cursor: 'c1', limit: '25', include_counts: '1', type: 'soft_phone', status: 'awaiting_outcome' });
    await app.inject({ method: 'GET', url: `${URL}?${qs.toString()}` });
    // `status` (the soft-phone status filter) goes by name: the handler validates and applies it.
    expect(coreQuery().query).toEqual({ ...filters, cursor: 'c1', limit: '25', include_counts: '1', source: 'soft_phone', status: 'awaiting_outcome' });
    await app.close();
  });

  it('refuses an unknown key rather than serving an unfiltered list, the export\'s own included', async () => {
    const app = await buildApp();
    for (const key of ['source', 'include_total', 'preamble', 'campaign_id']) {
      const res = await app.inject({ method: 'GET', url: `${URL}?${key}=x` });
      expect(res.statusCode, key).toBe(400);
      expect(res.json().code, key).toBe('unknown_query_params');
    }
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('passes the counts through when the handler sends them', async () => {
    const counts = { all: 1383, dialler: 1240, soft_phone: 86, inbound: 57, to_follow_up: 6 };
    mocks.proxyToCore.mockResolvedValue(page([DIALLER], { counts }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: `${URL}?include_counts=1&type=dialler` });
    expect(res.json().counts).toEqual(counts);
    await app.close();
  });

  it('leaves the handler\'s refusal untouched: a campaign that is not the caller\'s, a filter it rejects', async () => {
    const app = await buildApp();
    for (const refusal of [core({ error: 'Not Found' }, 404), core({ error: 'Validation failed', details: [{ param: 'from' }] }, 400)]) {
      mocks.proxyToCore.mockResolvedValue(refusal);
      const res = await app.inject({ method: 'GET', url: URL });
      expect(res.statusCode).toBe(refusal.status);
      expect(res.json()).toEqual(refusal.body);
    }
    expect(mocks.findDisplayNames).not.toHaveBeenCalled();
    await app.close();
  });

  it('keeps the rows when the names cannot be read', async () => {
    mocks.findDisplayNames.mockRejectedValue(new Error('users db down'));
    mocks.proxyToCore.mockResolvedValue(page([DIALLER, SOFT]));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows.map((r: { agent_name: unknown }) => r.agent_name)).toEqual([null, null]);
    await app.close();
  });

  it('answers 502 for a body that is not a page, never an empty list', async () => {
    mocks.proxyToCore.mockResolvedValue(core({ rows: [], next_cursor: 42 }));
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('call_log_unreadable');
    await app.close();
  });
});

describe('the call log\'s vocabulary', () => {
  it('knows its types and nothing else', () => {
    for (const ok of ['all', 'dialler', 'soft_phone', 'inbound', 'to_follow_up']) expect(isCallLogTypeFilter(ok), ok).toBe(true);
    for (const bad of ['missed', 'softphone', '', undefined, null, 1, ['dialler']]) expect(isCallLogTypeFilter(bad), String(bad)).toBe(false);
    expect(callLogSourceForType(undefined)).toBeNull();
    expect(callLogSourceForType('all')).toBeNull();
    expect(callLogSourceForType('dialler')).toBe('dialler');
    expect(callLogSourceForType('soft_phone')).toBe('soft_phone');
    expect(callLogSourceForType('inbound')).toBe('inbound');
    expect(callLogSourceForType('to_follow_up')).toBe('to_follow_up');
    for (const ok of ['live', 'awaiting_outcome', 'settled']) expect(isCallLogStatus(ok), ok).toBe(true);
    for (const bad of ['done', 'ended', '', undefined, ['live']]) expect(isCallLogStatus(bad), String(bad)).toBe(false);
  });

  it('projects a soft-phone row with no name to agent_name: null, never an absent key', () => {
    expect(toCallLogWireRow(SOFT)).toHaveProperty('agent_name', null);
    expect(toCallLogWireRow({ ...SOFT, agent_name: 'Priya Nair' })).toMatchObject({ type: 'soft_phone', agent_name: 'Priya Nair' });
  });

  it('splits What happened into the attempt list\'s outcomes and the ones only an inbound call has', () => {
    expect(splitCallLogOutcomes(undefined)).toEqual({ attempt: undefined, inbound: [] });
    expect(splitCallLogOutcomes('connected,no_answer')).toEqual({ attempt: 'connected,no_answer', inbound: [] });
    expect(splitCallLogOutcomes('missed,connected, voicemail')).toEqual({ attempt: 'connected', inbound: ['missed', 'voicemail'] });
    expect(splitCallLogOutcomes(['abandoned_in_queue', 'missed,missed'])).toEqual({ attempt: undefined, inbound: ['abandoned_in_queue', 'missed'] });
    // A word neither vocabulary knows stays with the attempt parser, whose 400 names it.
    expect(splitCallLogOutcomes('missed,nonsense')).toEqual({ attempt: 'nonsense', inbound: ['missed'] });
  });

  it('tells an inbound call\'s path in order: answered, and missed with a voicemail', () => {
    expect(inboundJourney(ANSWERED)).toEqual([
      { kind: 'rang', at: '2026-11-22T09:42:01.000Z', seconds: null },
      { kind: 'greeting', at: '2026-11-22T09:42:01.000Z', seconds: null },
      { kind: 'waited', at: null, seconds: 18 },
      { kind: 'answered', at: '2026-11-22T09:42:19.000Z', seconds: null },
      { kind: 'ended', at: '2026-11-22T09:46:31.000Z', seconds: 252 },
    ]);
    expect(inboundJourney(MISSED).map((step) => step.kind)).toEqual(['rang', 'greeting', 'waited', 'missed', 'voicemail', 'ended']);
    // Out of hours: answered with a message, never queued, so no wait is claimed.
    const closed: CampaignInboundLogRow = { ...MISSED, inbound: { ...MISSED.inbound, queued: false, voicemail_seconds: null } };
    expect(inboundJourney(closed).map((step) => step.kind)).toEqual(['rang', 'greeting', 'missed', 'ended']);
  });
});
