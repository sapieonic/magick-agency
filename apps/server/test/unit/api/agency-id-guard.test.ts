// The agency API's malformed-id guard (`agency-id-guard.ts`): a non-UUID id param is the family's
// not-found answer before any `uuid` cast; `rejectMalformedIdParamsByPrefix` is one hook for a
// scope whose families answer differently (the inbound scope's routes, Missed rows and calls).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { rejectMalformedIdParamsByPrefix } from '../../../src/api/agency-id-guard.js';

const ID = '6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5';
let app: FastifyInstance;

afterEach(async () => { await app?.close(); });

async function build(): Promise<FastifyInstance> {
  app = Fastify();
  app.addHook('preHandler', rejectMalformedIdParamsByPrefix({
    '/x/inbound/': { id: { status: 404, body: { code: 'family_not_found' } } },
    '/x/inbound/calls/': { id: { status: 404, body: { code: 'call_not_found' } } },
    '/x/inbound/missed/': { id: { status: 404, body: { code: 'missed_not_found' } }, other: { status: 400, body: { code: 'other_bad' } } },
  }));
  for (const url of ['/x/inbound/calls/:id', '/x/inbound/missed/:id/:other', '/x/inbound/routes/:id', '/y/things/:id']) {
    app.get(url, async () => ({ ok: true }));
  }
  await app.ready();
  return app;
}

describe('rejectMalformedIdParamsByPrefix', () => {
  it('each family`s own answer for a malformed id, the longest prefix winning', async () => {
    await build();
    expect((await app.inject(`/x/inbound/calls/nope`)).json()).toEqual({ code: 'call_not_found' });
    expect((await app.inject(`/x/inbound/missed/nope/${ID}`)).json()).toEqual({ code: 'missed_not_found' });
    expect((await app.inject(`/x/inbound/missed/${ID}/nope`)).json()).toEqual({ code: 'other_bad' });
    expect((await app.inject(`/x/inbound/routes/nope`)).json()).toEqual({ code: 'family_not_found' });
  });

  it('a well-formed id, or a route under none of the prefixes, goes on to its handler', async () => {
    await build();
    expect((await app.inject(`/x/inbound/calls/${ID}`)).json()).toEqual({ ok: true });
    expect((await app.inject(`/x/inbound/missed/${ID}/${ID}`)).json()).toEqual({ ok: true });
    expect((await app.inject(`/y/things/nope`)).json()).toEqual({ ok: true });
  });
});
