import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  callCore,
  setCoreHandlers,
  setCoreInjector,
  type CoreInjectArgs,
  type CoreInjectResult,
} from '../../../src/api/core-dispatch.js';

/*
 * `callCore`'s injector seam (docs/scaling.md §3.4). Without one, an internal request runs
 * on this process's instance exactly as `app.inject` always ran it. With one, the
 * injector receives the request `callCore` built (URL with query, the tenancy headers it
 * wrote, the JSON payload) and decides where it runs; its answer is decoded the same way.
 */
let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.post('/api/v1/agency/echo', async (req) => ({ headers: req.headers, body: req.body, query: req.query }));
  app.get('/api/v1/agency/text', async (_req, reply) => reply.type('text/plain').send('plain'));
  await app.ready();
  setCoreHandlers(app);
});
afterEach(() => setCoreInjector(null));
afterAll(async () => { setCoreHandlers(null); await app.close(); });

describe('callCore injector', () => {
  it('without an injector runs locally: JSON decoded, text kept as text', async () => {
    const res = await callCore({ method: 'POST', path: '/agency/echo', tenantId: 't1', accountId: 'a1', body: { x: 1 }, query: { q: '2' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ body: { x: 1 }, query: { q: '2' }, headers: { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' } });
    const text = await callCore({ method: 'GET', path: '/agency/text', tenantId: 't1' });
    expect(text.body).toBe('plain');
  });

  it('an injector sees what callCore built, may run it locally, and its answer is what the caller gets', async () => {
    const seen: CoreInjectArgs[] = [];
    setCoreInjector(async (args, local) => { seen.push(args); return local(args); });
    const res = await callCore({ method: 'POST', path: '/agency/echo', tenantId: 't1', body: { y: 2 }, headers: { 'x-mgkvc-tenant': 'forged' } });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{
      method: 'POST',
      url: '/api/v1/agency/echo',
      headers: { 'x-mgkvc-tenant': 't1', 'content-type': 'application/json' },
      payload: JSON.stringify({ y: 2 }),
    }]);
  });

  it('an answer from elsewhere is decoded like a local one', async () => {
    const remote: CoreInjectResult = {
      statusCode: 409,
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-extra': ['a', 'b'] },
      rawPayload: Buffer.from(JSON.stringify({ error: 'station_not_connected' })),
    };
    const local = vi.fn();
    setCoreInjector(async () => remote);
    const res = await callCore({ method: 'POST', path: '/agency/echo', tenantId: 't1' });
    expect(local).not.toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'station_not_connected' });
    expect(res.headers.get('x-extra')).toBe('a, b');
  });
});
