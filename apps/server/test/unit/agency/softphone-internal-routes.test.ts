import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * The soft phone's INTERNAL handlers (`api/routes/agency/softphone.ts`) over a mocked
 * runtime and mocked repositories: the actor they build from the body / query (the
 * public layer's `on_behalf` → `supervise`), each runtime refusal mapped onto its contract
 * status and body, the envelope of the audited routes, the list's scoping, the detail's
 * visibility and media availability, the recording's refusals, the settings checks, the
 * soft-phone session's open and refusal, and bootstrap's taggable set.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const SIBLING = '23232323-2323-4232-8232-232323232323';
const AGENT = '33333333-3333-4333-8333-333333333333';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const SESSION = '66666666-6666-4666-8666-666666666666';
const CALL = '77777777-7777-4777-8777-777777777777';
const CAMPAIGN = '88888888-8888-4888-8888-888888888888';
const OTHER_CAMPAIGN = '99999999-9999-4999-8999-999999999999';
const PROFILE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const repos = vi.hoisted(() => ({
  session: { joinSoftphone: vi.fn(), findLiveForAgent: vi.fn(), findById: vi.fn() },
  campaign: { findById: vi.fn(), list: vi.fn(), listSoftphoneTaggable: vi.fn() },
  manual: { findById: vi.fn(), listForAgent: vi.fn(), listForAccount: vi.fn() },
  settings: { get: vi.fn(), upsert: vi.fn() },
  numbers: { findAvailableForAccount: vi.fn() },
  staffing: { listActiveForUser: vi.fn() },
  profiles: { findByIdScoped: vi.fn() },
  calls: { findByIdScoped: vi.fn() },
  accounts: { findByIdInTenant: vi.fn() },
}));

vi.mock('../../../src/db/repositories/agency.repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/db/repositories/agency.repository.js')>();
  return {
    validateSoftphoneSettings: actual.validateSoftphoneSettings,
    agencyAgentSessionRepository: repos.session,
    agencyCampaignRepository: repos.campaign,
    agencyManualCallRepository: repos.manual,
    agencySoftphoneSettingsRepository: repos.settings,
    agencyAttemptRepository: {},
    agencyContactRepository: {},
  };
});
vi.mock('@magick-agency/db/repositories/tenant-phone-assignment.repository', () => ({ tenantPhoneAssignmentRepository: repos.numbers }));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({ agencyCampaignAgentRepository: repos.staffing }));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({ callAnalysisProfileRepository: repos.profiles }));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: repos.calls }));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({ accountRepository: repos.accounts }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => {}),
  getTenantId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-tenant'],
  getAccountId: (req: { headers: Record<string, string> }) => req.headers['x-mgkvc-account'],
}));
vi.mock('../../../src/utils/recording-proxy.js', () => ({
  proxyCallRecording: vi.fn(async (_c: unknown, _req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) =>
    reply.code(200).send('bytes')),
}));
vi.mock('../../../src/config/index.js', () => ({ config: { voicelinkRecording: { allowedHosts: [] }, redis: { keyPrefix: '' }, telephony: {} } }));

import { registerSoftphoneRoutes } from '../../../src/api/routes/agency/softphone.js';
import { SOFTPHONE_REFUSAL_STATUS } from '../../../src/api/routes/agency/softphone-answer.js';
import type { SoftphoneRefusal } from '../../../src/agency/softphone/types.js';
import { AGENCY_SOFTPHONE_ERROR_CODES } from '@magick-agency/contracts/errors';

const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };

function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: vi.fn().mockResolvedValue(null) },
    breaks: { peek: vi.fn(() => null) },
    tokens: { mint: vi.fn(async () => ({ token: 'tkn', expiresAt: new Date('2026-10-30T10:02:00Z') })) },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    manualDialer: { wireFor: vi.fn(async (row: { id: string }) => ({ id: row.id, contact: null })) },
    softphone: {
      placeCall: vi.fn(), hangup: vi.fn(), updateDetails: vi.fn(), submitDisposition: vi.fn(), markDnc: vi.fn(),
      switchToSoftphone: vi.fn(), returnFromSoftphone: vi.fn(), getLiveForSession: vi.fn().mockResolvedValue(null),
    },
  };
}

let runtime: ReturnType<typeof makeRuntime>;
let app: FastifyInstance;

async function build() {
  runtime = makeRuntime();
  app = Fastify({ logger: false });
  await app.register((a) => registerSoftphoneRoutes(a as never, runtime as never), { prefix: '/api/v1/agency' });
  await app.ready();
}

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/agency${url}`, headers: HEADERS, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1/agency${url}`, headers: HEADERS });

const row = (overrides: Record<string, unknown> = {}) => ({
  id: CALL, tenant_id: TENANT, account_id: ACCOUNT, session_id: SESSION, agent_user_id: AGENT, campaign_id: CAMPAIGN,
  contact_id: null, webrtc_call_id: LEG, dnc_override_note: null, dnc_override_entry_id: null, hours_override_note: null,
  ...overrides,
});

beforeEach(async () => {
  vi.clearAllMocks();
  repos.settings.get.mockResolvedValue({
    disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: false, default_caller_id: null, updated_at: null,
  });
  repos.numbers.findAvailableForAccount.mockResolvedValue([{ phone_number: '+919000000001' }, { phone_number: '+919000000002' }]);
  await build();
});

describe('the refusal statuses are the contract\'s', () => {
  it('maps every AgencySoftphoneErrorCode to the status `errors.ts` documents beside it', () => {
    const source = readFileSync(fileURLToPath(new URL('../../../../../packages/contracts/src/errors.ts', import.meta.url)), 'utf8');
    const block = source.slice(source.indexOf('export type AgencySoftphoneErrorCode'), source.indexOf('export const AGENCY_SOFTPHONE_ERROR_CODES'));
    const documented = new Map([...block.matchAll(/\/\*\*\s*(\d{3})\.[\s\S]*?\*\/\s*\|\s*'([a-z_]+)'/g)].map((m) => [m[2]!, Number(m[1])]));
    expect(documented.size).toBe(AGENCY_SOFTPHONE_ERROR_CODES.length);
    for (const code of AGENCY_SOFTPHONE_ERROR_CODES) {
      expect(SOFTPHONE_REFUSAL_STATUS[code], code).toBe(documented.get(code));
    }
  });
});

describe('POST /softphone/calls', () => {
  const body = { session_id: SESSION, to: '9811100001', agent_user_id: AGENT };

  it('builds the actor from the body: on_behalf → supervise; tenant and account from the headers', async () => {
    runtime.softphone.placeCall.mockResolvedValue({ ok: false, refusal: { code: 'invalid_number' } });
    await post('/softphone/calls', { ...body, on_behalf: true, campaign_id: CAMPAIGN, caller_id: '+919000000001', fields: { a: 1 } });
    expect(runtime.softphone.placeCall).toHaveBeenCalledWith(
      { tenantId: TENANT, accountId: ACCOUNT, userId: AGENT, supervise: true },
      { sessionId: SESSION, to: '9811100001', callerId: '+919000000001', campaignId: CAMPAIGN, fields: { a: 1 } },
    );
    await post('/softphone/calls', body);
    expect(runtime.softphone.placeCall.mock.calls[1]![0]).toMatchObject({ supervise: false });
    expect(runtime.softphone.placeCall.mock.calls[1]![1]).toMatchObject({ campaignId: null });
  });

  it('refuses a request with no actor (400 missing_actor) before the runtime', async () => {
    const res = await post('/softphone/calls', { session_id: SESSION, to: '1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(runtime.softphone.placeCall).not.toHaveBeenCalled();
  });

  const call = { id: CALL };
  const refusals: SoftphoneRefusal[] = [
    { code: 'session_not_found' }, { code: 'wrong_session_kind' }, { code: 'not_on_softphone' }, { code: 'invalid_number' },
    { code: 'caller_id_not_allowed', allowed_codes: ['+919000000001'] }, { code: 'campaign_not_taggable' },
    { code: 'override_note_invalid', details: [{ path: 'overrides.dnc_note', message: 'm' }] },
    { code: 'fields_invalid', details: [{ path: 'fields.x', message: 'm' }] },
    { code: 'contact_in_flight', campaign_id: CAMPAIGN, contact_id: 'c' },
    { code: 'outside_calling_hours', window: { start: '09:00', end: '18:00', days: [1], timezone: 'Asia/Kolkata' }, timezone_source: 'contact', next_open_at: null },
    { code: 'dnc_listed', entry: { id: 'e', scope: 'tenant', reason: null, created_at: 'x' } }, { code: 'dnc_unavailable' },
    { code: 'manual_call_live', call: call as never }, { code: 'outcome_pending', call: call as never },
    { code: 'concurrency_limit' }, { code: 'station_unavailable' }, { code: 'dial_failed' },
  ];
  it.each(refusals.map((r) => [r.code, r] as const))('maps %s to its status with its fields', async (code, refusal) => {
    runtime.softphone.placeCall.mockResolvedValue({ ok: false, refusal });
    const res = await post('/softphone/calls', body);
    expect(res.statusCode).toBe(SOFTPHONE_REFUSAL_STATUS[code]);
    expect(res.json()).toEqual({ error: expect.any(String), message: expect.any(String), ...refusal });
  });

  it('answers 201 with the envelope: the call, and the audit facts (overrides, campaign)', async () => {
    runtime.softphone.placeCall.mockResolvedValue({
      ok: true, call: { id: CALL, session_id: SESSION, tag: { campaign_id: CAMPAIGN } },
      dncOverride: { note: 'n'.repeat(12), entryId: 'e1' }, hoursOverrideNote: null,
    });
    const res = await post('/softphone/calls', body);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      answer: { id: CALL, session_id: SESSION, tag: { campaign_id: CAMPAIGN } },
      audit: { session_id: SESSION, campaign_id: CAMPAIGN, dnc_override: { note: 'n'.repeat(12), entry_id: 'e1' }, hours_override_note: null },
    });
  });
});

describe('the call actions', () => {
  it('hangup / disposition / dnc wrap the result with on_behalf from the RESULT', async () => {
    runtime.softphone.hangup.mockResolvedValue({ ok: true, call: { id: CALL, tag: null }, onBehalf: true, hungUp: true });
    expect((await post(`/softphone/calls/${CALL}/hangup`, { agent_user_id: AGENT, on_behalf: true })).json())
      .toEqual({ answer: { id: CALL, tag: null }, audit: { on_behalf: true, campaign_id: null, hung_up: true } });
    // Already ended: the audit facts say no hang-up was issued.
    runtime.softphone.hangup.mockResolvedValue({ ok: true, call: { id: CALL, tag: null }, onBehalf: false, hungUp: false });
    expect((await post(`/softphone/calls/${CALL}/hangup`, { agent_user_id: AGENT })).json().audit)
      .toEqual({ on_behalf: false, campaign_id: null, hung_up: false });

    runtime.softphone.submitDisposition.mockResolvedValue({
      ok: true, onBehalf: false, replay: false, dncEntry: { id: 'entry-1', created: true },
      response: { call: { id: CALL, tag: { campaign_id: CAMPAIGN }, disposition_code: 'sold' } },
    });
    const disposed = await post(`/softphone/calls/${CALL}/disposition`, { agent_user_id: AGENT, code: 'sold', callback_at: 'x', notes: 'n' });
    expect(runtime.softphone.submitDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ userId: AGENT, supervise: false }), CALL, { code: 'sold', notes: 'n', callbackAt: 'x' },
    );
    expect(disposed.json().audit).toEqual({
      on_behalf: false, campaign_id: CAMPAIGN, disposition_code: 'sold', replay: false,
      dnc_entry: { id: 'entry-1', created: true, scope: 'campaign' },
    });

    runtime.softphone.markDnc.mockResolvedValue({
      ok: true, onBehalf: false, dncEntry: { id: 'entry-2', created: false },
      response: { call_id: CALL, scope: 'campaign', dnc_recorded: true },
    });
    repos.manual.findById.mockResolvedValue(row());
    const marked = await post(`/softphone/calls/${CALL}/dnc`, { agent_user_id: AGENT });
    expect(marked.json().audit).toEqual({
      on_behalf: false, campaign_id: CAMPAIGN, scope: 'campaign', dnc_recorded: true,
      dnc_entry: { id: 'entry-2', created: false, scope: 'campaign' },
    });
  });

  it.each([
    [{ code: 'call_not_found' }, 404],
    [{ code: 'manual_call_live', call: { id: CALL } }, 409],
    [{ code: 'call_settled', call: { id: CALL } }, 409],
    [{ code: 'fields_invalid', details: [{ path: 'fields.x', message: 'm' }] }, 400],
  ] as const)('a disposition refusal %o → %i', async (refusal, status) => {
    runtime.softphone.submitDisposition.mockResolvedValue({ ok: false, refusal });
    const res = await post(`/softphone/calls/${CALL}/disposition`, { agent_user_id: AGENT, code: 'x' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject(refusal);
  });

  it('a disposition_invalid refusal keeps its reason and allowed codes', async () => {
    runtime.softphone.submitDisposition.mockResolvedValue({
      ok: false, refusal: { code: 'disposition_invalid', reason: 'unknown_code', allowed_codes: ['a', 'b'] },
    });
    const res = await post(`/softphone/calls/${CALL}/disposition`, { agent_user_id: AGENT, code: 'x' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'disposition_invalid', reason: 'unknown_code', allowed_codes: ['a', 'b'] });
  });

  it('PATCH answers the call itself (not audited, no envelope)', async () => {
    runtime.softphone.updateDetails.mockResolvedValue({ ok: true, call: { id: CALL, notes: 'n' }, onBehalf: false });
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/agency/softphone/calls/${CALL}`, headers: HEADERS, payload: { agent_user_id: AGENT, notes: 'n' } });
    expect(res.json()).toEqual({ id: CALL, notes: 'n' });
    expect(runtime.softphone.updateDetails).toHaveBeenCalledWith(expect.objectContaining({ userId: AGENT }), CALL, { notes: 'n' });
  });
});

describe('GET /softphone/calls — scoping', () => {
  const page = { rows: [], next_cursor: null, limit: 50 };
  beforeEach(() => {
    repos.manual.listForAgent.mockResolvedValue(page);
    repos.manual.listForAccount.mockResolvedValue(page);
  });

  it('an agent lists their own calls only', async () => {
    expect((await get(`/softphone/calls?actor_user_id=${AGENT}&campaign_id=untagged&phone=12&limit=8`)).statusCode).toBe(200);
    expect(repos.manual.listForAgent).toHaveBeenCalledWith({
      tenantId: TENANT, accountId: ACCOUNT, agentUserId: AGENT, limit: 8,
      filters: { campaign: 'untagged', phoneDigits: '12' },
    });
    expect(repos.manual.listForAccount).not.toHaveBeenCalled();
  });

  it('an agent naming another agent is refused 403, not handed an empty page', async () => {
    const res = await get(`/softphone/calls?actor_user_id=${AGENT}&agent_user_id=${COLLEAGUE}`);
    expect(res.statusCode).toBe(403);
    expect(repos.manual.listForAgent).not.toHaveBeenCalled();
  });

  it('a supervisor lists the account, optionally one agent, with the date bounds', async () => {
    await get(`/softphone/calls?actor_user_id=${COLLEAGUE}&supervise=true&agent_user_id=${AGENT}&campaign_id=${CAMPAIGN}`
      + '&from=2026-10-30T00:00:00.000Z&to=2026-10-31T00:00:00.000Z');
    expect(repos.manual.listForAccount).toHaveBeenCalledWith({
      tenantId: TENANT, accountId: ACCOUNT, limit: 50,
      filters: { campaign: { campaignId: CAMPAIGN }, from: new Date('2026-10-30T00:00:00.000Z'), to: new Date('2026-10-31T00:00:00.000Z'), agentUserId: AGENT },
    });
  });

  it('a malformed cursor is a 400, never page one', async () => {
    const res = await get(`/softphone/calls?actor_user_id=${AGENT}&cursor=garbage`);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('malformed_cursor');
  });
});

describe('GET /softphone/calls/:id and its recording', () => {
  it('another agent\'s call is call_not_found unless supervising', async () => {
    repos.manual.findById.mockResolvedValue(row({ agent_user_id: COLLEAGUE }));
    repos.calls.findByIdScoped.mockResolvedValue({ id: LEG, recording_url: null });
    const agent = await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}`);
    expect(agent.statusCode).toBe(404);
    expect(agent.json().code).toBe('call_not_found');
    const sup = await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}&supervise=true`);
    expect(sup.statusCode).toBe(200);
    expect(repos.manual.findById).toHaveBeenCalledWith(CALL, { tenantId: TENANT, accountId: ACCOUNT });
  });

  it('reports never_placed / purged / available, with the override notes', async () => {
    repos.manual.findById.mockResolvedValue(row({ webrtc_call_id: null, dnc_override_note: 'note', dnc_override_entry_id: 'e1' }));
    const never = (await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}`)).json();
    expect(never).toMatchObject({ call_availability: 'never_placed', media: null, overrides: { dnc_note: 'note', dnc_entry_id: 'e1', hours_note: null } });
    repos.manual.findById.mockResolvedValue(row());
    repos.calls.findByIdScoped.mockResolvedValue(null);
    expect((await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}`)).json()).toMatchObject({ call_availability: 'purged', media: null });
    repos.calls.findByIdScoped.mockResolvedValue({ id: LEG, recording_url: 'https://rec' });
    const available = (await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}&supervise=true`)).json();
    expect(available.call_availability).toBe('available');
    expect(available.media.recording_url).toBe(`/api/v1/agency/softphone/calls/${CALL}/recording`);
    expect(repos.calls.findByIdScoped).toHaveBeenCalledWith(LEG, TENANT, ACCOUNT, 'agency');
  });

  it('an agent reading their own call gets the record, never the media leg (recording, transcript, analysis)', async () => {
    repos.manual.findById.mockResolvedValue(row({ notes: 'n', fields: { policy_no: 'P1' } }));
    repos.calls.findByIdScoped.mockResolvedValue({ id: LEG, recording_url: 'https://rec', call_analysis: { summary: 's' } });
    const own = await get(`/softphone/calls/${CALL}?actor_user_id=${AGENT}`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ call: { id: CALL }, call_availability: 'available', media: null });
    expect(own.body).not.toContain('https://rec');
  });

  it('the recording (supervise): call_never_placed, call_purged, out of the account → call_not_found, else the proxy', async () => {
    const sup = `actor_user_id=${AGENT}&supervise=true`;
    repos.manual.findById.mockResolvedValue(row({ webrtc_call_id: null }));
    expect((await get(`/softphone/calls/${CALL}/recording?${sup}`)).json().code).toBe('call_never_placed');
    repos.manual.findById.mockResolvedValue(row());
    repos.calls.findByIdScoped.mockResolvedValue(null);
    expect((await get(`/softphone/calls/${CALL}/recording?${sup}`)).json().code).toBe('call_purged');
    repos.manual.findById.mockResolvedValue(null);
    expect((await get(`/softphone/calls/${CALL}/recording?${sup}`)).json().code).toBe('call_not_found');
    repos.manual.findById.mockResolvedValue(row({ agent_user_id: COLLEAGUE }));
    repos.calls.findByIdScoped.mockResolvedValue({ id: LEG, recording_url: 'https://rec' });
    const any = await get(`/softphone/calls/${CALL}/recording?${sup}`);
    expect(any.statusCode).toBe(200);
    expect(any.body).toBe('bytes');
  });

  it('the recording refuses an agent, their own call included, before any read', async () => {
    repos.manual.findById.mockClear();
    repos.manual.findById.mockResolvedValue(row());
    repos.calls.findByIdScoped.mockResolvedValue({ id: LEG, recording_url: 'https://rec' });
    const own = await get(`/softphone/calls/${CALL}/recording?actor_user_id=${AGENT}`);
    expect(own.statusCode).toBe(403);
    expect(own.json()).toEqual({ error: 'Forbidden', message: 'Insufficient permissions. Required: agency.supervise' });
    expect(repos.manual.findById).not.toHaveBeenCalled();
  });
});

describe('the settings', () => {
  const valid = { disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: '+919000000002' };
  const putSettings = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/v1/agency/softphone/settings', headers: HEADERS, payload: payload as object });

  it('refuses a caller ID that is not the account\'s, and a profile that is missing or inactive', async () => {
    const badCaller = await putSettings({ ...valid, default_caller_id: '+911' });
    expect(badCaller.statusCode).toBe(400);
    expect(badCaller.json()).toMatchObject({ code: 'settings_invalid', details: [{ path: 'default_caller_id' }] });
    repos.profiles.findByIdScoped.mockResolvedValue({ id: PROFILE, is_active: false });
    const inactive = await putSettings({ ...valid, analysis_profile_id: PROFILE });
    expect(inactive.json()).toMatchObject({ code: 'settings_invalid', details: [{ path: 'analysis_profile_id' }] });
    expect(repos.profiles.findByIdScoped).toHaveBeenCalledWith(PROFILE, TENANT, ACCOUNT);
    const shape = await putSettings({ ...valid, record_calls: 'yes' });
    expect(shape.json().details).toEqual([{ path: 'record_calls', message: expect.any(String) }]);
    expect(repos.settings.upsert).not.toHaveBeenCalled();
  });

  it('writes a valid body and reports which settings changed', async () => {
    repos.settings.upsert.mockResolvedValue({ ...valid, updated_at: 'now' });
    const res = await putSettings(valid);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: { settings: { ...valid, updated_at: 'now' } }, audit: { changed: ['record_calls', 'default_caller_id'] } });
    expect(repos.settings.upsert).toHaveBeenCalledWith(TENANT, ACCOUNT, valid);
  });
});

describe('POST /softphone/sessions', () => {
  it('opens (201) with a token url and the soft-phone break; a rehydrate is 200', async () => {
    repos.session.joinSoftphone.mockResolvedValue({ ok: true, created: true, session: { id: SESSION, kind: 'softphone', break_reason: 'soft_phone' } });
    const res = await post('/softphone/sessions', { agent_user_id: AGENT });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      session_id: SESSION, kind: 'softphone', state: 'break', break_reason: 'soft_phone',
      station_ws_url: `/api/v1/agency/station/${SESSION}?token=tkn`, station_token_expires_at: '2026-10-30T10:02:00.000Z',
    });
    expect(repos.session.joinSoftphone).toHaveBeenCalledWith({ tenantId: TENANT, accountId: ACCOUNT, agentUserId: AGENT, replicaId: 'r1' });
    expect(runtime.rehydrateAgent).toHaveBeenCalledWith(SESSION, expect.objectContaining({ kind: 'softphone' }));
    repos.session.joinSoftphone.mockResolvedValue({ ok: true, created: false, session: { id: SESSION, kind: 'softphone' } });
    expect((await post('/softphone/sessions', { agent_user_id: AGENT })).statusCode).toBe(200);
  });

  it('409 session_on_campaign names the campaign (tenant-scoped), the live state and the account', async () => {
    const blocker = { id: SESSION, tenant_id: TENANT, account_id: SIBLING, campaign_id: CAMPAIGN, state: 'available' };
    repos.session.joinSoftphone.mockResolvedValue({ ok: false, reason: 'on_campaign', session: blocker });
    repos.campaign.findById.mockResolvedValue({ id: CAMPAIGN, tenant_id: TENANT, name: 'Renewals' });
    repos.accounts.findByIdInTenant.mockResolvedValue({ id: SIBLING, tenant_id: TENANT, name: 'North Region' });
    runtime.agents.get.mockResolvedValue({ state: 'on_call' });
    const res = await post('/softphone/sessions', { agent_user_id: AGENT });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict', code: 'session_on_campaign', message: expect.any(String),
      session_id: SESSION, campaign_id: CAMPAIGN, campaign_name: 'Renewals', state: 'on_call',
      account_id: SIBLING, account_name: 'North Region',
    });
    expect(repos.accounts.findByIdInTenant).toHaveBeenCalledWith(SIBLING, TENANT);
    // Another tenant's name never crosses; a failed lookup still answers the 409.
    repos.campaign.findById.mockResolvedValue({ id: CAMPAIGN, tenant_id: 'other', name: 'Secret' });
    expect((await post('/softphone/sessions', { agent_user_id: AGENT })).json().campaign_name).toBe('another campaign');
    repos.campaign.findById.mockRejectedValue(new Error('down'));
    repos.accounts.findByIdInTenant.mockRejectedValue(new Error('down'));
    const degraded = await post('/softphone/sessions', { agent_user_id: AGENT });
    expect(degraded.statusCode).toBe(409);
    expect(degraded.json()).toMatchObject({ account_id: SIBLING, account_name: null });
    expect(runtime.tokens.mint).not.toHaveBeenCalled();
  });

  it('409 session_on_softphone for a soft-phone session in another account: named, never rehydrated', async () => {
    const blocker = { id: SESSION, tenant_id: TENANT, account_id: SIBLING, kind: 'softphone', campaign_id: null, state: 'break' };
    repos.session.joinSoftphone.mockResolvedValue({ ok: false, reason: 'softphone_elsewhere', session: blocker });
    repos.accounts.findByIdInTenant.mockResolvedValue({ id: SIBLING, tenant_id: TENANT, name: 'North Region' });
    const res = await post('/softphone/sessions', { agent_user_id: AGENT });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict', code: 'session_on_softphone', message: expect.stringMatching(/another account/i),
      session_id: SESSION, account_id: SIBLING, account_name: 'North Region',
    });
    expect(runtime.rehydrateAgent).not.toHaveBeenCalled();
    expect(runtime.tokens.mint).not.toHaveBeenCalled();
  });
});

describe('GET /softphone/bootstrap', () => {
  const campaign = (id: string, name: string) => ({
    id, name, status: 'running', caller_ids: ['+919000000001', ''], disposition_catalog: [],
    calling_window_start: '00:00', calling_window_end: '23:59', calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
    record_calls: true, analysis_profile_id: PROFILE, context_display: {},
  });
  beforeEach(() => {
    // The query applies the status and staffing filters (real SQL:
    // softphone-policy-routes.test.ts); here, what it is asked.
    repos.campaign.listSoftphoneTaggable.mockImplementation(async (_t: string, _a: string, opts: { staffedUserId: string | null }) =>
      opts.staffedUserId ? [campaign(CAMPAIGN, 'Staffed')] : [campaign(CAMPAIGN, 'Staffed'), campaign(OTHER_CAMPAIGN, 'Other')]);
    repos.session.findLiveForAgent.mockResolvedValue(null);
    repos.profiles.findByIdScoped.mockResolvedValue({ id: PROFILE, name: 'Sales summary' });
  });

  it('asks for running and paused campaigns, staffed unless supervising, capped after the filter', async () => {
    await get(`/softphone/bootstrap?actor_user_id=${AGENT}`);
    expect(repos.campaign.listSoftphoneTaggable).toHaveBeenLastCalledWith(TENANT, ACCOUNT, {
      statuses: ['running', 'paused'], staffedUserId: AGENT, limit: 500,
    });
    await get(`/softphone/bootstrap?actor_user_id=${AGENT}&supervise=true`);
    expect(repos.campaign.listSoftphoneTaggable).toHaveBeenLastCalledWith(TENANT, ACCOUNT, {
      statuses: ['running', 'paused'], staffedUserId: null, limit: 500,
    });
    expect(repos.campaign.list).not.toHaveBeenCalled();
  });

  it('call_campaign: the unsettled call\'s own campaign, even when it can no longer be tagged', async () => {
    repos.session.findLiveForAgent.mockResolvedValue({
      id: SESSION, tenant_id: TENANT, account_id: ACCOUNT, kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone', left_at: null,
    });
    runtime.agents.get.mockResolvedValue({ state: 'break' });
    runtime.breaks.peek.mockReturnValue(null as never);
    runtime.softphone.getLiveForSession.mockResolvedValue({ id: CALL, tag: { campaign_id: OTHER_CAMPAIGN, campaign_name: 'Done' } } as never);
    const done = { ...campaign(OTHER_CAMPAIGN, 'Done'), tenant_id: TENANT, account_id: ACCOUNT, status: 'completed',
      disposition_catalog: [{ code: 'sold', label: 'Sold' }] };
    repos.campaign.findById.mockResolvedValue(done);
    const boot = (await get(`/softphone/bootstrap?actor_user_id=${AGENT}`)).json();
    expect(boot.taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id)).toEqual([CAMPAIGN]);
    expect(boot.call_campaign).toMatchObject({
      campaign_id: OTHER_CAMPAIGN, status: 'completed', disposition_catalog: [{ code: 'sold', label: 'Sold' }],
    });
    // Another account's campaign is never described.
    repos.campaign.findById.mockResolvedValue({ ...done, account_id: 'another' });
    expect((await get(`/softphone/bootstrap?actor_user_id=${AGENT}`)).json().call_campaign).toBeNull();
    // An untagged call, or none: null.
    runtime.softphone.getLiveForSession.mockResolvedValue(null as never);
    expect((await get(`/softphone/bootstrap?actor_user_id=${AGENT}`)).json().call_campaign).toBeNull();
  });

  it('an agent gets their staffed campaigns; a supervisor every campaign of the account', async () => {
    const agent = (await get(`/softphone/bootstrap?actor_user_id=${AGENT}`)).json();
    expect(agent.taggable_campaigns.map((c: { campaign_id: string }) => c.campaign_id)).toEqual([CAMPAIGN]);
    expect(agent.taggable_campaigns[0]).toMatchObject({
      campaign_name: 'Staffed', caller_ids: ['+919000000001'], record_calls: true,
      analysis_profile: { id: PROFILE, name: 'Sales summary' }, calling_window: { timezone: 'UTC' },
    });
    expect(agent.taggable_campaigns[0].disposition_catalog.length).toBeGreaterThan(0); // the built-in for an empty catalog
    expect(agent).toMatchObject({
      untagged: { caller_ids: ['+919000000001', '+919000000002'], default_caller_id: '+919000000001', record_calls: false, analysis_profile: null },
      call_fields: [], default_country_code: expect.stringMatching(/^\+\d+$/), session: null, call: null,
    });
    const sup = (await get(`/softphone/bootstrap?actor_user_id=${AGENT}&supervise=true`)).json();
    expect(sup.taggable_campaigns).toHaveLength(2);
  });

  it('the settings\' default caller ID while still assigned; the live session with a queued switch', async () => {
    repos.settings.get.mockResolvedValue({
      disposition_catalog: [], call_fields: [], analysis_profile_id: null, record_calls: true, default_caller_id: '+919000000002', updated_at: null,
    });
    repos.session.findLiveForAgent.mockResolvedValue({
      id: SESSION, tenant_id: TENANT, account_id: ACCOUNT, kind: 'campaign', campaign_id: CAMPAIGN, state: 'available', break_reason: null, left_at: null,
    });
    repos.campaign.findById.mockResolvedValue({ id: CAMPAIGN, tenant_id: TENANT, name: 'Staffed' });
    runtime.agents.get.mockResolvedValue({ state: 'on_call' });
    runtime.breaks.peek.mockReturnValue({ code: 'soft_phone', label: 'Soft phone' } as never);
    const boot = (await get(`/softphone/bootstrap?actor_user_id=${AGENT}`)).json();
    expect(boot.untagged.default_caller_id).toBe('+919000000002');
    expect(boot.session).toEqual({
      session_id: SESSION, account_id: ACCOUNT, kind: 'campaign', campaign_id: CAMPAIGN, campaign_name: 'Staffed', state: 'on_call',
      break_reason: null, on_softphone: false, pending_state: 'break', pending_break_reason: 'soft_phone',
    });
    expect(runtime.softphone.getLiveForSession).toHaveBeenCalledWith(SESSION);
  });
});

describe('the switch routes', () => {
  beforeEach(() => {
    repos.session.findById.mockResolvedValue({
      id: SESSION, tenant_id: TENANT, account_id: ACCOUNT, agent_user_id: AGENT, campaign_id: CAMPAIGN, kind: 'campaign', left_at: null,
    });
  });

  it('take the session routes\' guard: another agent is the not-found 404, the runtime never runs', async () => {
    const res = await post(`/sessions/${SESSION}/softphone`, { agent_user_id: COLLEAGUE, on_behalf: true });
    expect(res.statusCode).toBe(404);
    expect(runtime.softphone.switchToSoftphone).not.toHaveBeenCalled();
  });

  it('start: the envelope with from-state and queued', async () => {
    runtime.softphone.switchToSoftphone.mockResolvedValue({
      ok: true, fromState: 'wrapup', campaignId: CAMPAIGN, queued: true, unchanged: true, response: { state: 'wrapup', pending_state: 'break' },
    });
    const res = await post(`/sessions/${SESSION}/softphone`, { agent_user_id: AGENT });
    expect(res.json()).toEqual({
      answer: { state: 'wrapup', pending_state: 'break' },
      audit: { campaign_id: CAMPAIGN, from_state: 'wrapup', queued: true, withdrawn: false, unchanged: true },
    });
    expect(runtime.softphone.switchToSoftphone).toHaveBeenCalledWith(SESSION, { tenantId: TENANT, accountId: ACCOUNT, userId: AGENT, supervise: false });
  });

  it('return: withdrawn when the session did not land on available; manual_call_live mapped', async () => {
    runtime.softphone.returnFromSoftphone.mockResolvedValue({
      ok: true, fromState: 'on_call', campaignId: CAMPAIGN, queued: false, response: { state: 'on_call' },
    });
    expect((await post(`/sessions/${SESSION}/softphone/return`, { agent_user_id: AGENT })).json().audit.withdrawn).toBe(true);
    runtime.softphone.returnFromSoftphone.mockResolvedValue({
      ok: true, fromState: 'break', campaignId: CAMPAIGN, queued: false, response: { state: 'available' },
    });
    expect((await post(`/sessions/${SESSION}/softphone/return`, { agent_user_id: AGENT })).json().audit.withdrawn).toBe(false);
    runtime.softphone.returnFromSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'manual_call_live', call: { id: CALL } } });
    const live = await post(`/sessions/${SESSION}/softphone/return`, { agent_user_id: AGENT });
    expect(live.statusCode).toBe(409);
    expect(live.json()).toMatchObject({ code: 'manual_call_live', call: { id: CALL } });
  });
});
