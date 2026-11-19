import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * Floor assist's public layer (`proxy-agency-floor-assist.routes.ts`, LF4, LF5, LF11): the REAL
 * `requirePermission` over the real role matrix, every other dependency faked through `deps`. The
 * guard order on each route (the permission, then the account scope, then the floor assist flag,
 * then the actor or the text), the flag-off refusal on all three before anything is read, the
 * actor taken from the session and never the body, the text trimmed and bounded, the sender's name,
 * and the internal handler's answer passed through. Ownership and account isolation are the internal
 * handler's, pinned end to end in `test/integration/agency/floor-assist-e2e.test.ts`.
 */

vi.mock('../../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../../src/api/middleware/tenant-context.middleware.js', () => ({ tenantContextMiddleware: async () => {} }));

import { proxyAgencyFloorAssistRoutes, type FloorAssistRouteDeps } from '../../../../src/api/routes/proxy-agency-floor-assist.routes.js';
import { SENDER_NAME_MAX_CHARS } from '../../../../src/agency/floor-assist.js';
import type { CoreCallRequest, CoreCallResult } from '../../../../src/api/core-dispatch.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const ME = '99999999-9999-4999-8999-999999999999';
const SESSION = '11111111-1111-4111-8111-111111111111';

const json = (status: number, body: unknown): CoreCallResult => ({ status, body, headers: new Headers({ 'content-type': 'application/json' }) });

let caller: { role: MembershipRole; accountId?: string | null };
let app: FastifyInstance;
let deps: FloorAssistRouteDeps & { calls: CoreCallRequest[]; answer: CoreCallResult };

beforeEach(async () => {
  caller = { role: 'agent' };
  const d = {
    calls: [] as CoreCallRequest[],
    answer: json(200, { session_id: SESSION, help: { raised_at: '2026-11-19T10:00:00.000Z', call_id: null } }),
    callCore: vi.fn(async (req: CoreCallRequest) => { d.calls.push(req); return d.answer; }),
    floorAssistEnabled: vi.fn(async () => true),
    names: vi.fn(async () => new Map<string, string | null>([[ME, 'Anitha N']])),
  };
  deps = d as never;
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = caller.accountId === null ? undefined : caller.accountId ?? ACCOUNT;
    r['user'] = { id: ME };
    r['membership'] = { role: caller.role, account_id: ACCOUNT, status: 'active' };
  });
  await app.register(proxyAgencyFloorAssistRoutes, { prefix: '/proxy/agency', deps });
  await app.ready();
});

afterEach(async () => { await app.close(); });

const raise = (body?: unknown) => app.inject({
  method: 'POST', url: `/proxy/agency/sessions/${SESSION}/help`,
  ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
});
const cancel = () => app.inject({ method: 'DELETE', url: `/proxy/agency/sessions/${SESSION}/help` });
const message = (body: unknown = { text: 'Offer the 3-month plan' }) =>
  app.inject({ method: 'POST', url: `/proxy/agency/sessions/${SESSION}/messages`, payload: body as Record<string, unknown> });

describe('Need help: POST and DELETE /sessions/:id/help', () => {
  it('agency.station.connect floors at agent, the lowest role, so every role may ask for its OWN session (the internal handler refuses anyone else\'s)', async () => {
    for (const role of ['agent', 'viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      caller = { role };
      expect((await raise()).statusCode, role).toBe(200);
      expect((await cancel()).statusCode, role).toBe(200);
    }
  });

  it('no membership in the tenant: refused by RBAC before anything is read', async () => {
    const bare = Fastify({ logger: false });
    bare.addHook('onRequest', async (request) => {
      const r = request as unknown as Record<string, unknown>;
      r['tenantId'] = TENANT;
      r['accountId'] = ACCOUNT;
      r['user'] = { id: ME };
    });
    await bare.register(proxyAgencyFloorAssistRoutes, { prefix: '/proxy/agency', deps });
    await bare.ready();
    try {
      for (const res of [
        await bare.inject({ method: 'POST', url: `/proxy/agency/sessions/${SESSION}/help` }),
        await bare.inject({ method: 'DELETE', url: `/proxy/agency/sessions/${SESSION}/help` }),
      ]) expect(res.statusCode).toBe(403);
      expect(deps.floorAssistEnabled).not.toHaveBeenCalled();
      expect(deps.calls).toEqual([]);
    } finally {
      await bare.close();
    }
  });

  it('raise: the actor is the session user, never the body; the internal handler is asked for the caller\'s own session', async () => {
    const res = await raise({ agent_user_id: 'someone-else', on_behalf: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session_id: SESSION, help: { raised_at: '2026-11-19T10:00:00.000Z', call_id: null } });
    expect(deps.calls).toEqual([{
      method: 'POST', path: `/agency/sessions/${SESSION}/help`, body: { agent_user_id: ME }, tenantId: TENANT, accountId: ACCOUNT,
    }]);
  });

  it('a supervisor\'s raise carries on_behalf as resolved (the internal handler\'s requireOwnedSession ignores it there)', async () => {
    caller = { role: 'account_admin' };
    await raise();
    expect(deps.calls[0]!.body).toEqual({ agent_user_id: ME, on_behalf: true });
  });

  it('cancel: the public DELETE is the internal POST /help/cancel, with the actor', async () => {
    deps.answer = json(200, { session_id: SESSION, help: null });
    const res = await cancel();
    expect([res.statusCode, res.json()]).toEqual([200, { session_id: SESSION, help: null }]);
    expect(deps.calls).toEqual([{
      method: 'POST', path: `/agency/sessions/${SESSION}/help/cancel`, body: { agent_user_id: ME }, tenantId: TENANT, accountId: ACCOUNT,
    }]);
  });

  it('passes the internal handler\'s refusals through (another agent\'s session 404, help_not_on_call, session_ended)', async () => {
    for (const answer of [
      json(404, { error: 'Not Found', message: 'Session not found' }),
      json(409, { error: 'Conflict', code: 'help_not_on_call', message: 'x' }),
      json(409, { error: 'Session Ended', code: 'session_ended', message: 'y' }),
    ]) {
      deps.answer = answer;
      const res = await raise();
      expect([res.statusCode, res.json()]).toEqual([answer.status, answer.body]);
    }
  });
});

describe('POST /sessions/:id/messages', () => {
  beforeEach(() => {
    caller = { role: 'account_admin' };
    deps.answer = json(201, { id: 'm-1', session_id: SESSION, sent_at: '2026-11-19T10:01:00.000Z', delivered: true });
  });

  it('agents and operators are refused by RBAC (agency.supervise); account admins and up may send', async () => {
    for (const role of ['agent', 'operator', 'viewer'] as MembershipRole[]) {
      caller = { role };
      const res = await message();
      expect(res.statusCode, role).toBe(403);
      expect(res.json().message).toMatch(/^Insufficient permissions/);
    }
    expect(deps.calls).toEqual([]);
    for (const role of ['account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[]) {
      caller = { role };
      expect((await message()).statusCode, role).toBe(201);
    }
  });

  it('sends the trimmed text, the sender and their name to the internal handler, the session in the body; answers 201', async () => {
    const res = await message({ text: '  Offer the 3-month plan, the waiver is approved.\n', sender_user_id: 'forged', from_name: 'Forged' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'm-1', session_id: SESSION, sent_at: '2026-11-19T10:01:00.000Z', delivered: true });
    expect(deps.names).toHaveBeenCalledWith([ME], TENANT);
    expect(deps.calls).toEqual([{
      method: 'POST', path: '/agency/supervisor-messages',
      body: { session_id: SESSION, text: 'Offer the 3-month plan, the waiver is approved.', sender_user_id: ME, from_name: 'Anitha N' },
      tenantId: TENANT, accountId: ACCOUNT,
    }]);
  });

  it('a sender with a very long name: cut for the frame, never a refusal', async () => {
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([[ME, 'N'.repeat(2_000)]]));
    expect((await message()).statusCode).toBe(201);
    const fromName = (deps.calls[0]!.body as Record<string, unknown>)['from_name'] as string;
    expect([...fromName]).toHaveLength(SENDER_NAME_MAX_CHARS);
  });

  it('a sender with no readable name is sent as null', async () => {
    (deps.names as ReturnType<typeof vi.fn>).mockResolvedValue(new Map());
    await message();
    expect((deps.calls[0]!.body as Record<string, unknown>)['from_name']).toBeNull();
  });

  it('400 message_invalid for a missing, empty, blank, too long or non-string text, or one with a NUL or another control character; nothing sent', async () => {
    for (const body of [{}, { text: '' }, { text: '   \n ' }, { text: 'x'.repeat(501) }, { text: 42 }, { text: ['a'] }, { text: 'a\u0000b' }, { text: 'a\u001bb' }]) {
      const res = await message(body);
      expect([res.statusCode, res.json().code], JSON.stringify(body)).toEqual([400, 'message_invalid']);
    }
    expect((await message({ text: 'x'.repeat(500) })).statusCode).toBe(201);
    expect(deps.calls).toHaveLength(1);
  });

  it('passes 409 agent_not_live and another account\'s 404 through', async () => {
    deps.answer = json(409, { error: 'Conflict', code: 'agent_not_live', message: 'x' });
    expect([(await message()).statusCode, (await message()).json().code]).toEqual([409, 'agent_not_live']);
    deps.answer = json(404, { error: 'Not Found', message: 'Session not found' });
    expect((await message()).statusCode).toBe(404);
  });
});

describe('the account scope and the flag, on all three routes', () => {
  const all = async () => {
    caller = { ...caller, role: 'account_admin' };
    return [await raise(), await cancel(), await message()];
  };

  it('no account: 400 account_scope_required, before the flag', async () => {
    caller = { role: 'account_admin', accountId: null };
    for (const res of await all()) expect([res.statusCode, res.json().code]).toEqual([400, 'account_scope_required']);
    expect(deps.floorAssistEnabled).not.toHaveBeenCalled();
    expect(deps.calls).toEqual([]);
  });

  it('the flag off: 403 floor_assist_disabled on every route, before the body is read, nothing forwarded', async () => {
    (deps.floorAssistEnabled as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    caller = { role: 'account_admin' };
    const res = [await raise(), await cancel(), await message({ text: '' })];
    for (const r of res) {
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({
        error: 'Forbidden', code: 'floor_assist_disabled', message: 'Need help and messages to agents are not turned on for this account.',
      });
    }
    expect(deps.floorAssistEnabled).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(deps.calls).toEqual([]);
    expect(deps.names).not.toHaveBeenCalled();
  });

  it('the flag unreadable fails closed (the request fails; nothing forwarded)', async () => {
    (deps.floorAssistEnabled as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('flag store down'));
    for (const r of await all()) expect(r.statusCode).toBe(500);
    expect(deps.calls).toEqual([]);
  });
});
