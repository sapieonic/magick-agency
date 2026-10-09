import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from master
 * `test/unit/api/middleware/error-mask.integration.test.ts`@a1f0756a. Master's file proved the
 * log-context ALS seam (`enterLogContext` in `onRequest`, `recordCoreErrorStatus` in the
 * handler) reached the `onSend` mask. That seam fed only the core-forwarded 4xx branch, which
 * the lead ruled dropped (see the middleware's PORT NOTE), so:
 *  - the `onRequest` `enterLogContext` hook and every `recordCoreErrorStatus` call are gone;
 *    the logger mock targets `@magick-agency/observability`;
 *  - DELETED (5): "masks a forwarded bare core 4xx", "shows a forwarded core 4xx that carries
 *    field-level validation", "…carrying an allow-listed media code", "…core 403 for a disabled
 *    feature", "still masks a forwarded core 4xx whose code is not allow-listed" — each is the
 *    dropped branch;
 *  - MODIFIED (1): "exempts /ready…" → `/readyz`, agency's probe path (`MASK_EXEMPT_PATHS`);
 *  - kept (4 verbatim, the 5xx route keeps master's name and body): the 5xx mask, a route-own
 *    4xx, the suppressed-lookup 404, a success.
 */

const mocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.logger }));

import { errorMaskHook } from '../../../../src/api/middleware/error-mask.middleware.js';

function buildApp(): FastifyInstance {
  const app = Fastify();
  app.addHook('onSend', errorMaskHook);

  // Simulates a route that forwards a core 5xx.
  app.get('/core-5xx', async (_req, reply) => {
    return reply.code(503).send({ error: 'Bad Gateway', message: 'google ai quota exceeded' });
  });
  // Route-own business 4xx (no core call recorded) → shown.
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
  it('masks a forwarded core 5xx and hides the upstream message', async () => {
    const res = await app.inject({ method: 'GET', url: '/core-5xx' });
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

  it('does not mask a route-own 404 when the prior core lookup was suppressed', async () => {
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
