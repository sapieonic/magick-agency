import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool } from '../setup/test-utils.js';

/*
 * Only the private internal handler instance that `callCore` dispatches into is stubbed
 * (`setCoreHandlers` with a Fastify that answers as the internal handler would); `callCore`,
 * the route and the mask are production code, wired as `app.ts` wires them
 * (`setErrorHandler(agencyErrorHandler)` + `onSend` `errorMaskHook`).
 *
 * Every 4xx from the internal handler passes through unchanged; only 5xx is masked. So:
 *  - the six-field forward cases (5), the leave sentence, "an internal 5xx is masked on the
 *    same route", the public layer's own 400, and a 200 untouched;
 *  - the "unrecognised code" controls (join, leave, bare 409, the "Conflict" label) assert
 *    the body passes through unchanged: there is no allow-list, and the 5xx case is the control
 *    that the remaining branch still masks.
 */

/**
 * ─── `session_on_other_campaign` / `agent_on_live_call`, ON A REAL REQUEST ───
 *
 * `test/unit/api/middleware/error-mask.session-conflict.test.ts` calls
 * `errorMaskHook` directly with a hand-built reply object. That proves the hook's
 * policy and nothing about the pipeline the body actually travels: the route, the
 * `callCore` dispatch, the JSON round trip through Fastify's serializer, and the
 * `onSend` hook installed the way `app.ts` installs it. Every step in that chain is a
 * place a body can be reshaped, and a unit test that never runs one of them cannot see it.
 *
 * So the ONLY thing stubbed here is the internal handler instance, which answers as the
 * real handler would. Everything from the route inwards is production code, wired as
 * production wires it.
 *
 * ── The two properties, asserted separately because they fail differently ───
 *  1. the body is FORWARDED rather than masked;
 *  2. it is forwarded BYTE-IDENTICALLY rather than normalised down to the
 *     canonical `{ error, message, statusCode, requestId }`. A rebuild would keep
 *     the status, the code and even a `message` — the floor sentence names the
 *     campaign — while dropping `campaign_name` and `state`, the two facts the
 *     console reads to decide whether leaving the station is safe right now.
 *
 * ── And the control that makes both mean something ─────────────────────────
 * "The body came through" is also satisfied by a mask that has stopped masking,
 * which is a security regression rather than a fix. Every forwarding assertion is
 * therefore paired with the same body carrying an unrecognised code, on the same
 * app instance, shown to pass through unchanged (and the 5xx case shown to be masked).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '3f1b9c22-6d4e-4a11-9f23-9c1a77b0e401';
const AGENT = '55555555-5555-4555-8555-555555555555';
const SESSION = '77777777-7777-4777-8777-777777777777';

/** The `AgencySessionCampaignConflict` body — all six fields. */
const SESSION_CONFLICT = {
  error: 'Conflict',
  code: 'session_on_other_campaign',
  message:
    'You are still joined to "Q3 Renewals". Leave that station before joining '
    + 'another campaign — an agent can hold only one live station at a time.',
  campaign_id: CAMPAIGN,
  campaign_name: 'Q3 Renewals',
  state: 'on_call',
};

/** The refusal of a leave while the agent still has a live attempt. */
const LIVE_CALL_CONFLICT = {
  error: 'Conflict',
  code: 'agent_on_live_call',
  message: 'Finish or hang up your current call before leaving the station.',
};

const mocks = vi.hoisted(() => ({
  coreStatus: 409,
  coreBody: '' as string,
}));

vi.mock('@magick-agency/observability', async (importOriginal) => {
  const noop = () => {};
  return {
    ...(await importOriginal<typeof import('@magick-agency/observability')>()),
    createChildLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    logger: { info: noop, warn: noop, error: noop, debug: noop, child: () => ({ info: noop, warn: noop, error: noop, debug: noop }) },
  };
});

// No Firebase here. Everything else — RBAC, the proxy, the mask — is real.
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: { user?: { id: string } }) => {
    request.user = { id: AGENT };
  },
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: {
    tenantId?: string;
    accountId?: string;
    membership?: { role: string };
  }) => {
    request.tenantId = TENANT;
    request.accountId = '88888888-8888-4888-8888-888888888888';
    // A bare `agent`: the role that actually meets this refusal, and the one
    // that cannot set `on_behalf`.
    request.membership = { role: 'agent' };
  },
}));

const { proxyAgencyAgentRoutes } = await import(
  '../../../src/api/routes/proxy-agency-agent.routes.js'
);
const { errorMaskHook, MASKED_ERROR_MESSAGE } = await import(
  '../../../src/api/middleware/error-mask.middleware.js'
);
const { agencyErrorHandler } = await import('../../../src/api/middleware/agency-error-handler.js');
const { setCoreHandlers } = await import('../../../src/api/core-dispatch.js');

/** The private internal handler instance, answering as the real handler would. */
let core: FastifyInstance;

describe('an internal-handler 409 reaches the agent intact, through the real route and the real mask', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mocks.coreStatus = 409;
    mocks.coreBody = JSON.stringify(SESSION_CONFLICT);

    core = Fastify({ logger: false });
    core.all('/api/v1/*', async (_request, reply) =>
      reply.code(mocks.coreStatus).header('content-type', 'application/json').send(mocks.coreBody));
    await core.ready();
    setCoreHandlers(core);

    app = Fastify({ logger: false });
    // Exactly the wiring `app.ts` uses: the error handler and the mask as a single
    // global `onSend`.
    app.setErrorHandler(agencyErrorHandler);
    app.addHook('onSend', errorMaskHook);
    await app.register(proxyAgencyAgentRoutes, { prefix: '/proxy/agency' });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    setCoreHandlers(null);
    await core?.close();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  const join = () =>
    app.inject({
      method: 'POST',
      url: '/proxy/agency/sessions',
      payload: { campaign_id: CAMPAIGN },
    });

  const leave = () =>
    app.inject({ method: 'POST', url: `/proxy/agency/sessions/${SESSION}/leave` });

  const isMasked = (body: Record<string, unknown>) =>
    typeof body['message'] === 'string' && (body['message'] as string) === MASKED_ERROR_MESSAGE;

  // ══ session_on_other_campaign ══════════════════════════════════════════════

  describe('POST /sessions → session_on_other_campaign', () => {
    it('forwards the 409 with all six fields, byte-identically', async () => {
      const res = await join();

      expect(res.statusCode).toBe(409);
      // Byte-identity, not field equality: the mask's `!mask` branch returns the
      // payload REFERENCE unchanged, which is what makes an unknown field
      // added later survive too. A rebuild from a field list would pass a deep
      // comparison and fail this.
      expect(res.body).toBe(JSON.stringify(SESSION_CONFLICT));
      expect(isMasked(res.json())).toBe(false);
    });

    it('every one of the six fields arrives, asserted by name', async () => {
      const body = (await join()).json();

      expect(body.error).toBe('Conflict');
      expect(body.code).toBe('session_on_other_campaign');
      // `message` is the floor — written to stand on its own for a generic
      // handler that reads only that field.
      expect(body.message).toBe(SESSION_CONFLICT.message);
      // The two the console needs and a normalised body would lose: WHICH
      // station to leave, and whether leaving it is safe right now.
      expect(body.campaign_id).toBe(CAMPAIGN);
      expect(body.campaign_name).toBe('Q3 Renewals');
      expect(body.state).toBe('on_call');
    });

    it('adds nothing of its own — no statusCode, no requestId', async () => {
      // The canonical masked body carries both. Their ABSENCE is how a reader
      // tells a forwarded body from a rebuilt one that copied the right fields.
      const keys = Object.keys((await join()).json()).sort();
      expect(keys).toEqual(['campaign_id', 'campaign_name', 'code', 'error', 'message', 'state']);
    });

    it('an unknown field added later survives the hop', async () => {
      const extended = { ...SESSION_CONFLICT, joined_at: '2026-08-16T09:00:00.000Z' };
      mocks.coreBody = JSON.stringify(extended);

      const res = await join();

      expect(res.body).toBe(JSON.stringify(extended));
      expect(res.json().joined_at).toBe('2026-08-16T09:00:00.000Z');
    });

    it('does not rewrite the masking headers onto a forwarded body', async () => {
      // `content-length` in particular: the mask rewrites it for its own body,
      // and setting it for a body that was not rewritten is how a forwarded
      // response gets truncated.
      const res = await join();
      expect(Number(res.headers['content-length'])).toBe(
        Buffer.byteLength(JSON.stringify(SESSION_CONFLICT)),
      );
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ══ agent_on_live_call ════════════════════════════════════════════════════

  describe('POST /sessions/:id/leave → agent_on_live_call', () => {
    it('forwards the handler’s sentence, which is the entire remedy', async () => {
      // Unlike its sibling this body carries no extra fields, so the `message`
      // is all the agent gets. Masked, an agent who is ON A CALL is told to
      // contact support about a refusal they could clear in seconds.
      mocks.coreBody = JSON.stringify(LIVE_CALL_CONFLICT);

      const res = await leave();

      expect(res.statusCode).toBe(409);
      expect(res.body).toBe(JSON.stringify(LIVE_CALL_CONFLICT));
      expect(res.json().message).toBe(LIVE_CALL_CONFLICT.message);
      expect(isMasked(res.json())).toBe(false);
    });
  });

  // ══ The controls — the allow-list entry is load-bearing ═══════════════════

  describe('the same shape with an unrecognised code is NOT masked (every 4xx passes through)', () => {
    it('on the join route', async () => {
      // Without this the forwarding cases above would also pass against a mask
      // that had stopped masking altogether — which is a security
      // regression, not a fix. It also proves the entry is what rescues the
      // body: nothing else in this shape does (there is no `details`).
      mocks.coreBody = JSON.stringify({ ...SESSION_CONFLICT, code: 'session_on_some_other_thing' });

      const res = await join();

      // Passed through as written.
      expect(res.statusCode).toBe(409);
      expect(isMasked(res.json())).toBe(false);
      expect(res.body).toBe(mocks.coreBody);
    });

    it('on the leave route', async () => {
      mocks.coreBody = JSON.stringify({ ...LIVE_CALL_CONFLICT, code: 'agent_on_something_else' });

      const res = await leave();

      // Passed through as written.
      expect(res.statusCode).toBe(409);
      expect(isMasked(res.json())).toBe(false);
      expect(res.body).toBe(mocks.coreBody);
    });

    it('a bare { error, message } 409 from the internal handler passes through — every 4xx is first-party here', async () => {
      mocks.coreBody = JSON.stringify({ error: 'Conflict', message: 'upstream said no' });

      const res = await join();

      // The body comes from in-process code.
      expect(isMasked(res.json())).toBe(false);
      expect(res.body).toContain('upstream said no');
    });

    it('“Conflict” as a LABEL changes nothing — a 4xx passes either way', async () => {
      // Allow-listing the label would forward every internal 409 on all ~95 proxied
      // routes, which is the blanket widening the list exists to avoid. The two
      // cases above already depend on this; asserted here so a future "simpler"
      // fix that adds the label reds somewhere that says why.
      mocks.coreBody = JSON.stringify({ error: 'Conflict', message: 'provider detail leaks here' });
      // No label or code list exists; a 4xx
      // passes. The 5xx case below is the branch that still masks.
      expect(isMasked((await join()).json())).toBe(false);
    });

    it('an internal 5xx is masked on the same route', async () => {
      mocks.coreStatus = 500;
      mocks.coreBody = JSON.stringify({ error: 'Internal', message: 'stack trace shaped thing' });

      const res = await join();

      expect(res.statusCode).toBe(500);
      expect(isMasked(res.json())).toBe(true);
      expect(res.headers['x-request-id']).toBeTruthy();
    });
  });

  // ══ The seam the unit test cannot exercise ════════════════════════════════

  describe('the real dispatch is what tells the mask where the error came from', () => {
    it("the public layer's OWN 400 on the same route is passed through, not masked", async () => {
      // The other side of the classification: a validation error raised by the public
      // layer itself is passed through, which shows the two classes are
      // actually being told apart on a live request.
      const res = await app.inject({
        method: 'POST',
        url: '/proxy/agency/sessions',
        payload: { campaign_id: 'not-a-uuid' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Validation Error');
      expect(isMasked(res.json())).toBe(false);
    });

    it('a 200 from the internal handler is untouched', async () => {
      mocks.coreStatus = 200;
      mocks.coreBody = JSON.stringify({ session_id: SESSION, agent_state: 'idle' });

      const res = await join();

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ session_id: SESSION, agent_state: 'idle' });
    });
  });
});
