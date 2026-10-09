import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { MembershipRole } from '@magick-agency/contracts/rbac';
import { hasPermission } from '@magick-agency/contracts/rbac';

/*
 * Harness notes:
 *  - `callCore` (`src/api/core-dispatch.js`) is mocked as `mocks.proxyToCore`; the hop is
 *    in-process, so there is no API key to resolve;
 *  - the audit logger is `platformAuditLogger` (`src/audit/platform/audit-logger.js`);
 *  - the logger mock is a partial over `@magick-agency/observability`;
 *  - the route registers no capability gate;
 *  - platform API keys do not exist in this app, so no request here carries an API-key
 *    caller: a creator-backed shape (a user AND a membership) is just a signed-in person,
 *    whom `resolveAgencyActor` attributes; its no-user `missing_actor` arm is pinned in
 *    `agency-actor.test.ts`.
 *
 * decision Q8: "proxies for a supervisor, body and metric template intact" —
 *  the body also carries the supervisor's actor (`agent_user_id`, `on_behalf`), which the
 *  internal handler's `requireOwnedSession` needs to let a supervisor act on another
 *  agent's session. Every session route forwards the authenticated actor (6-row
 *  `it.each`), and a client-supplied actor on `break` is overwritten.
 */

/**
 * The disposition and notes proxies, and specifically the actor
 * attribution that makes them enforceable.
 *
 * The interesting property is a **split** one: "is the reserved agent" is a fact
 * only the internal handler holds, "supervises" is a fact only the public API layer holds, and the rule needs
 * both. So these tests assert exactly the public API layer's half — that it attributes every
 * action to the authenticated user, never to a client-supplied id, and asserts
 * `on_behalf` from RBAC and nothing else. Whether the internal handler then *allows* the action
 * is the internal handler's test (its own suite); what the public API layer must never do is let the internal handler decide
 * against a body the public API layer did not author.
 *
 * RBAC is deliberately NOT stubbed here (unlike the sibling campaign-route
 * suite): the operator-vs-account_admin distinction is the thing under test.
 */

const TENANT = 'tenant-1';
const AGENT_USER = 'user-agent-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// The station-token route imports this for its URL rewrite; irrelevant here.
vi.mock('../../../src/api/routes/proxy-agency-station.routes.js', () => ({
  rewriteStationWsUrl: (u: string) => u,
}));

import { proxyAgencyAgentRoutes } from '../../../src/api/routes/proxy-agency-agent.routes.js';

const PREFIX = '/proxy/agency';

interface Caller {
  role?: MembershipRole;
  userId?: string | null;
  // No API-key caller shapes: platform API keys do not exist in this app.
}

async function buildApp(caller: Caller = { role: 'agent' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Via `unknown`: `FastifyRequest` and `Record<string, unknown>` do not
    // sufficiently overlap, so the direct assertion is a `lint:test` error
    // (TS2352) that `npm run lint` cannot see — it typechecks `src/` only.
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = 'account-1';
    r['user'] = { id: caller.userId === undefined ? AGENT_USER : caller.userId };
    r['membership'] = { role: caller.role ?? 'agent' };
  });
  await app.register(proxyAgencyAgentRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

/** The body the public API layer actually sent to the internal handler on the single proxied call. */
function sentBody(): Record<string, unknown> {
  expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
  return mocks.proxyToCore.mock.calls[0]![0].body as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: { attempt_id: 'attempt-1' } });
});

describe('session create — who is joining', () => {
  const CAMPAIGN = '00000000-0000-4000-8000-000000000001';

  /**
   * ── Why this group exists ─────────────────────────────────────────────────
   * The internal handler's `POST /agency/sessions` hard-requires `agent_user_id`. If the public
   * API layer's `createSessionSchema` named only `campaign_id`/`session_id`, Zod would strip the
   * unknown key and the handler would forward `parsed.data` — so **every join would 400
   * and no agent could reach a campaign.**
   *
   * Nothing else would observe it. The route-table suite asserts routing and guards but not
   * bodies, and the internal handler's own tests supply the field themselves. Both layers
   * would be internally consistent and together describe a system that could not work — so
   * the pin has to be on the **body the public API layer sends**, which is the only artefact
   * both sides share.
   */
  it('sends the authenticated user as agent_user_id', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST', url: `${PREFIX}/sessions`, payload: { campaign_id: CAMPAIGN },
    });

    expect(res.statusCode).toBe(200);
    expect(sentBody()).toEqual({ campaign_id: CAMPAIGN, agent_user_id: AGENT_USER });
    await app.close();
  });

  it('never lets the browser name the agent', async () => {
    // A client-asserted id would let anyone go available as a colleague — and
    // then take their calls. Zod strips the unknown key and the public API layer overwrites
    // from the session, so the claim cannot survive either way.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST', url: `${PREFIX}/sessions`,
      payload: { campaign_id: CAMPAIGN, agent_user_id: 'user-someone-else' },
    });

    expect(sentBody()['agent_user_id']).toBe(AGENT_USER);
    await app.close();
  });

  it('does not send on_behalf, even for a supervisor', async () => {
    // `on_behalf` answers "may this user act on an attempt they did not take".
    // Joining has no such question — a supervisor cannot go available as someone
    // else — so the field would have no rule to feed. Only `agent_user_id` is
    // threaded here, unlike the disposition and notes handlers which spread the
    // whole actor.
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    await app.inject({
      method: 'POST', url: `${PREFIX}/sessions`, payload: { campaign_id: CAMPAIGN },
    });

    expect(sentBody()).toEqual({ campaign_id: CAMPAIGN, agent_user_id: 'user-supervisor' });
    await app.close();
  });



});

describe('disposition — actor attribution', () => {
  it('attributes the action to the authenticated user', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(res.statusCode).toBe(200);
    expect(sentBody()).toEqual({ disposition_code: 'sale', agent_user_id: AGENT_USER });
    await app.close();
  });

  it('does NOT set on_behalf for an agent — the whole point of the D6 floor', async () => {
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });
    expect(sentBody()['on_behalf']).toBeUndefined();
    await app.close();
  });

  it('sets on_behalf for a role holding agency.supervise (account_admin)', async () => {
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(sentBody()).toMatchObject({ agent_user_id: 'user-supervisor', on_behalf: true });
    await app.close();
  });

  it('does NOT set on_behalf for an operator', async () => {
    // `agency.supervise` floors at `account_admin` (30); an operator is 20.
    // An operator might be expected to be able to act on an agent's behalf, but
    // `on_behalf` is an `account_admin` capability by design, in the internal handler's
    // contract and in the UX. This test pins the
    // ratified floor; if the floor is ever deliberately lowered, this is the
    // test that should be made to fail on purpose.
    const app = await buildApp({ role: 'operator', userId: 'user-operator' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(sentBody()).toEqual({ disposition_code: 'sale', agent_user_id: 'user-operator' });
    await app.close();
  });

  it('ignores a client-supplied agent_user_id and on_behalf', async () => {
    // The attack this closes: an `agent` filing a disposition — a permanent
    // record of what a customer said — under a colleague's name, or asserting
    // the supervisory flag their role does not carry.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: {
        disposition_code: 'sale',
        agent_user_id: 'someone-elses-user-id',
        on_behalf: true,
      },
    });

    expect(sentBody()).toEqual({ disposition_code: 'sale', agent_user_id: AGENT_USER });
    await app.close();
  });



  it('surfaces the internal handler validation errors — status, code and allowed_codes — intact', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 400,
      body: {
        error: 'Validation failed',
        code: 'unknown_disposition_code',
        message: "'sale' is not in this campaign's catalog",
        allowed_codes: ['interested', 'callback', 'voicemail'],
      },
    });

    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'Validation failed',
      code: 'unknown_disposition_code',
      message: "'sale' is not in this campaign's catalog",
      allowed_codes: ['interested', 'callback', 'voicemail'],
    });
    await app.close();
  });

  it('surfaces the internal handler 403 not_your_attempt rather than flattening it', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 403,
      body: { error: 'Forbidden', code: 'not_your_attempt', message: 'Not your attempt' },
    });

    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_your_attempt');
    await app.close();
  });
});

describe('disposition — platform audit trail', () => {
  it('audits the disposition on a 2xx from the internal handler, without the free-text notes', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale', notes: 'customer said the quiet part out loud' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: AGENT_USER,
      action: 'agency_disposition.created',
      resource_type: 'agency_disposition',
      resource_id: 'attempt-1',
      details: { disposition_code: 'sale' },
    });
    // Notes are free text an agent typed and must never reach the audit row.
    const details = mocks.auditLog.mock.calls[0]![0].details as Record<string, unknown>;
    expect(JSON.stringify(details)).not.toContain('quiet part');
    await app.close();
  });

  it('records on_behalf when a supervisor files on the agent\'s behalf', async () => {
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-supervisor',
        details: { disposition_code: 'sale', on_behalf: true },
      }),
    );
    await app.close();
  });

  it('does NOT audit a disposition the internal handler rejected (4xx)', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 400,
      body: { error: 'Validation failed', code: 'unknown_disposition_code', message: 'bad code' },
    });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT audit a disposition the internal handler failed on (5xx)', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 500, body: { error: 'Internal' } });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/disposition`,
      payload: { disposition_code: 'sale' },
    });

    expect(res.statusCode).toBe(500);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('disposition — where "another agent cannot" is actually enforced', () => {
  /**
   * Worth stating because it is easy to assume otherwise: the public API layer's RBAC cannot
   * express acceptance (b). `agency.attempts.dispose` floors at `agent` (5), and
   * the hierarchy is linear over *minimum* roles, so **every** role at or above
   * `agent` — viewer included — holds it. That is deliberate (D6: supervisors
   * and admins can take calls themselves to cover or demo).
   *
   * So "another agent cannot disposition this attempt" is not a permission
   * question at all. It is the internal handler's ownership check, and the public API layer's only job is to
   * (1) attribute truthfully so the internal handler can make it, and (2) not flatten the answer.
   * Both are asserted above.
   */
  it.each(['agent', 'viewer', 'operator', 'account_admin'] as MembershipRole[])(
    'lets %s through to the internal handler — the ownership check is the internal handler\'s, not the matrix\'s',
    async (role) => {
      const app = await buildApp({ role, userId: `user-${role}` });
      const res = await app.inject({
        method: 'POST',
        url: `${PREFIX}/attempts/attempt-1/disposition`,
        payload: { disposition_code: 'sale' },
      });

      expect(res.statusCode).toBe(200);
      expect(sentBody()['agent_user_id']).toBe(`user-${role}`);
      await app.close();
    },
  );
});

describe('force-available — the override an agent must not hold', () => {
  /**
   * An earlier change made `POST /sessions/:id/available` refuse while a disposition
   * is outstanding, and that refusal is the only thing making a required
   * disposition required. `force-available` is the override, so the floor on it
   * is load-bearing: an `agent` who could call it would skip every disposition
   * while the feature still looked like it worked.
   *
   * Asserted against the matrix rather than by reading the route, because the
   * failure mode is silent — a wrong floor produces a working-looking console
   * and a campaign whose dispositions are quietly optional.
   */
  it('is unreachable by an agent at the permission-matrix level', () => {
    expect(hasPermission('agent', 'agency.supervise')).toBe(false);
    // And specifically not by the roles that CAN do everything else an agent does.
    expect(hasPermission('agent', 'agency.attempts.dispose')).toBe(true);
  });

  it('is reachable by account_admin and above, and nothing below', () => {
    const reach = (['agent', 'viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[])
      .filter((r) => hasPermission(r, 'agency.supervise'));
    expect(reach).toEqual(['account_admin', 'tenant_admin', 'tenant_owner']);
  });

  it('403s an agent at the route, and never reaches the internal handler', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/force-available`,
      payload: { reason: 'stuck' },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s an operator — the same floor the disposition on-behalf flag uses', async () => {
    const app = await buildApp({ role: 'operator' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/force-available`,
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('proxies for a supervisor, body and metric template intact', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { state: 'available' } });
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/force-available`,
      payload: { reason: 'agent left their desk' },
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.path).toBe('/agency/sessions/session-1/force-available');
    // decision Q8: the supervisor's actor rides with the reason, so the internal handler can let
    // `agency.supervise` act on another agent's session on this route (and only this one).
    expect(call.body).toEqual({ reason: 'agent left their desk', agent_user_id: 'user-supervisor', on_behalf: true });
    expect(call.metricPath).toBe('/agency/sessions/:id/force-available');
    await app.close();
  });

  it('accepts an absent body — the reason is optional', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { state: 'available' } });
    const app = await buildApp({ role: 'account_admin' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/force-available`,
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('break/cancel — the queued-break take-back', () => {
  it('proxies at the agent floor, since it is the agent\'s own presence', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { pending_state: null } });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/break/cancel`,
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.path).toBe('/agency/sessions/session-1/break/cancel');
    expect(call.metricPath).toBe('/agency/sessions/:id/break/cancel');
    await app.close();
  });

  it('surfaces the internal handler 409 break_already_applied intact', async () => {
    // The console's whole remedy depends on this code: "your break already
    // started — go available when you're ready" versus a red support message.
    mocks.proxyToCore.mockResolvedValue({
      status: 409,
      body: { error: 'Conflict', code: 'break_already_applied', message: 'Break already in effect' },
    });

    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/sessions/session-1/break/cancel`,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('break_already_applied');
    await app.close();
  });
});

describe('notes', () => {
  it('proxies to the internal handler /notes with the actor attached', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { attempt_id: 'attempt-1', notes: 'asked to call back', updated_at: '2026-08-11T00:00:00.000Z' },
    });

    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/notes`,
      payload: { notes: 'asked to call back' },
    });

    expect(res.statusCode).toBe(200);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/agency/attempts/attempt-1/notes');
    expect(call.body).toEqual({ notes: 'asked to call back', agent_user_id: AGENT_USER });
    await app.close();
  });

  it('accepts an empty string — that is how an agent clears their notes', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/notes`,
      payload: { notes: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(sentBody()['notes']).toBe('');
    await app.close();
  });

  it('uses a distinct metric path template from disposition', async () => {
    // Both routes are `/attempts/:id/…`; sharing a template would merge two
    // different operations into one meaningless series.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/notes`,
      payload: { notes: 'x' },
    });
    expect(mocks.proxyToCore.mock.calls[0]![0].metricPath).toBe('/agency/attempts/:id/notes');
    await app.close();
  });

  it('rejects an over-long note before spending a proxy round trip', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/notes`,
      payload: { notes: 'x'.repeat(4001) },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('ignores a client-supplied actor here too', async () => {
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/notes`,
      payload: { notes: 'x', agent_user_id: 'someone-else', on_behalf: true },
    });

    expect(sentBody()).toEqual({ notes: 'x', agent_user_id: AGENT_USER });
    await app.close();
  });

  it('is reachable by an agent — the floor that matters, since nothing above is excluded', async () => {
    const agentApp = await buildApp({ role: 'agent' });
    expect(
      (await agentApp.inject({
        method: 'POST',
        url: `${PREFIX}/attempts/attempt-1/notes`,
        payload: { notes: 'x' },
      })).statusCode,
    ).toBe(200);
    await agentApp.close();
  });



});

describe('mark-DNC — proxying and attribution', () => {
  /**
   * This route had zero behavioural coverage before the actor attribution was added — its only
   * reference was a route-table registration test run under a wide-open RBAC
   * stub (`proxy-agency-route-table.test.ts`), which proves the router matches
   * the path and nothing about what the handler does with a request. These
   * tests close that gap for the ordinary proxying behaviour; the case that
   * matters most is the last one below.
   */

  it('proxies to the internal handler with the validated body, and returns the internal handler\'s status/body unchanged', async () => {
    const app = await buildApp({ role: 'agent' });
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { attempt_id: 'attempt-1', contact_id: 'contact-1', phone_e164: '+15551230001', contact_state: 'suppressed', dnc_recorded: true },
    });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dnc_recorded: true });
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    const call = mocks.proxyToCore.mock.calls[0]![0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/agency/attempts/attempt-1/dnc');
    await app.close();
  });

  it('accepts an absent body — both fields are optional', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });

    expect(res.statusCode).toBe(200);
    // The actor is the public API layer's and is always sent; both *caller* fields
    // are optional, which is what this case is about.
    expect(sentBody()).toEqual({ agent_user_id: AGENT_USER });
    await app.close();
  });

  it('forwards reason and disposition_code, and strips anything else', async () => {
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'asked not to be called', disposition_code: 'do_not_call', extra: 'dropped' },
    });

    // Exhaustive on purpose: `extra` must not survive, and neither must anything
    // else this route was not asked to send. The actor is the one addition, and
    // it is the public API layer's own rather than a forwarded caller field.
    expect(sentBody()).toEqual({
      reason: 'asked not to be called',
      disposition_code: 'do_not_call',
      agent_user_id: AGENT_USER,
    });
    await app.close();
  });

  it('rejects an over-long reason before spending a proxy round trip', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'x'.repeat(1001) },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('reachable by a plain agent — `agency.dnc.write` floors at agent, not above it', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('attributes the suppression to the authenticated agent', async () => {
    /**
     * ── This case used to assert the OPPOSITE, on purpose ────────────────────
     *
     * It pinned `'agent_user_id' in body === false` — the true, attribution-less
     * state at the time — so that `dnc_entries.added_by` landing NULL on every
     * agent-marked suppression was mechanically visible rather than resting on a
     * comment, and so that the day it was fixed would be a **test failure here
     * rather than a silent change**. That is what happened; this is the update
     * it was written to force, not a rewrite that made an inconvenient test pass.
     *
     * The blocker was real and is gone: the internal handler's `AgencyDncRequest` carried no
     * field for an actor to land in, so sending one would have been inventing a
     * name the contract did not declare. It now
     * `extends AgencyActorFields`.
     */
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked' },
    });

    const body = sentBody();
    expect(body['agent_user_id']).toBe(AGENT_USER);
    // The caller's own fields survive alongside the actor — a spread that
    // clobbered them would still satisfy the assertion above.
    expect(body['reason']).toBe('customer asked');
    // An ordinary agent does not supervise, so `on_behalf` is omitted rather
    // than sent as `false`: the internal handler's rule branches on presence.
    expect('on_behalf' in body).toBe(false);
    await app.close();
  });

  it('never takes the actor from the browser', async () => {
    // The security half, and the reason this is the public API layer's fact rather than a
    // client's: a browser that could name the agent could file a suppression —
    // a compliance record — under a colleague's id.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked', agent_user_id: 'somebody-else' },
    });

    expect(sentBody()['agent_user_id']).toBe(AGENT_USER);
    await app.close();
  });

  it('forwards a campaign scope through to the internal handler', async () => {
    // The pin on the strip. `dncSchema` declared only `reason` and
    // `disposition_code`, so Zod deleted `scope` and this route answered 200
    // having asked the internal handler for no scope at all. Assert the field ARRIVES, because
    // the failure mode is a field that silently does not.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked', scope: 'campaign' },
    });

    expect(sentBody()).toEqual({
      reason: 'customer asked',
      scope: 'campaign',
      agent_user_id: AGENT_USER,
    });
    await app.close();
  });

  it('forwards absent scope as absent rather than defaulting it here', async () => {
    // "Absent means campaign" is the internal handler's default to apply, not the public API layer's to
    // materialise. The public API layer normalising it would put a second copy of the default
    // in a second repo, and the two would drift without either side erroring.
    const app = await buildApp({ role: 'agent' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked' },
    });

    expect('scope' in sentBody()).toBe(false);
    await app.close();
  });

  it('rejects a scope outside the enum before spending a proxy round trip', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { scope: 'account' },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('mark-DNC — the tenant-wide escalation needs `agency.dnc.manage`', () => {
  /**
   * `scope: 'tenant'` suppresses a number across every campaign in the
   * workspace and an agent cannot undo it, so it carries a second floor above
   * the route's own `agency.dnc.write` (`agent`): `agency.dnc.manage`
   * (`account_admin`), the same floor `DELETE /dnc/:id` uses.
   *
   * These assert the public API layer's enforcement specifically, because the console also
   * hides the escalation behind this permission — and a hidden button proves
   * nothing about a crafted request. The interesting cases are therefore the
   * ones where the caller holds `agency.dnc.write` and sends `'tenant'`
   * anyway, which is precisely what a browser can do by hand.
   */

  it('403s an agent escalating to tenant scope, and never reaches the internal handler', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'never call again', scope: 'tenant' },
    });

    expect(res.statusCode).toBe(403);
    // Nothing was written anywhere: the refusal precedes the proxy call, which
    // is also what keeps the error mask from flattening it (a route's own 4xx
    // must land before any internal handler call records a status).
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('403s an operator too — the floor is account_admin, not "above agent"', async () => {
    // `operator` (20) holds `agency.dnc.write` by inheritance and would sail
    // through a naive "is this caller more than an agent" check.
    const app = await buildApp({ role: 'operator', userId: 'user-operator' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { scope: 'tenant' },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('lets an account_admin escalate, and forwards the scope intact', async () => {
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'never call again', scope: 'tenant' },
    });

    expect(res.statusCode).toBe(200);
    expect(sentBody()).toEqual({
      reason: 'never call again',
      scope: 'tenant',
      agent_user_id: 'user-supervisor',
      on_behalf: true,
    });
    await app.close();
  });

  it('does not gate the campaign arm — the same agent, one word different', async () => {
    // The pair that shows the gate keys off the SCOPE and not off the role: the
    // identical caller is refused above and allowed here.
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked', scope: 'campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not gate an absent scope — an old console must not need account_admin', async () => {
    // Absent means campaign, so a client that predates the field keeps working
    // at the agent floor. If absent were ever read as tenant-wide, this would
    // be the test that goes red.
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('matches the floor `DELETE /dnc/:id` uses, at the matrix level', () => {
    // Pinned against the matrix rather than the route, so a change to the floor
    // is a deliberate edit here and not a silent widening of who can suppress a
    // number tenant-wide.
    const reach = (['agent', 'viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner'] as MembershipRole[])
      .filter((r) => hasPermission(r, 'agency.dnc.manage'));
    expect(reach).toEqual(['account_admin', 'tenant_admin', 'tenant_owner']);
    // And the ordinary arm stays reachable by an agent — the two floors on this
    // one route are genuinely different, which is the whole design.
    expect(hasPermission('agent', 'agency.dnc.write')).toBe(true);
    expect(hasPermission('agent', 'agency.dnc.manage')).toBe(false);
  });
});

describe('mark-DNC — attribution, continued', () => {
  it('marks on_behalf for a supervisor suppressing on an agent\'s attempt', async () => {
    // A plain mark-DNC has no ownership rule at the internal handler, so `on_behalf` changes
    // nothing there today. It is still sent, because the compliance record
    // should say whether the person who suppressed the number was acting for
    // someone else — and because a rule added later must not find the field
    // missing on the one route that skipped it.
    const app = await buildApp({ role: 'account_admin' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked' },
    });

    expect(sentBody()['on_behalf']).toBe(true);
    await app.close();
  });
});

describe('mark-DNC — platform audit trail', () => {
  it('audits the suppression on a 2xx from the internal handler, with scope but NO phone number', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: {
        attempt_id: 'attempt-1',
        contact_id: 'contact-1',
        phone_e164: '+15551230001',
        contact_state: 'suppressed',
        dnc_recorded: true,
        entry_id: 'entry-9',
      },
    });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'customer asked', scope: 'campaign' },
    });

    expect(res.statusCode).toBe(200);
    expect(mocks.auditLog).toHaveBeenCalledTimes(1);
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: AGENT_USER,
      action: 'dnc_entry.created',
      resource_type: 'dnc_entry',
      resource_id: 'entry-9',
      details: { attempt_id: 'attempt-1', scope: 'campaign' },
    });
    // The number the internal handler echoed back must never reach the audit row.
    expect(JSON.stringify(mocks.auditLog.mock.calls[0]![0])).not.toContain('+15551230001');
    await app.close();
  });

  it('omits resource_id when the internal handler\'s response carries no entry_id', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { attempt_id: 'attempt-1', dnc_recorded: true },
    });
    const app = await buildApp({ role: 'agent' });
    await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });

    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: AGENT_USER,
      action: 'dnc_entry.created',
      resource_type: 'dnc_entry',
      details: { attempt_id: 'attempt-1', scope: undefined },
    });
    await app.close();
  });

  it('records on_behalf on the tenant-wide escalation path', async () => {
    const app = await buildApp({ role: 'account_admin', userId: 'user-supervisor' });
    await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { reason: 'never call again', scope: 'tenant' },
    });

    expect(mocks.auditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-supervisor',
        details: { attempt_id: 'attempt-1', scope: 'tenant', on_behalf: true },
      }),
    );
    await app.close();
  });

  it('does NOT audit when the internal handler refuses the suppression (4xx)', async () => {
    mocks.proxyToCore.mockResolvedValue({
      status: 422,
      body: { error: 'Unprocessable', message: 'contact already suppressed elsewhere' },
    });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });

    expect(res.statusCode).toBe(422);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT audit when the internal handler fails the suppression (5xx)', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 500, body: { error: 'Internal' } });
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/attempts/attempt-1/dnc` });

    expect(res.statusCode).toBe(500);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('does NOT audit a request the tenant-scope gate itself refused (403, before the internal handler)', async () => {
    const app = await buildApp({ role: 'agent' });
    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/attempts/attempt-1/dnc`,
      payload: { scope: 'tenant' },
    });

    expect(res.statusCode).toBe(403);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

// decision Q8. The public API layer sent no actor on the session routes,
// so the internal handler's `requireOwnedSession` could not tell the session's agent from a colleague.
describe('Q8: session routes forward the authenticated actor', () => {
  it.each([
    ['station-token', {}, 'agent'],
    ['available', {}, 'agent'],
    ['break', { reason: 'lunch' }, 'agent'],
    ['break/cancel', {}, 'agent'],
    ['leave', {}, 'agent'],
    ['force-available', {}, 'account_admin'],
  ] as const)('POST /sessions/:id/%s sends the session user as agent_user_id', async (action, payload, role) => {
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { session_id: 'session-1' } });
    const app = await buildApp({ role: role as MembershipRole, userId: 'user-caller' });
    const res = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/session-1/${action}`, payload });
    expect(res.statusCode).toBe(200);
    const body = sentBody();
    expect(body['agent_user_id']).toBe('user-caller');
    // `on_behalf` exactly when the caller holds `agency.supervise`.
    expect(body['on_behalf']).toBe(role === 'account_admin' ? true : undefined);
    await app.close();
  });

  it('a client-supplied actor on break is overwritten by the session user', async () => {
    const app = await buildApp({ role: 'agent', userId: 'user-caller' });
    await app.inject({
      method: 'POST', url: `${PREFIX}/sessions/session-1/break`,
      payload: { reason: 'lunch', agent_user_id: 'user-colleague', on_behalf: true },
    });
    expect(sentBody()).toEqual({ reason: 'lunch', agent_user_id: 'user-caller' });
    await app.close();
  });
});
