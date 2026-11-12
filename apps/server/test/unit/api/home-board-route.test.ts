import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

/**
 * `GET /proxy/agency/home`'s guard chain and wiring (`api/routes/proxy-agency-insights/home.ts`,
 * decision B28a), by execution: the role floor is `agency.supervise` (the agent-reach suite only
 * proves an agent is refused, which `agency.campaigns.read` would do too), then the account scope,
 * then the dialer flag, then the board with the insights allocation's overdue counts.
 */

const mocks = vi.hoisted(() => ({
  computeHomeBoard: vi.fn(),
  dialerEnabled: vi.fn(),
  callbacksOverdueByCampaign: vi.fn(),
  liveStats: vi.fn(),
}));
vi.mock('../../../src/agency/home-board.js', () => ({ computeHomeBoard: mocks.computeHomeBoard }));
vi.mock('../../../src/api/routes/helpers/dialer-gate.js', () => ({ dialerEnabled: mocks.dialerEnabled }));
vi.mock('../../../src/agency/insights/allocation.js', () => ({ callbacksOverdueByCampaign: mocks.callbacksOverdueByCampaign }));
vi.mock('../../../src/api/routes/helpers/live-stats.js', () => ({ liveStats: mocks.liveStats }));

import { registerHomeBoardRoutes } from '../../../src/api/routes/proxy-agency-insights/home.js';

const BOARD = { campaigns: [], active_total: 0, any_campaign: false };

async function appFor(): Promise<FastifyInstance> {
  const app = Fastify();
  // What the session and tenant-context hooks leave on the request, from test headers.
  app.addHook('preHandler', async (request: FastifyRequest) => {
    const role = request.headers['x-role'] as string | undefined;
    request.tenantId = 't-1';
    request.accountId = request.headers['x-account-id'] as string | undefined;
    if (role) {
      request.membership = { role, tenant_id: 't-1', account_id: request.accountId ?? null, status: 'active' } as unknown as NonNullable<FastifyRequest['membership']>;
    }
  });
  await app.register(registerHomeBoardRoutes, { prefix: '/proxy/agency' });
  await app.ready();
  return app;
}

function get(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({ method: 'GET', url: '/proxy/agency/home', headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dialerEnabled.mockResolvedValue(true);
  mocks.computeHomeBoard.mockResolvedValue(BOARD);
});

describe('GET /proxy/agency/home', () => {
  it.each(['agent', 'viewer', 'operator'])('refuses a %s (below agency.supervise) and reads nothing', async (role) => {
    const app = await appFor();
    const res = await get(app, { 'x-role': role, 'x-account-id': 'a-1' });
    expect(res.statusCode).toBe(403);
    expect(mocks.dialerEnabled).not.toHaveBeenCalled();
    expect(mocks.computeHomeBoard).not.toHaveBeenCalled();
  });

  it.each(['account_admin', 'tenant_admin', 'tenant_owner'])('serves a %s the board for the request’s account', async (role) => {
    const app = await appFor();
    const res = await get(app, { 'x-role': role, 'x-account-id': 'a-1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(BOARD);
    expect(mocks.computeHomeBoard).toHaveBeenCalledWith({ tenantId: 't-1', accountId: 'a-1' }, expect.anything());
  });

  it('refuses a request with no account before the flag is read: 400 account_scope_required', async () => {
    const app = await appFor();
    const res = await get(app, { 'x-role': 'account_admin' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'account_scope_required' });
    expect(mocks.dialerEnabled).not.toHaveBeenCalled();
    expect(mocks.computeHomeBoard).not.toHaveBeenCalled();
  });

  it('answers the dialer gate’s refusal and reads nothing', async () => {
    mocks.dialerEnabled.mockImplementation(async (_req: FastifyRequest, reply: FastifyReply) => {
      await reply.code(403).send({ code: 'feature_disabled' });
      return false;
    });
    const app = await appFor();
    const res = await get(app, { 'x-role': 'account_admin', 'x-account-id': 'a-1' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ code: 'feature_disabled' });
    expect(mocks.computeHomeBoard).not.toHaveBeenCalled();
  });

  it('reads stats through the live-stats hop and overdue callbacks through the allocation’s count', async () => {
    const app = await appFor();
    await get(app, { 'x-role': 'account_admin', 'x-account-id': 'a-1' });
    const deps = mocks.computeHomeBoard.mock.calls[0]![1] as { liveStats: unknown; callbacksOverdue: unknown };
    expect(deps.liveStats).toBe(mocks.liveStats);
    expect(deps.callbacksOverdue).toBe(mocks.callbacksOverdueByCampaign);
  });
});
