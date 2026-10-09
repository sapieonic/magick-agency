import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * The `onSend` mask masks 5xx bodies and passes every 4xx through unchanged; there is no
 * forwarded-4xx branch, since everything runs in one process. The probe path exempted from
 * masking is `/readyz` (`MASK_EXEMPT_PATHS`).
 */

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.logger }));

import { errorMaskHook } from '../../../../src/api/middleware/error-mask.middleware.js';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.addHook('onSend', errorMaskHook);

  // Simulates a route that forwards an internal-handler 5xx.
  app.get('/handler-5xx', async (_req, reply) => {
    return reply.code(503).send({ error: 'Bad Gateway', message: 'google ai quota exceeded' });
  });
  // Route-own business 4xx → shown.
  app.get('/own-4xx', async (_req, reply) =>
    reply.code(402).send({ error: 'Payment Required', message: 'Insufficient credits' }));
  // Best-effort lookup did NOT record (recordCoreErrors:false), then own 404 → shown.
  app.get('/suppressed-then-own-404', async (_req, reply) =>
    reply.code(404).send({ error: 'Not Found', message: 'Contact list not found' }));
  // Ops probe 503 → exempt from masking.
  app.get('/readyz', async (_req, reply) =>
    reply.code(503).send({ status: 'not_ready', checks: { db: 'down' } }));
  // Success → untouched.
  app.get('/ok', async (_req, reply) => reply.code(200).send({ ok: true }));

  return app;
}

let app: FastifyInstance;
beforeEach(async () => {
  vi.clearAllMocks();
  app = buildApp();
  await app.ready();
});

const isMasked = (body: string) => JSON.parse(body).message?.includes('contact support and quote the request ID');

describe('error masking — Fastify enterWith → onSend seam', () => {
  it('masks a forwarded internal 5xx and hides the upstream message', async () => {
    const res = await app.inject({ method: 'GET', url: '/handler-5xx' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('google ai');
    expect(isMasked(res.body)).toBe(true);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Internal Error', statusCode: 503 });
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(JSON.parse(res.body).requestId).toBe(res.headers['x-request-id']);
  });

  it('shows a route-own business 4xx unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/own-4xx' });
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Payment Required', message: 'Insufficient credits' });
  });

  it('does not mask a route-own 404 when the prior internal lookup was suppressed', async () => {
    const res = await app.inject({ method: 'GET', url: '/suppressed-then-own-404' });
    expect(JSON.parse(res.body)).toMatchObject({ message: 'Contact list not found' });
  });

  it('exempts /readyz so its diagnostics survive', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ status: 'not_ready', checks: { db: 'down' } });
  });

  it('leaves success responses untouched', async () => {
    const res = await app.inject({ method: 'GET', url: '/ok' });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });
});
