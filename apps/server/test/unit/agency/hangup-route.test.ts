import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/hangup-route.test.ts@4850d1d9
 * (source 10 → ported 10). Harness changes only: the logger mock is re-pointed from
 * `src/utils/logger.js` to a partial `@magick-agency/observability` mock. Every other mock
 * path (`config`, `auth.middleware`, `feature-flags`, `agency.repository`) and every case is
 * verbatim. No case DELETED, MODIFIED or NEW. The `config` mock's VoBiz block is inert
 * here (nothing reads it) and is left as core had it.
 */

// ---------------------------------------------------------------------------
// MAG-112 — `POST /attempts/:id/hangup`.
//
// ── Why this file did not exist, which is the whole finding ─────────────────
//
// The route did not either. Master proxied to it and got a 404; cusui called it
// and swallowed the rejection; and the station socket's `hangup` control frame —
// the documented alternative — was read by neither of the two `message`
// listeners on that socket (`agency.routes.ts` acts only on `ping`,
// `webrtc-bridge-manager.ts` only on `media`). **An agent could not hang up by
// either advertised path**, and three comments described both as working.
//
// A comment is not evidence about the file it sits in. The route list is, so the
// first case here asserts against the router rather than against prose.
//
// ── What this file can and cannot prove ────────────────────────────────────
//
// The dialer is a double, so this proves the ROUTE's contract: that a hangup is
// issued for the right attempt, that ownership is enforced before it, and that
// the two "not live" cases are told apart. Whether `forceEndWithOutcome`
// actually tears the carrier leg down is the bridge's own subject, and whether
// the row reaches `ended` is the lifecycle listener's — neither is asserted by
// stubbing them here, which would be asserting my own belief against itself.
//
// FALSIFICATION recorded per group.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: (req: any) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: any) => req.headers['x-mgkvc-account'] ?? 'a1',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      findById: vi.fn(),
      recordDisposition: vi.fn(),
      saveNotes: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    campaign: { findById: vi.fn() },
    contact: {
      markState: vi.fn().mockResolvedValue(undefined),
      unclaim: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn(),
    },
    session: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(undefined), leave: vi.fn() },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';

/** The reserved agent's session, and the user id behind it. */
const SESSION = { id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1' };

function attemptRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'att-1', campaign_id: 'camp-1', contact_id: 'contact-1',
    tenant_id: 't1', account_id: 'a1', attempt_number: 1,
    webrtc_call_id: 'call-1', caller_id: '+14155550100',
    reserved_agent_id: 'sess-1', state: 'bridged', outcome: null,
    disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
    dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
    ended_at: null, talk_seconds: 42, wrapup_seconds: 30,
    created_at: new Date(), updated_at: new Date('2026-08-12T10:00:00.000Z'),
    ...patch,
  };
}

const hangupAttempt = vi.fn();

function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: vi.fn().mockResolvedValue({ state: 'on_call', attemptId: 'att-1', since: 1 }), set: vi.fn(), clear: vi.fn() },
    wrapup: { noteDisposition: vi.fn().mockResolvedValue(true), stateFor: vi.fn(() => null) },
    stations: { send: vi.fn(() => true), detach: vi.fn(), attach: vi.fn(), isLocallyOwned: vi.fn(() => true) },
    dialer: {
      hangupAttempt,
      hasLiveAttempt: vi.fn(() => false),
      // Arms the pre-bind grace for an unannounced dial. Reached SYNCHRONOUSLY from
      // the station socket's `close` handler, BEFORE it awaits anything — so a
      // double without it throws a TypeError inside that handler. Vitest still
      // reports every assertion as passing and exits NON-ZERO on the unhandled
      // error: a green-looking local run and a red CI job.
      noteStationClosed: vi.fn(),
      reattachStation: vi.fn(() => null),
      takeMissedRelease: vi.fn(() => null),
    },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint: vi.fn(), verifyAndConsume: vi.fn() },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };
}

let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const instance = Fastify();
  await instance.register((a) => agencyRoutes(a as never, makeRuntime() as never), {
    prefix: '/api/v1/agency',
  });
  await instance.ready();
  return instance;
}

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

async function hangup(payload: Record<string, unknown> = { agent_user_id: 'u-agent' }) {
  return app.inject({
    method: 'POST', url: '/api/v1/agency/attempts/att-1/hangup',
    headers: HEADERS, payload,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  repos.attempt.findById.mockResolvedValue(attemptRow());
  repos.campaign.findById.mockResolvedValue({ id: 'camp-1', disposition_catalog: [] });
  repos.session.findById.mockResolvedValue(SESSION);
  hangupAttempt.mockResolvedValue(true);
  app = await buildApp();
});

describe('the route exists at all', () => {
  it('is registered, and ends the attempt named in the path', async () => {
    // FALSIFIED by construction: before this ticket the same request returned
    // 404, which is what master's proxy had been getting all along.
    const res = await hangup();

    expect(res.statusCode).toBe(200);
    expect(hangupAttempt).toHaveBeenCalledWith('att-1');
  });

  it('appears in the router alongside the other two attempt-scoped actions', () => {
    // Enumerated from the router, not grepped for. The absence that caused this
    // ticket is invisible to a grep for a route that is not there, and
    // `app.post<{...}>(` defeats the obvious pattern anyway.
    const routes = app.printRoutes({ commonPrefix: false });
    for (const action of ['hangup', 'disposition', 'dnc', 'notes']) {
      expect(routes, `attempts/:id/${action}`).toContain(action);
    }
  });
});

describe('ownership — the check the contract promised and could not run', () => {
  it('refuses an unattributed hangup, and hangs nothing up', async () => {
    // Master proxied this route with **no body at all**, so `agent_user_id`
    // never arrived and the "is the reserved agent" rule could never be applied.
    const res = await hangup({});

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(hangupAttempt).not.toHaveBeenCalled();
  });

  it('refuses another agent, so one agent cannot end another agent\'s call', async () => {
    // Every agent holds `agency.attempts.handle`, so without this any tenant
    // member could have hung up any live conversation in the account.
    const res = await hangup({ agent_user_id: 'u-someone-else' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_your_attempt');
    expect(hangupAttempt).not.toHaveBeenCalled();
  });

  it('allows a supervisor who asserted on_behalf', async () => {
    // Master vouches for `agency.supervise`; core cannot evaluate master's RBAC,
    // which is exactly why the flag is trusted rather than inferred.
    const res = await hangup({ agent_user_id: 'u-supervisor', on_behalf: true });

    expect(res.statusCode).toBe(200);
    expect(hangupAttempt).toHaveBeenCalledWith('att-1');
  });

  it('404s an attempt in another account before it reveals anything about it', async () => {
    repos.attempt.findById.mockResolvedValue(attemptRow({ account_id: 'other' }));
    const res = await hangup();

    expect(res.statusCode).toBe(404);
    expect(hangupAttempt).not.toHaveBeenCalled();
  });
});

describe('the two ways an attempt can not be live', () => {
  it('is an idempotent success when the call already ended', async () => {
    // An agent's hangup routinely races the customer's. Erroring here would show
    // a failure for the thing that just happened, on the control whose whole job
    // is to end a call that is — by then — already over.
    hangupAttempt.mockResolvedValue(false);
    repos.attempt.findById.mockResolvedValue(
      attemptRow({ state: 'ended', outcome: 'remote_hangup' }),
    );

    const res = await hangup();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      attempt_id: 'att-1', campaign_id: 'camp-1', state: 'ended', outcome: 'remote_hangup',
    });
  });

  it('refuses by name when the row is live but core is not bridging it', async () => {
    // The bridging replica restarted. Returning 200 would tell the agent the
    // call was ended when nothing hung anything up — and they are the one person
    // who can hear that it is still open.
    hangupAttempt.mockResolvedValue(false);

    const res = await hangup();

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('attempt_not_live');
  });
});

describe('the response is an acknowledgement, not the terminal state', () => {
  it('reports the row as re-read after the hangup, not the row it started from', async () => {
    // The terminal write rides the bridge's `ended` lifecycle event, which
    // `emitLifecycle` does not await — so this is a re-read, and it is allowed to
    // still say `bridged`. The station socket's `released` frame is the console's
    // authority for "the call is over"; asserting the re-read is what stops that
    // from quietly becoming an echo of the pre-hangup row.
    repos.attempt.findById
      .mockResolvedValueOnce(attemptRow())
      .mockResolvedValueOnce(attemptRow({ state: 'ended', outcome: 'agent_hangup' }));

    const res = await hangup();

    expect(res.json()).toEqual({
      attempt_id: 'att-1', campaign_id: 'camp-1', state: 'ended', outcome: 'agent_hangup',
    });
  });

  it('falls back to the attempt it already had when the re-read fails', async () => {
    // A DB blip must not fail a hangup that succeeded — the call is down and the
    // agent needs to know that, not a 500.
    repos.attempt.findById
      .mockResolvedValueOnce(attemptRow())
      .mockRejectedValueOnce(new Error('connection terminated'));

    const res = await hangup();

    expect(res.statusCode).toBe(200);
    expect(res.json().state).toBe('bridged');
  });
});
