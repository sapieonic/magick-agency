import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * Harness notes:
 *  - `callCore` (`src/api/core-dispatch.js`) is mocked as `mocks.proxyToCore`; the hop is
 *    in-process, so there is no API key to resolve;
 *  - the audit logger is `platformAuditLogger` (`src/audit/platform/audit-logger.js`);
 *  - the logger mock is a partial over `@magick-agency/observability`;
 *  - the route registers no capability gate.
 */

/**
 * Every new agency session/attempt audit row is asserted on payload.
 * A missing `auditLogger.log` call produces `[]`/`0` and would satisfy a count.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const CAMPAIGN = '00000000-0000-4000-8000-000000000001';
const SESSION = '33333333-3333-4333-8333-333333333333';
const ATTEMPT = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const SUPERVISOR = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', async (importOriginal) =>
  (await import('../../helpers/core-dispatch-double.js')).coreDispatchDouble(await importOriginal(), mocks.proxyToCore));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
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

import { proxyAgencyAgentRoutes } from '../../../src/api/routes/proxy-agency-agent.routes.js';

const PREFIX = '/proxy/agency';

async function buildApp(role: 'agent' | 'account_admin' = 'agent', userId = AGENT): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = ACCOUNT;
    r['user'] = { id: userId };
    r['membership'] = { role };
  });
  await app.register(proxyAgencyAgentRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: { campaign_id: CAMPAIGN } });
});

describe('agency session and attempt audits', () => {
  it('join audits the session against the campaign in the request', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { session_id: SESSION, campaign_id: CAMPAIGN },
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions`,
      payload: { campaign_id: CAMPAIGN },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_session.joined',
      resource_type: 'agency_session',
      resource_id: SESSION,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('leave audits the session with campaign_id from the internal handler', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/leave` });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_session.left',
      resource_type: 'agency_session',
      resource_id: SESSION,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('break audits the reason and campaign', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/${SESSION}/break`,
      payload: { reason: 'lunch' },
    });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_session.break_started',
      resource_type: 'agency_session',
      resource_id: SESSION,
      campaign_id: CAMPAIGN,
      details: { reason: 'lunch', campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('a device_away break that took effect is audited like any break', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { session_id: SESSION, campaign_id: CAMPAIGN, kind: 'campaign', state: 'break', since: 'x', break_reason: 'device_away' },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/break`, payload: { reason: 'device_away' } });
    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agency_session.break_started',
      resource_id: SESSION,
      details: { reason: 'device_away', campaign_id: CAMPAIGN },
    }));
    await app.close();
  });

  it('a device_away that changed nothing writes no row, and the client never sees the marker', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { session_id: SESSION, campaign_id: CAMPAIGN, kind: 'campaign', state: 'break', since: 'x', break_reason: 'lunch', break_unchanged: true },
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/break`, payload: { reason: 'device_away' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session_id: SESSION, campaign_id: CAMPAIGN, kind: 'campaign', state: 'break', since: 'x', break_reason: 'lunch' });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('break-cancel audits the session', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/break/cancel` });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_session.break_cancelled',
      resource_type: 'agency_session',
      resource_id: SESSION,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('force-available audits the supervisor, not the agent', async () => {
    const app = await buildApp('account_admin', SUPERVISOR);
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/${SESSION}/force-available`,
      payload: { reason: 'wrap-up stuck' },
    });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: SUPERVISOR,
      action: 'agency_session.force_available',
      resource_type: 'agency_session',
      resource_id: SESSION,
      campaign_id: CAMPAIGN,
      details: { reason: 'wrap-up stuck', campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('force-available that closed an owed inbound outcome audits it under the call (closed by a supervisor); the facts never reach the client', async () => {
    const CALL = '77777777-7777-4777-8777-777777777777';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { session_id: SESSION, campaign_id: CAMPAIGN, state: 'available', inbound_closed: { inbound_call_id: CALL, campaign_id: null } },
    });
    const app = await buildApp('account_admin', SUPERVISOR);
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/force-available`, payload: { reason: 'agent went home' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('inbound_closed');
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: SUPERVISOR,
      action: 'agency_inbound_call.closed',
      resource_type: 'agency_inbound_call',
      resource_id: CALL,
      details: { via: 'force_available', session_id: SESSION, reason: 'agent went home' },
    });
    // Audited even when the release that followed was refused: the close itself happened.
    mocks.auditLog.mockClear();
    mocks.proxyToCore.mockResolvedValue({
      status: 409,
      body: { error: 'Conflict', code: 'inbound_call_live', inbound_call_id: 'next', inbound_closed: { inbound_call_id: CALL, campaign_id: CAMPAIGN } },
    });
    const refused = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/force-available`, payload: {} });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).not.toHaveProperty('inbound_closed');
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'agency_inbound_call.closed', resource_id: CALL, campaign_id: CAMPAIGN,
    }));
    await app.close();
  });

  it('hang-up audits the attempt with campaign_id from the internal handler', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/attempts/${ATTEMPT}/hangup` });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_attempt.hung_up',
      resource_type: 'agency_attempt',
      resource_id: ATTEMPT,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('disposition keeps resource_id as the attempt and stamps campaign_id', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { attempt_id: ATTEMPT, campaign_id: CAMPAIGN, disposition_code: 'sale' },
    });
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/${ATTEMPT}/disposition`,
      payload: { disposition_code: 'sale' },
    });
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_disposition.created',
      resource_type: 'agency_disposition',
      resource_id: ATTEMPT,
      campaign_id: CAMPAIGN,
      details: { disposition_code: 'sale', campaign_id: CAMPAIGN },
    });
    await app.close();
  });

  it('a wrap-up redial audits the redialled attempt, with the session and the new attempt', async () => {
    const REDIAL = '77777777-7777-4777-8777-777777777777';
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { session_id: SESSION, attempt_id: REDIAL, redial_of_attempt_id: ATTEMPT, redial_number: 1, redial_remaining: 1 },
    });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/redial`, payload: { attempt_id: ATTEMPT } });
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      actor_type: 'human',
      user_id: AGENT,
      action: 'agency_attempt.redialed',
      resource_type: 'agency_attempt',
      resource_id: ATTEMPT,
      details: { session_id: SESSION, redial_attempt_id: REDIAL },
    });
    await app.close();
  });

  it('does not audit a refused wrap-up redial', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 409, body: { code: 'redial_limit_reached' } });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/sessions/${SESSION}/redial`, payload: { attempt_id: ATTEMPT } });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does not audit a failed hang-up', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 409, body: { code: 'attempt_not_live' } });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/attempts/${ATTEMPT}/hangup` });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
