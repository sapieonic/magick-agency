import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * The soft phone's public routes (`proxy-agency-softphone.routes.ts`, docs/softphone.md §6)
 * over a `callCore` double, with REAL RBAC (`requirePermission` against the role on the
 * request) and the real error mask, so each case below is a statement about what reaches
 * the internal handler and what the browser gets back:
 *
 *  - the floors per role (agent / viewer / account_admin) and the flag (`softphone_disabled`);
 *  - the actor the internal handler receives: the authenticated user, `on_behalf` (and the
 *    GET's `supervise`) set from the ROLE only — a client's copy is stripped;
 *  - body / query validation at the edge (uuid ids before any `::uuid` cast);
 *  - refusals passed through with their status, the reviewed `503 dnc_unavailable` / `dial_failed` past
 *    the mask, and a success that is not the internal envelope refused (502);
 *  - enrichment (`agent_name`, `dispositioned_by_name`; a failed name read degrades);
 *  - every `platform_audit_log` row: action, actor, on-behalf, campaign, the override notes.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const SUPERVISOR = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';
const CALL = '77777777-7777-4777-8777-777777777777';
const CAMPAIGN = '88888888-8888-4888-8888-888888888888';
const ENTRY = '99999999-9999-4999-8999-999999999999';

const mocks = vi.hoisted(() => ({
  callCore: vi.fn(),
  auditLog: vi.fn(),
  flagEnabled: vi.fn(),
  names: vi.fn(),
  accountSettings: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.callCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: mocks.flagEnabled }),
  FLAGS: { agency_softphone_enabled: { key: 'agency_softphone_enabled' } },
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: mocks.names },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.accountSettings },
}));

import { proxyAgencySoftphoneRoutes } from '../../../src/api/routes/proxy-agency-softphone.routes.js';
import { errorMaskHook } from '../../../src/api/middleware/error-mask.middleware.js';

const P = '/proxy/agency';

async function appAs(role: MembershipRole, userId = role === 'account_admin' ? SUPERVISOR : AGENT): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: userId };
    r['membership'] = { role };
  });
  app.addHook('onSend', errorMaskHook);
  await app.register(proxyAgencySoftphoneRoutes, { prefix: P });
  await app.ready();
  return app;
}

function wireCall(overrides: Record<string, unknown> = {}) {
  return {
    id: CALL, session_id: SESSION, agent_user_id: AGENT, agent_name: null, destination_e164: '+919811100001',
    caller_id: '+919000000001', tag: { campaign_id: CAMPAIGN, campaign_name: 'Renewals' }, contact: null,
    state: 'ended', outcome: 'connected', end_reason: 'agent_hangup', recording_requested: true,
    dnc_overridden: false, hours_overridden: false, requires_disposition: false, outcome_due_at: null,
    disposition_code: 'interested', disposition_source: 'campaign', notes: null, callback_at: null, fields: {},
    dispositioned_by_user_id: SUPERVISOR, dispositioned_at: '2026-10-30T10:00:00.000Z', dispositioned_on_behalf: true,
    webrtc_call_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', dialed_at: null, answered_at: null, bridged_at: null,
    ended_at: null, talk_seconds: 10, settled_at: null, created_at: '2026-10-30T09:59:00.000Z', updated_at: '2026-10-30T10:00:00.000Z',
    ...overrides,
  };
}

const envelope = (answer: unknown, audit: Record<string, unknown>, status = 200) =>
  ({ status, body: { answer, audit }, headers: new Headers({ 'content-type': 'application/json' }) });
const plain = (body: unknown, status = 200, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  ({ status, body, headers: new Headers(headers) });

const lastCore = () => mocks.callCore.mock.calls.at(-1)![0] as {
  method: string; path: string; body?: Record<string, unknown>; query?: Record<string, string>;
  tenantId: string; accountId?: string; headers?: Record<string, string>; rawResponse?: boolean;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flagEnabled.mockResolvedValue(true);
  mocks.names.mockResolvedValue(new Map([[AGENT, 'Asha Agent'], [SUPERVISOR, 'Sam Supervisor']]));
  mocks.accountSettings.mockResolvedValue({ allow_recording: true, analyze_calls: true });
  mocks.callCore.mockResolvedValue(envelope(wireCall(), { on_behalf: false, campaign_id: CAMPAIGN }));
});

/** Every soft-phone route, with a body that passes its schema. */
const ROUTES: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'PUT'; url: string; body?: unknown; floor: 'dial' | 'manage' }> = [
  { method: 'GET', url: `${P}/softphone/bootstrap`, floor: 'dial' },
  { method: 'POST', url: `${P}/softphone/sessions`, body: {}, floor: 'dial' },
  { method: 'POST', url: `${P}/softphone/calls`, body: { session_id: SESSION, to: '9811100001' }, floor: 'dial' },
  { method: 'GET', url: `${P}/softphone/calls`, floor: 'dial' },
  { method: 'GET', url: `${P}/softphone/calls/${CALL}`, floor: 'dial' },
  { method: 'GET', url: `${P}/softphone/calls/${CALL}/recording`, floor: 'dial' },
  { method: 'PATCH', url: `${P}/softphone/calls/${CALL}`, body: { notes: 'x' }, floor: 'dial' },
  { method: 'POST', url: `${P}/softphone/calls/${CALL}/hangup`, body: {}, floor: 'dial' },
  { method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`, body: { code: 'interested' }, floor: 'dial' },
  { method: 'POST', url: `${P}/softphone/calls/${CALL}/dnc`, body: {}, floor: 'dial' },
  { method: 'GET', url: `${P}/softphone/settings`, floor: 'dial' },
  { method: 'PUT', url: `${P}/softphone/settings`, body: {}, floor: 'manage' },
  { method: 'POST', url: `${P}/sessions/${SESSION}/softphone`, body: {}, floor: 'dial' },
  { method: 'POST', url: `${P}/sessions/${SESSION}/softphone/return`, body: {}, floor: 'dial' },
];

function call(app: FastifyInstance, r: (typeof ROUTES)[number]) {
  return app.inject({ method: r.method, url: r.url, ...(r.body !== undefined ? { payload: r.body as object } : {}) });
}

const rbac403 = (res: { statusCode: number; body: string }) =>
  res.statusCode === 403 && /Insufficient permissions/.test(res.body);

describe('floors and the flag', () => {
  it('an agent and a viewer reach every route but PUT /settings; an account admin reaches all', async () => {
    const agent = await appAs('agent');
    const viewer = await appAs('viewer');
    const admin = await appAs('account_admin');
    for (const r of ROUTES) {
      expect(rbac403(await call(agent, r)), `agent ${r.method} ${r.url}`).toBe(r.floor === 'manage');
      // `viewer` sits above `agent` in the hierarchy, so it holds the agent floor too.
      expect(rbac403(await call(viewer, r)), `viewer ${r.method} ${r.url}`).toBe(r.floor === 'manage');
      expect(rbac403(await call(admin, r)), `admin ${r.method} ${r.url}`).toBe(false);
    }
  });

  it('every route answers 403 softphone_disabled when the flag is off, without reaching the internal handler', async () => {
    mocks.flagEnabled.mockResolvedValue(false);
    const admin = await appAs('account_admin');
    for (const r of ROUTES) {
      const res = await call(admin, r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
      expect(res.json(), `${r.method} ${r.url}`).toMatchObject({ error: 'Forbidden', code: 'softphone_disabled', message: expect.any(String) });
    }
    expect(mocks.callCore).not.toHaveBeenCalled();
    expect(mocks.flagEnabled).toHaveBeenCalledWith({ key: 'agency_softphone_enabled' }, { tenantId: TENANT, accountId: ACCOUNT });
  });

  it('the RBAC refusal comes before the flag read (an agent on PUT /settings is told about the permission)', async () => {
    mocks.flagEnabled.mockResolvedValue(false);
    const agent = await appAs('agent');
    const res = await agent.inject({ method: 'PUT', url: `${P}/softphone/settings`, payload: {} });
    expect(rbac403(res)).toBe(true);
    expect(mocks.flagEnabled).not.toHaveBeenCalled();
  });
});

describe('the actor: supervise comes from the role, never the request', () => {
  it('an agent\'s body carries only their id; a client\'s agent_user_id / on_behalf is stripped', async () => {
    const app = await appAs('agent');
    await app.inject({
      method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`,
      payload: { code: 'interested', agent_user_id: COLLEAGUE, on_behalf: true, supervise: true },
    });
    expect(lastCore()).toMatchObject({
      method: 'POST', path: `/agency/softphone/calls/${CALL}/disposition`, tenantId: TENANT, accountId: ACCOUNT,
    });
    expect(lastCore().body).toEqual({ code: 'interested', agent_user_id: AGENT });
  });

  it('an account admin\'s body carries on_behalf: true', async () => {
    const app = await appAs('account_admin');
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/hangup`, payload: {} });
    expect(lastCore().body).toEqual({ agent_user_id: SUPERVISOR, on_behalf: true });
  });

  it('a GET carries the actor on its query: supervise only for a supervisor, a client copy stripped', async () => {
    mocks.callCore.mockResolvedValue(plain({ rows: [], next_cursor: null, limit: 50 }));
    const agent = await appAs('agent');
    await agent.inject({ method: 'GET', url: `${P}/softphone/calls?supervise=true&actor_user_id=${COLLEAGUE}` });
    expect(lastCore().query).toEqual({ actor_user_id: AGENT });
    const admin = await appAs('account_admin');
    await admin.inject({ method: 'GET', url: `${P}/softphone/calls?agent_user_id=${AGENT}` });
    expect(lastCore().query).toEqual({ agent_user_id: AGENT, actor_user_id: SUPERVISOR, supervise: 'true' });
  });

  it('opening a soft-phone session sends only the caller, even for a supervisor', async () => {
    mocks.callCore.mockResolvedValue(plain({ session_id: SESSION, station_ws_url: `/api/v1/agency/station/${SESSION}?token=t` }, 201));
    const admin = await appAs('account_admin');
    const res = await admin.inject({ method: 'POST', url: `${P}/softphone/sessions`, payload: { agent_user_id: AGENT } });
    expect(lastCore().body).toEqual({ agent_user_id: SUPERVISOR });
    expect(res.statusCode).toBe(201);
    expect(res.json().station_ws_url).toBe(`/proxy/agency/station/${SESSION}?token=t`);
  });
});

describe('validation at the edge', () => {
  it.each([
    ['a non-uuid session_id', { session_id: 'nope', to: '9811100001' }],
    ['no number', { session_id: SESSION, to: '' }],
    ['a non-uuid campaign', { session_id: SESSION, to: '9811100001', campaign_id: 'c-1' }],
    ['a field value that is an object', { session_id: SESSION, to: '9811100001', fields: { a: { b: 1 } } }],
    ['a megabyte override note', { session_id: SESSION, to: '9811100001', overrides: { dnc_note: 'x'.repeat(2001) } }],
  ])('POST /calls refuses %s with 400 and never reaches the handler', async (_label, body) => {
    const app = await appAs('agent');
    const res = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation Error');
    expect(mocks.callCore).not.toHaveBeenCalled();
  });

  it('POST /calls forwards a null campaign (untagged) and strips unknown keys', async () => {
    const app = await appAs('agent');
    await app.inject({
      method: 'POST', url: `${P}/softphone/calls`,
      payload: { session_id: SESSION, to: ' 9811100001 ', campaign_id: null, bogus: 1, overrides: { dnc_note: 'n', other: 1 } },
    });
    expect(lastCore().body).toEqual({
      session_id: SESSION, to: '9811100001', campaign_id: null, overrides: { dnc_note: 'n' }, agent_user_id: AGENT,
    });
  });

  it.each([
    ['agent_user_id', 'agent_user_id=x'],
    ['campaign_id', 'campaign_id=x'],
    ['phone', 'phone=98-11'],
    ['from', 'from=yesterday'],
    ['limit', 'limit=1000'],
    ['outcome', 'outcome=great'],
  ])('GET /calls refuses a malformed %s', async (_label, qs) => {
    const app = await appAs('agent');
    const res = await app.inject({ method: 'GET', url: `${P}/softphone/calls?${qs}` });
    expect(res.statusCode).toBe(400);
    expect(mocks.callCore).not.toHaveBeenCalled();
  });

  it('GET /calls forwards the console\'s query exactly', async () => {
    mocks.callCore.mockResolvedValue(plain({ rows: [], next_cursor: null, limit: 8 }));
    const app = await appAs('agent');
    const res = await app.inject({
      method: 'GET',
      url: `${P}/softphone/calls?limit=8&agent_user_id=${AGENT}&campaign_id=untagged&outcome=no_answer&phone=1234`
        + '&from=2026-10-30T00:00:00.000Z&to=2026-10-31T00:00:00.000Z&cursor=abc',
    });
    expect(res.statusCode).toBe(200);
    expect(lastCore().query).toEqual({
      limit: '8', agent_user_id: AGENT, campaign_id: 'untagged', outcome: 'no_answer', phone: '1234',
      from: '2026-10-30T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z', cursor: 'abc', actor_user_id: AGENT,
    });
  });

  it('PATCH and disposition bound their bodies', async () => {
    const app = await appAs('agent');
    expect((await app.inject({ method: 'PATCH', url: `${P}/softphone/calls/${CALL}`, payload: { notes: 'x'.repeat(4001) } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`, payload: {} })).statusCode).toBe(400);
    expect(mocks.callCore).not.toHaveBeenCalled();
  });

  it('PUT /settings forwards the five settings and drops the rest (updated_at)', async () => {
    mocks.callCore.mockResolvedValue(envelope({ settings: {} }, { changed: [] }));
    const app = await appAs('account_admin');
    await app.inject({
      method: 'PUT', url: `${P}/softphone/settings`,
      payload: { disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: null, updated_at: 'x' },
    });
    expect(lastCore().body).toEqual({ disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: null });
  });
});

describe('refusals and the envelope', () => {
  it('passes a refusal through with its status and fields', async () => {
    const refusal = { error: 'Conflict', code: 'dnc_listed', message: 'm', entry: { id: ENTRY, scope: 'tenant', reason: null, created_at: 'x' } };
    mocks.callCore.mockResolvedValue(plain(refusal, 409));
    const app = await appAs('agent');
    const res = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(refusal);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('lets the reviewed 503s (dnc_unavailable, dial_failed) through the error mask, and masks any other 5xx', async () => {
    const app = await appAs('agent');
    mocks.callCore.mockResolvedValue(plain({ error: 'Service Unavailable', code: 'dnc_unavailable', message: 'm' }, 503));
    const unavailable = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().code).toBe('dnc_unavailable');
    mocks.callCore.mockResolvedValue(plain({ error: 'Service Unavailable', code: 'dial_failed', message: 'm' }, 503));
    const failed = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(failed.statusCode).toBe(503);
    expect(failed.json().code).toBe('dial_failed');
    mocks.callCore.mockResolvedValue(plain({ error: 'x', code: 'boom', message: 'db said no' }, 503));
    const masked = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(masked.statusCode).toBe(503);
    expect(masked.json().code).toBeUndefined();
    expect(masked.body).not.toContain('db said no');
  });

  it('a success without the internal envelope is a 502, never a leak, and writes no audit row', async () => {
    mocks.callCore.mockResolvedValue(plain(wireCall(), 201));
    const app = await appAs('agent');
    const res = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(res.statusCode).toBe(502);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('answers the envelope\'s answer only: the audit facts never reach the browser', async () => {
    mocks.callCore.mockResolvedValue(envelope(wireCall(), {
      session_id: SESSION, campaign_id: CAMPAIGN, dnc_override: { note: 'secret note text', entry_id: ENTRY }, hours_override_note: null,
    }, 201));
    const app = await appAs('agent');
    const res = await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(wireCall());
    expect(res.body).not.toContain('secret note text');
  });
});

describe('enrichment', () => {
  it('fills agent_name on every list row from one names read', async () => {
    mocks.callCore.mockResolvedValue(plain({
      rows: [wireCall(), wireCall({ id: 'b', agent_user_id: COLLEAGUE, analysis_status: 'completed' })], next_cursor: null, limit: 50,
    }));
    const app = await appAs('account_admin');
    const res = await app.inject({ method: 'GET', url: `${P}/softphone/calls` });
    expect(res.json().rows.map((r: { agent_name: string | null }) => r.agent_name)).toEqual(['Asha Agent', null]);
    expect(res.json().rows[1].analysis_status).toBe('completed');
    expect(mocks.names).toHaveBeenCalledTimes(1);
    expect(mocks.names).toHaveBeenCalledWith([AGENT, COLLEAGUE], TENANT);
  });

  it('a failed names read degrades to null names, never a 500', async () => {
    mocks.names.mockRejectedValue(new Error('users down'));
    mocks.callCore.mockResolvedValue(plain({ rows: [wireCall()], next_cursor: null, limit: 50 }));
    const app = await appAs('agent');
    const res = await app.inject({ method: 'GET', url: `${P}/softphone/calls` });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].agent_name).toBeNull();
  });

  it('the detail: agent_name, dispositioned_by_name, the media leg repointed and stripped by the account grants', async () => {
    const media = {
      id: 'leg', recording_url: '/api/v1/agency/softphone/calls/x/recording', analysis_status: 'completed',
      call_analysis: { summary: 's' }, conversation_log: [], transcript_meta: {}, caller_id: '+919000000001',
    };
    mocks.callCore.mockResolvedValue(plain({
      call: wireCall(), overrides: { dnc_note: null, dnc_entry_id: null, hours_note: null }, media, call_availability: 'available',
    }));
    const app = await appAs('agent');
    const full = await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}` });
    expect(full.json()).toMatchObject({
      call: { agent_name: 'Asha Agent' },
      dispositioned_by_name: 'Sam Supervisor',
      media: { recording_url: `/proxy/agency/softphone/calls/${CALL}/recording`, call_analysis: { summary: 's' } },
    });
    mocks.accountSettings.mockResolvedValue({ allow_recording: false, analyze_calls: false });
    const stripped = await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}` });
    expect(stripped.json().media).toMatchObject({ recording_url: null, call_analysis: null, conversation_log: null, analysis_status: 'completed' });
  });

  it('the detail fails closed (502) on an envelope it does not recognise', async () => {
    mocks.callCore.mockResolvedValue(plain({ call: wireCall(), media: 'bytes' }));
    const app = await appAs('agent');
    expect((await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}` })).statusCode).toBe(502);
  });

  it('bootstrap names the live call\'s agent', async () => {
    mocks.callCore.mockResolvedValue(plain({ taggable_campaigns: [], call: wireCall(), session: null }));
    const app = await appAs('agent');
    const res = await app.inject({ method: 'GET', url: `${P}/softphone/bootstrap` });
    expect(res.json().call.agent_name).toBe('Asha Agent');
    expect(lastCore().query).toEqual({ actor_user_id: AGENT });
  });
});

describe('the recording route', () => {
  it('403 capability_disabled without allow_recording, before the internal handler', async () => {
    mocks.accountSettings.mockResolvedValue({ allow_recording: false, analyze_calls: true });
    const app = await appAs('agent');
    const res = await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}/recording` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'capability_disabled', capability: 'agency.recording' });
    expect(mocks.callCore).not.toHaveBeenCalled();
  });

  it('a settings read that fails is nothing granted (fail closed)', async () => {
    mocks.accountSettings.mockRejectedValue(new Error('down'));
    const app = await appAs('agent');
    expect((await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}/recording` })).statusCode).toBe(403);
  });

  it('streams the bytes with the range forwarded; a buffered refusal is decoded to JSON', async () => {
    const app = await appAs('agent');
    mocks.callCore.mockResolvedValue(plain(Buffer.from('ID3audio'), 206, {
      'content-type': 'audio/mpeg', 'content-length': '8', 'content-range': 'bytes 0-7/100',
    }));
    const ok = await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}/recording`, headers: { range: 'bytes=0-7' } });
    expect(ok.statusCode).toBe(206);
    expect(ok.headers['content-type']).toBe('audio/mpeg');
    expect(ok.headers['content-range']).toBe('bytes 0-7/100');
    expect(ok.body).toBe('ID3audio');
    expect(lastCore()).toMatchObject({ rawResponse: true, headers: { range: 'bytes=0-7' }, query: { actor_user_id: AGENT } });

    mocks.callCore.mockResolvedValue(plain(Buffer.from(JSON.stringify({ error: 'Not Found', code: 'call_purged', message: 'm' })), 404,
      { 'content-type': 'application/json' }));
    const purged = await app.inject({ method: 'GET', url: `${P}/softphone/calls/${CALL}/recording` });
    expect(purged.statusCode).toBe(404);
    expect(purged.headers['content-type']).toMatch(/json/);
    expect(purged.json().code).toBe('call_purged');
  });
});

describe('the audit rows', () => {
  const base = { tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'human' };

  it('a placed call: placed, and each override with its note (and the DNC entry)', async () => {
    mocks.callCore.mockResolvedValue(envelope(wireCall(), {
      session_id: SESSION, campaign_id: CAMPAIGN,
      dnc_override: { note: 'Customer asked for a callback today.', entry_id: ENTRY },
      hours_override_note: 'Customer is in another timezone.',
    }, 201));
    const app = await appAs('agent');
    await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    const about = { ...base, user_id: AGENT, resource_type: 'agency_manual_call', resource_id: CALL, campaign_id: CAMPAIGN };
    expect(mocks.auditLog.mock.calls.map((c) => c[0])).toEqual([
      { ...about, action: 'agency_manual_call.placed',
        details: { session_id: SESSION, campaign_id: CAMPAIGN, dnc_overridden: true, hours_overridden: true } },
      { ...about, action: 'agency_manual_call.dnc_overridden',
        details: { note: 'Customer asked for a callback today.', dnc_entry_id: ENTRY, campaign_id: CAMPAIGN } },
      { ...about, action: 'agency_manual_call.hours_overridden',
        details: { note: 'Customer is in another timezone.', campaign_id: CAMPAIGN } },
    ]);
  });

  it('an untagged call without overrides: one row, no campaign', async () => {
    mocks.callCore.mockResolvedValue(envelope(wireCall({ tag: null }), {
      session_id: SESSION, campaign_id: null, dnc_override: null, hours_override_note: null,
    }, 201));
    const app = await appAs('agent');
    await app.inject({ method: 'POST', url: `${P}/softphone/calls`, payload: { session_id: SESSION, to: '1' } });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      ...base, user_id: AGENT, resource_type: 'agency_manual_call', resource_id: CALL,
      action: 'agency_manual_call.placed', details: { session_id: SESSION },
    });
  });

  it('hang-up, outcome and DNC mark: the actor, on_behalf from the result, the campaign', async () => {
    const app = await appAs('account_admin');
    mocks.callCore.mockResolvedValue(envelope(wireCall(), { on_behalf: true, campaign_id: CAMPAIGN }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/hangup`, payload: {} });
    mocks.callCore.mockResolvedValue(envelope({ call: wireCall() }, {
      on_behalf: true, campaign_id: CAMPAIGN, disposition_code: 'interested', replay: true,
    }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`, payload: { code: 'interested', notes: 'private' } });
    mocks.callCore.mockResolvedValue(envelope({ call_id: CALL }, { on_behalf: false, campaign_id: null, scope: 'account', dnc_recorded: true, dnc_entry: null }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/dnc`, payload: { reason: 'r' } });
    const about = { ...base, user_id: SUPERVISOR, resource_type: 'agency_manual_call', resource_id: CALL };
    expect(mocks.auditLog.mock.calls.map((c) => c[0])).toEqual([
      { ...about, campaign_id: CAMPAIGN, action: 'agency_manual_call.hung_up', details: { campaign_id: CAMPAIGN, on_behalf: true } },
      { ...about, campaign_id: CAMPAIGN, action: 'agency_manual_call.dispositioned',
        details: { disposition_code: 'interested', campaign_id: CAMPAIGN, on_behalf: true, replay: true } },
      { ...about, action: 'agency_manual_call.dnc_marked', details: { scope: 'account', dnc_recorded: true } },
    ]);
    // Free text an agent typed is never on the row.
    expect(JSON.stringify(mocks.auditLog.mock.calls)).not.toContain('private');
  });

  it('a soft-phone DNC write is on the DNC trail too (dnc_entry.created), only when a new row was recorded', async () => {
    const app = await appAs('account_admin');
    const entry = { id: ENTRY, created: true, scope: 'campaign' };
    // Mark DNC on a tagged call, on behalf.
    mocks.callCore.mockResolvedValue(envelope({ call_id: CALL }, {
      on_behalf: true, campaign_id: CAMPAIGN, scope: 'campaign', dnc_recorded: true, dnc_entry: entry,
    }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/dnc`, payload: {} });
    // A suppress outcome on an untagged call: account scope.
    mocks.callCore.mockResolvedValue(envelope({ call: wireCall({ tag: null }) }, {
      on_behalf: false, campaign_id: null, disposition_code: 'do_not_call', replay: false,
      dnc_entry: { id: ENTRY, created: true, scope: 'account' },
    }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`, payload: { code: 'do_not_call' } });
    // Already listed, and a replay: nothing new was recorded, so no DNC-trail row.
    mocks.callCore.mockResolvedValue(envelope({ call_id: CALL }, {
      on_behalf: false, campaign_id: null, scope: 'account', dnc_recorded: true, dnc_entry: { ...entry, created: false },
    }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/dnc`, payload: {} });
    mocks.callCore.mockResolvedValue(envelope({ call: wireCall() }, {
      on_behalf: false, campaign_id: CAMPAIGN, disposition_code: 'do_not_call', replay: true, dnc_entry: null,
    }));
    await app.inject({ method: 'POST', url: `${P}/softphone/calls/${CALL}/disposition`, payload: { code: 'do_not_call' } });

    const created = mocks.auditLog.mock.calls.map((c) => c[0]).filter((r) => r.action === 'dnc_entry.created');
    expect(created).toEqual([
      { ...base, user_id: SUPERVISOR, action: 'dnc_entry.created', resource_type: 'dnc_entry', resource_id: ENTRY,
        campaign_id: CAMPAIGN, details: { manual_call_id: CALL, scope: 'campaign', campaign_id: CAMPAIGN, on_behalf: true } },
      { ...base, user_id: SUPERVISOR, action: 'dnc_entry.created', resource_type: 'dnc_entry', resource_id: ENTRY,
        details: { manual_call_id: CALL, scope: 'account', disposition_code: 'do_not_call' } },
    ]);
  });

  it('PATCH writes no audit row', async () => {
    mocks.callCore.mockResolvedValue(plain(wireCall()));
    const app = await appAs('agent');
    expect((await app.inject({ method: 'PATCH', url: `${P}/softphone/calls/${CALL}`, payload: { notes: 'n' } })).statusCode).toBe(200);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('the switch and the return: from-state, queued / withdrawn, the campaign', async () => {
    const app = await appAs('agent');
    mocks.callCore.mockResolvedValue(envelope({ session_id: SESSION, state: 'on_call', pending_state: 'break' }, {
      campaign_id: CAMPAIGN, from_state: 'on_call', queued: true, withdrawn: false, unchanged: false,
    }));
    const started = await app.inject({ method: 'POST', url: `${P}/sessions/${SESSION}/softphone`, payload: {} });
    expect(started.json()).toEqual({ session_id: SESSION, state: 'on_call', pending_state: 'break' });
    mocks.callCore.mockResolvedValue(envelope({ session_id: SESSION, state: 'on_call' }, {
      campaign_id: CAMPAIGN, from_state: 'on_call', queued: false, withdrawn: true, unchanged: false,
    }));
    await app.inject({ method: 'POST', url: `${P}/sessions/${SESSION}/softphone/return`, payload: {} });
    const about = { ...base, user_id: AGENT, resource_type: 'agency_session', resource_id: SESSION, campaign_id: CAMPAIGN };
    expect(mocks.auditLog.mock.calls.map((c) => c[0])).toEqual([
      { ...about, action: 'agency_session.softphone_started', details: { campaign_id: CAMPAIGN, from_state: 'on_call', queued: true } },
      { ...about, action: 'agency_session.softphone_ended', details: { campaign_id: CAMPAIGN, from_state: 'on_call', withdrawn: true, via: 'return' } },
    ]);
    expect(lastCore().body).toEqual({ agent_user_id: AGENT });
  });

  it('an idempotent re-switch (already on the soft phone, or already queued) writes no second softphone_started', async () => {
    const app = await appAs('agent');
    mocks.callCore.mockResolvedValue(envelope({ session_id: SESSION, state: 'break', break_reason: 'soft_phone' }, {
      campaign_id: CAMPAIGN, from_state: 'break', queued: false, withdrawn: false, unchanged: true,
    }));
    const again = await app.inject({ method: 'POST', url: `${P}/sessions/${SESSION}/softphone`, payload: {} });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ session_id: SESSION, state: 'break', break_reason: 'soft_phone' });
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('the session open and the settings write', async () => {
    const admin = await appAs('account_admin');
    mocks.callCore.mockResolvedValue(plain({ session_id: SESSION, station_ws_url: 'x' }, 200));
    await admin.inject({ method: 'POST', url: `${P}/softphone/sessions`, payload: {} });
    mocks.callCore.mockResolvedValue(envelope({ settings: {} }, { changed: ['record_calls'] }));
    await admin.inject({
      method: 'PUT', url: `${P}/softphone/settings`,
      payload: { disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: null },
    });
    expect(mocks.auditLog.mock.calls.map((c) => c[0])).toEqual([
      { ...base, user_id: SUPERVISOR, action: 'agency_session.joined', resource_type: 'agency_session', resource_id: SESSION,
        details: { kind: 'softphone', created: false } },
      { ...base, user_id: SUPERVISOR, action: 'agency_softphone_settings.updated', resource_type: 'agency_softphone_settings',
        details: { changed: ['record_calls'] } },
    ]);
  });

  it('a refused action writes nothing', async () => {
    mocks.callCore.mockResolvedValue(plain({ error: 'Not Found', code: 'call_not_found', message: 'm' }, 404));
    const app = await appAs('agent');
    for (const r of ROUTES.filter((x) => x.method !== 'GET')) await call(app, r);
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });
});
