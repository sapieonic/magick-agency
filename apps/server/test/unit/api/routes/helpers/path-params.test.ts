import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { canonicalUuid, rejectPathEscapingParams, requireUuidPathParams } from '../../../../../src/api/routes/helpers/path-params.js';

/*
 * The plugin-level param hooks also canonicalise: a UUID-shaped param reaches the handler
 * lower-cased (the form Postgres returns), so every Redis key, in-process map and media
 * worker (`slotFor`) keyed by it matches the stored id. Anything else is left as sent.
 */
const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

async function echo(hook: ReturnType<typeof rejectPathEscapingParams>, url: string) {
  const app = Fastify();
  app.addHook('preHandler', hook);
  app.get('/sessions/:id/:other', async (request) => request.params);
  const res = await app.inject({ method: 'GET', url });
  await app.close();
  return { status: res.statusCode, params: res.json() as Record<string, string> };
}

describe('path-param hooks canonicalise UUIDs', () => {
  it('canonicalUuid lower-cases a UUID and nothing else', () => {
    expect(canonicalUuid(ID.toUpperCase())).toBe(ID);
    expect(canonicalUuid('Not-A-UUID')).toBe('Not-A-UUID');
  });

  it('rejectPathEscapingParams: an upper-case session id reaches the handler lower-cased; other params untouched', async () => {
    const { status, params } = await echo(rejectPathEscapingParams(), `/sessions/${ID.toUpperCase()}/Break`);
    expect(status).toBe(200);
    expect(params).toEqual({ id: ID, other: 'Break' });
  });

  it('requireUuidPathParams: accepts either case and passes the id on lower-cased', async () => {
    const other = '6EC0BD7F-11C0-43DA-975E-2A8AD9EBAE0B';
    const { status, params } = await echo(requireUuidPathParams(), `/sessions/${ID.toUpperCase()}/${other}`);
    expect(status).toBe(200);
    expect(params).toEqual({ id: ID, other: other.toLowerCase() });
  });
});
