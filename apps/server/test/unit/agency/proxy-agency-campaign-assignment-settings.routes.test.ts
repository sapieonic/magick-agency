import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * Contact assignment on the public campaign write routes (decisions D9, D10):
 *
 *  - the `agency_contact_assignment_enabled` flag gates the SURFACE: create, PATCH and a
 *    retry's `config_overrides` that set an assignment setting to a non-default value, or
 *    carry an outcome `override`, are refused 403 `feature_disabled` while it is off, and
 *    nothing reaches the internal handler; the defaults sent explicitly pass without the
 *    flag being read;
 *  - a PATCH that CHANGES `assignment_mode` is audited (`agency_campaign.assignment_mode_changed`,
 *    `{ campaign_id, from, to }`) on success only; the handler's 409 passes through unchanged;
 *  - the retry create forwards `keep_assignments` as sent, and refuses a non-boolean.
 *
 * Only the I/O edges are doubles: `callCore` (the internal handler), the flag service and
 * the audit logger. The gate module and the routes are real.
 */

const TENANT = 'tenant-1';
const ACCOUNT = 'account-1';
const USER = '11111111-2222-4333-8444-555555555555';
const PREFIX = '/proxy/agency';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  flagEnabled: vi.fn(),
  findByTenantAndAccount: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/feature-flags/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/feature-flags/index.js')>()),
  getFeatureFlagService: () => ({ isEnabled: mocks.flagEnabled }),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({ requirePermission: () => async () => {} }));
vi.mock('../../../src/config/index.js', () => ({ config: { agency: { rosterReplaceEnabled: false } } }));
vi.mock('../../../src/storage/s3.js', () => ({ getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({ agencyIngestService: { run: vi.fn() } }));
// The behavioural-capability gate's settings read: recording and analytics on, so a 403
// here can only be the assignment gate.
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { findByTenantAndAccount: mocks.findByTenantAndAccount },
}));
// The actor's display name on the retry create (best effort, never refuses).
vi.mock('../../../src/api/routes/proxy-agency-campaigns/lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/routes/proxy-agency-campaigns/lifecycle.js')>()),
  resolveActorDisplayName: async () => null,
}));

import { FLAGS } from '../../../src/feature-flags/index.js';
import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: USER };
  });
  await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** The internal handler: answers by method, with `routes` overriding per call. */
function core(routes: Partial<Record<'GET' | 'POST' | 'PATCH', { status: number; body: unknown }>>): void {
  mocks.proxyToCore.mockImplementation(async (req: { method: 'GET' | 'POST' | 'PATCH' }) => {
    const answer = routes[req.method] ?? { status: 200, body: { id: 'c1' } };
    return { ...answer, headers: new Headers() };
  });
}

const DEFAULTS = {
  assignment_mode: 'pool', on_unstaff: 'return_to_pool', callback_owner_grace_minutes: 30,
  callback_fallback: 'pool', allow_agent_retry: false, agent_retry_rounds: 1, agent_retry_cooldown_minutes: 30,
};
const OVERRIDE_CATALOG = [{ code: 'promise_to_pay', label: 'Promise to pay', override: { retry_delay: true } }];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flagEnabled.mockResolvedValue(false);
  mocks.findByTenantAndAccount.mockResolvedValue({ allow_recording: true, analyze_calls: true });
  core({});
});

const surfaces = [
  { name: 'POST /campaigns', method: 'POST' as const, url: `${PREFIX}/campaigns` },
  { name: 'PATCH /campaigns/:id', method: 'PATCH' as const, url: `${PREFIX}/campaigns/c1` },
];

describe.each(surfaces)('$name — the contact-assignment flag gates the settings (D9)', (surface) => {
  it.each([
    ['assignment_mode', { assignment_mode: 'strict' }],
    ['on_unstaff', { on_unstaff: 'keep' }],
    ['callback_owner_grace_minutes', { callback_owner_grace_minutes: 5 }],
    ['callback_fallback', { callback_fallback: 'wait' }],
    ['allow_agent_retry', { allow_agent_retry: true }],
    ['agent_retry_rounds', { agent_retry_rounds: 2 }],
    ['agent_retry_cooldown_minutes', { agent_retry_cooldown_minutes: 0 }],
    ['disposition_catalog[0].override', { disposition_catalog: OVERRIDE_CATALOG }],
  ])('flag off: a non-default %s is 403 feature_disabled and nothing is forwarded', async (field, payload) => {
    const app = await buildApp();
    const res = await app.inject({ method: surface.method, url: surface.url, payload: { name: 'C', ...payload } });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: 'Feature Not Enabled', code: 'feature_disabled', details: { [field]: expect.any(String) } });
    expect(Object.keys(res.json().details)).toEqual([field]);
    expect(mocks.flagEnabled).toHaveBeenCalledWith(FLAGS.agency_contact_assignment_enabled, { tenantId: TENANT, accountId: ACCOUNT });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag off: every setting at its default passes, and the flag is not even read', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: surface.method, url: surface.url, payload: { name: 'C', ...DEFAULTS } });
    expect(res.statusCode, res.body).toBe(200);
    expect(mocks.flagEnabled).not.toHaveBeenCalled();
    expect(mocks.proxyToCore).toHaveBeenCalled();
    await app.close();
  });

  it('flag on: non-default settings and an override are forwarded', async () => {
    mocks.flagEnabled.mockResolvedValue(true);
    const app = await buildApp();
    const res = await app.inject({
      method: surface.method, url: surface.url,
      payload: { name: 'C', allow_agent_retry: true, disposition_catalog: OVERRIDE_CATALOG },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(mocks.proxyToCore.mock.calls.at(-1)![0].body).toMatchObject({ allow_agent_retry: true });
    await app.close();
  });

  it('a malformed value is the validator\'s 400, before the flag is read', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: surface.method, url: surface.url, payload: { name: 'C', assignment_mode: 'shared' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ assignment_mode: 'assignment_mode must be one of: pool, strict, preferred.' });
    expect(mocks.flagEnabled).not.toHaveBeenCalled();
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('PATCH /campaigns/:id — an assignment_mode change is audited, on success only (D10)', () => {
  beforeEach(() => mocks.flagEnabled.mockResolvedValue(true));

  it('a change writes one row with from and to, after the write succeeded', async () => {
    core({ GET: { status: 200, body: { id: 'c1', assignment_mode: 'pool' } }, PATCH: { status: 200, body: { id: 'c1', assignment_mode: 'strict' } } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { assignment_mode: 'strict' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ id: 'c1', assignment_mode: 'strict' });
    expect(mocks.proxyToCore.mock.calls.map(([req]) => `${req.method} ${req.path}`))
      .toEqual(['GET /agency-campaigns/c1', 'PATCH /agency-campaigns/c1']);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT, account_id: ACCOUNT, actor_type: 'human', user_id: USER,
      action: 'agency_campaign.assignment_mode_changed',
      resource_type: 'agency_campaign', resource_id: 'c1', campaign_id: 'c1',
      details: { campaign_id: 'c1', from: 'pool', to: 'strict' },
    });
    await app.close();
  });

  it('the handler\'s 409 mode_change_requires_pause passes through unchanged, and nothing is audited', async () => {
    const refusal = { error: 'Conflict', code: 'mode_change_requires_pause', message: 'Pause it first.' };
    core({ GET: { status: 200, body: { id: 'c1', assignment_mode: 'pool' } }, PATCH: { status: 409, body: refusal } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { assignment_mode: 'strict' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(refusal);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('sending the stored mode again is not a change: no row', async () => {
    core({ GET: { status: 200, body: { id: 'c1', assignment_mode: 'strict' } }, PATCH: { status: 200, body: { id: 'c1', assignment_mode: 'strict' } } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { assignment_mode: 'strict' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('a PATCH that does not name the mode makes no extra read and files no row', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { allow_agent_retry: true } });
    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    expect(mocks.proxyToCore.mock.calls[0]![0].method).toBe('PATCH');
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('the ownership probe\'s 404 is answered as is, and nothing is written', async () => {
    const missing = { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' };
    core({ GET: { status: 404, body: missing } });
    const app = await buildApp();
    const res = await app.inject({ method: 'PATCH', url: `${PREFIX}/campaigns/c1`, payload: { assignment_mode: 'strict' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(missing);
    expect(mocks.proxyToCore.mock.calls.map(([req]) => req.method)).toEqual(['GET']);
    await app.close();
  });
});

describe('POST /campaigns/:id/retry — keep_assignments and the flag on the overrides', () => {
  const PARENT = { id: 'c1', tenant_id: TENANT, account_id: ACCOUNT, record_calls: false, analysis_profile_id: null };
  const created = { status: 201, body: { campaign: { id: 'c2' }, idempotent_replay: false, contacts_seeded: 1 } };

  it('forwards keep_assignments as sent, and leaves it out when absent (the handler keeps by default)', async () => {
    core({ GET: { status: 200, body: PARENT }, POST: created });
    const app = await buildApp();
    for (const keep of [false, true, undefined]) {
      mocks.proxyToCore.mockClear();
      const res = await app.inject({
        method: 'POST', url: `${PREFIX}/campaigns/c1/retry`,
        payload: { selector: { state: ['pending'] }, ...(keep === undefined ? {} : { keep_assignments: keep }) },
      });
      expect(res.statusCode, res.body).toBe(201);
      const forwarded = mocks.proxyToCore.mock.calls.find(([req]) => req.method === 'POST')![0].body as Record<string, unknown>;
      if (keep === undefined) expect(forwarded).not.toHaveProperty('keep_assignments');
      else expect(forwarded['keep_assignments']).toBe(keep);
    }
    await app.close();
  });

  it('refuses a non-boolean keep_assignments with a 400, before any handler call', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `${PREFIX}/campaigns/c1/retry`, payload: { selector: {}, keep_assignments: 'no' },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag off: an override setting a non-default mode is 403 feature_disabled, before any handler call', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: `${PREFIX}/campaigns/c1/retry`,
      payload: { selector: { state: ['pending'] }, config_overrides: { assignment_mode: 'strict' } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'feature_disabled', details: { assignment_mode: expect.any(String) } });
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('flag off: overrides at their defaults, and no overrides at all, are not refused', async () => {
    core({ GET: { status: 200, body: PARENT }, POST: created });
    const app = await buildApp();
    for (const extra of [{ config_overrides: { assignment_mode: 'pool', allow_agent_retry: false } }, {}]) {
      const res = await app.inject({
        method: 'POST', url: `${PREFIX}/campaigns/c1/retry`, payload: { selector: { state: ['pending'] }, ...extra },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    expect(mocks.flagEnabled).not.toHaveBeenCalled();
    await app.close();
  });
});
