import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { buildApp } from '../../../src/app.js';

/**
 * The `errorHandler` (with the 22P02 → 400 backstop) and the 5xx error mask are registered
 * APP-WIDE (`app.ts`). This suite proves the wiring in the built app with GENUINE
 * Postgres errors from the test database (5436), thrown from a route registered in its own
 * encapsulated scope — the shape of every route plugin — so a plugin that forgot to inherit
 * either would leak:
 *  - **no SQL text and no driver text ever reaches a response body**: a failed statement's
 *    error (and an error that quotes its SQL, as a wrapping repository might) answers the
 *    masked 500 with the request id, nothing else;
 *  - a `22P02` (a malformed id reaching a `::uuid` cast) answers 400 `Invalid identifier`,
 *    never echoing the caller's value or the driver's message;
 *  - the probes keep their bodies (`MASK_EXEMPT_PATHS`).
 * Mutation-checked: dropping `app.addHook('onSend', errorMaskHook)` from `app.ts` reds the
 * first two cases; dropping `app.setErrorHandler(agencyErrorHandler)` reds the `22P02` case.
 */

const SECRET_SQL = 'SELECT secret_column_xyz FROM agency_calls WHERE tenant_id = $1';
let app: FastifyInstance;

async function genuinePgError(sql: string, params: unknown[] = []): Promise<Error & Record<string, unknown>> {
  try {
    await getTestPool().query(sql, params);
  } catch (err) {
    return err as Error & Record<string, unknown>;
  }
  throw new Error(`expected ${sql} to fail`);
}

beforeAll(async () => {
  const undefinedColumn = await genuinePgError(SECRET_SQL, ['00000000-0000-4000-8000-000000000001']);
  const invalidUuid = await genuinePgError('SELECT $1::uuid', ['not-a-uuid-caller-typo']);
  expect(undefinedColumn.code).toBe('42703');
  expect(invalidUuid.code).toBe('22P02');

  app = await buildApp({ ctx: null });
  // Its own encapsulated scope, as every route plugin is.
  await app.register(async (scope) => {
    scope.get('/__test/pg-500', async () => { throw undefinedColumn; });
    scope.get('/__test/sql-in-message', async () => {
      throw Object.assign(new Error(`query failed: ${SECRET_SQL}`), { code: '42703' });
    });
    scope.get('/__test/pg-22p02', async () => { throw invalidUuid; });
    scope.get('/__test/reply-500', async (_req, reply) =>
      reply.code(500).send({ error: 'Error', message: `driver said: ${SECRET_SQL}` }));
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeTestPool();
});

describe('errorHandler + error mask, app-wide (integration)', () => {
  it.each(['/__test/pg-500', '/__test/sql-in-message', '/__test/reply-500'])(
    'a 500 from %s carries no SQL and no driver text — masked body, request id only',
    async (url) => {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('secret_column_xyz');
      expect(res.body).not.toContain('SELECT');
      expect(res.body).not.toContain('agency_calls');
      expect(res.body).not.toMatch(/does not exist|42703/);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(['error', 'message', 'requestId', 'statusCode']);
      expect(body).toMatchObject({ error: 'Internal Error', statusCode: 500 });
      expect(body.message).toContain('quote the request ID');
      expect(res.headers['x-request-id']).toBe(body.requestId);
    },
  );

  it('a genuine 22P02 answers 400 Invalid identifier, echoing neither the value nor the driver', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test/pg-22p02' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'Bad Request', message: 'Invalid identifier', statusCode: 400 });
    expect(res.body).not.toContain('not-a-uuid-caller-typo');
    expect(res.body).not.toContain('invalid input syntax');
  });

  it('the readiness probe keeps its own 503 body (exempt from the mask)', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
  });
});
