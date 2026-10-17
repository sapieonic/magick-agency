import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseOr400, replyValidationFailed } from '../../../../../src/api/routes/helpers/parse-or-400.js';

/**
 * The three validation-400 shapes stay distinct (clients key off each), so each dialect is
 * pinned to its exact body here.
 */
const schema = z.object({ id: z.string().uuid() });

async function answer(handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) {
  const app = Fastify({ logger: false });
  app.post('/x', handler);
  await app.ready();
  const res = await app.inject({ method: 'POST', url: '/x', payload: { id: 'nope' } });
  await app.close();
  return res;
}

describe('parseOr400', () => {
  it('returns { data } and sends nothing for a valid value', async () => {
    const app = Fastify({ logger: false });
    app.post('/x', async (request, reply) => {
      const parsed = parseOr400(schema, request.body, reply, 'agency');
      if (!parsed) return reply;
      return { got: parsed.data.id };
    });
    const id = '00000000-0000-4000-8000-000000000001';
    const res = await app.inject({ method: 'POST', url: '/x', payload: { id } });
    expect(res.json()).toEqual({ got: id });
    await app.close();
  });

  it("'agency' answers { error: 'Validation Error', details: flatten() }", async () => {
    const res = await answer(async (request, reply) => {
      if (!parseOr400(schema, request.body, reply, 'agency')) return reply;
      return { ok: true };
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation Error',
      details: schema.safeParse({ id: 'nope' }).error!.flatten(),
    });
  });

  it("'platform' answers { error: 'Bad Request', details: issues }", async () => {
    const res = await answer(async (request, reply) => {
      if (!parseOr400(schema, request.body, reply, 'platform')) return reply;
      return { ok: true };
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Bad Request',
      details: JSON.parse(JSON.stringify(schema.safeParse({ id: 'nope' }).error!.issues)),
    });
  });
});

describe('replyValidationFailed', () => {
  it("answers the internal handlers' { error: 'Validation failed', details }", async () => {
    const res = await answer(async (_request, reply) => replyValidationFailed(reply, { id: 'must be a uuid' }));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Validation failed', details: { id: 'must be a uuid' } });
  });
});
