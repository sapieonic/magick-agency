import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): master `test/unit/agency/proxy-agency-agent-audit.test.ts`
 * @a1f0756a. Source 8 cases → ported 8.
 *
 * Harness changes, and only these:
 *  - `proxyToCore` → `callCore` (`src/api/core-dispatch.js`), mocked under master's
 *    `proxyToCore` name so every assertion stays master's; the `resolveCoreApiKey` mock and its
 *    `beforeEach` re-arm are gone with the key (the hop is in-process);
 *  - `auditLogger` → `platformAuditLogger` (`src/audit/platform/audit-logger.js`);
 *  - the logger mock is a partial over `@magick-agency/observability`;
 *  - the `require-capability` mock is gone with governance (plan §3.2).
 * DELETED: none. MODIFIED: none. NEW: none.
 */

/**
 * MAG-157: every new agency session/attempt audit row is asserted on payload.
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

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// PORT NOTE (magick-agency): master's `require-capability` mock is gone with governance.
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

describe('agency session and attempt audits (MAG-157)', () => {
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

  it('leave audits the session with campaign_id from core', async () => {
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

  it('hang-up audits the attempt with campaign_id from core', async () => {
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

  it('does not audit a failed hang-up', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 409, body: { code: 'attempt_not_live' } });
    const app = await buildApp();
    await app.inject({ method: 'POST', url: `${PREFIX}/attempts/${ATTEMPT}/hangup` });
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});
