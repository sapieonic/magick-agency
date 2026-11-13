import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ callCore: vi.fn() }));
vi.mock('../../../../src/api/core-dispatch.js', () => ({ callCore: core.callCore }));

const { proxyAgencyInboundRingRoutes, ringTokenRateKey } = await import('../../../../src/api/routes/proxy-agency-inbound-ring.routes.js');

/*
 * The token-only ring routes (Mode B, IQ71; `proxy-agency-inbound-ring.routes.ts`).
 *
 *  1. The one public route family that reads the agency runtime before `callCore` (docs/seams.md
 *     §4, "The token-only ring routes"): with no Bearer, no tenant header and no RBAC, the tenancy
 *     `callCore` needs is the connector's, by the call id (`ringTenancy`, which the plugin reads
 *     from `getAgencyRuntime()?.inbound`); a call it does not hold is the uniform 404 and never
 *     reaches the internal handler.
 *  2. Their rate-limit bucket: per IP and call for a call this process rings, so agents behind one
 *     carrier NAT never spend each other's answers; one per IP for any other id.
 */

const RINGING = '7d2b9e4f-6a1c-4e3d-8b5a-2f9c0e1d7a64';
const ringTenancy = vi.fn((id: string) => (id === RINGING ? { tenantId: 'tenant-1', accountId: 'account-1' } : null));

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(proxyAgencyInboundRingRoutes, { prefix: '/proxy/agency', ringTenancy });
  await app.ready();
});
afterAll(async () => { await app.close(); });
beforeEach(() => {
  core.callCore.mockReset();
  core.callCore.mockResolvedValue({ status: 200, body: { call_id: RINGING, accept_by: '2026-11-02T08:02:31.400Z' }, headers: new Headers() });
  ringTenancy.mockClear();
});

const post = (id: string, action: 'answering' | 'decline', body: unknown) =>
  app.inject({ method: 'POST', url: `/proxy/agency/inbound/calls/${id}/ring/${action}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('the token-only ring routes reach the runtime for their tenancy (the seam exception)', () => {
  it('asks the connector for the call\'s tenancy, then calls the internal handler on it: no Bearer, no tenant header', async () => {
    const res = await post(RINGING.toUpperCase(), 'answering', { offer_token: 'q0Vx3b9KcT1mN7zR2aW5yE' });
    expect(res.statusCode, res.body).toBe(200);
    expect(ringTenancy).toHaveBeenCalledWith(RINGING);
    expect(core.callCore).toHaveBeenCalledWith({
      method: 'POST', path: `/agency/inbound/calls/${RINGING}/ring/answering`,
      body: { offer_token: 'q0Vx3b9KcT1mN7zR2aW5yE' }, tenantId: 'tenant-1', accountId: 'account-1',
    });
  });

  it('a call the connector does not hold (or a malformed id) is the uniform 404, and never reaches the handler', async () => {
    for (const id of ['e5d4c3b2-0a9f-4e8d-9c7b-6a5f4e3d2c1b', 'not-a-call']) {
      for (const action of ['answering', 'decline'] as const) {
        const res = await post(id, action, { offer_token: 'q0Vx3b9KcT1mN7zR2aW5yE', reason: 'declined' });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ code: 'ring_not_offered' });
      }
    }
    expect(core.callCore).not.toHaveBeenCalled();
  });
});

describe('ringTokenRateKey', () => {
  const tenancy = (id: string) => (id === RINGING ? { tenantId: 't', accountId: 'a' } : null);

  it('a ringing call gets its own bucket per IP, whatever the id\'s case', () => {
    expect(ringTokenRateKey('10.0.0.1', RINGING, tenancy)).toBe(`ring:10.0.0.1:${RINGING}`);
    expect(ringTokenRateKey('10.0.0.1', RINGING.toUpperCase(), tenancy)).toBe(`ring:10.0.0.1:${RINGING}`);
    expect(ringTokenRateKey('10.0.0.2', RINGING, tenancy)).toBe(`ring:10.0.0.2:${RINGING}`);
  });

  it('every other id (unknown, malformed, missing) shares the IP\'s one bucket: the flood cap', () => {
    expect(ringTokenRateKey('10.0.0.1', 'e5d4c3b2-0a9f-4e8d-9c7b-6a5f4e3d2c1b', tenancy)).toBe('ring:10.0.0.1');
    expect(ringTokenRateKey('10.0.0.1', 'not-a-uuid', tenancy)).toBe('ring:10.0.0.1');
    expect(ringTokenRateKey('10.0.0.1', undefined, tenancy)).toBe('ring:10.0.0.1');
  });
});
